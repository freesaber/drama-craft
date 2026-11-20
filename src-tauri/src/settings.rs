use crate::storage::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

fn default_platform_type() -> String {
    "autodl".into()
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default = "default_platform_type")]
    pub platform_type: String,
    #[serde(default, alias = "baseUrl")]
    pub submit_url: String,
    #[serde(default)]
    pub query_url: String,
    #[serde(default)]
    pub resolutions: String,
    #[serde(default)]
    pub default_seed: String,
    #[serde(default)]
    pub has_authorization: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub profiles: Vec<ApiProfile>,
    pub active_profile_id: String,
    #[serde(default = "default_resolution")]
    pub default_resolution: String,
}

fn default_resolution() -> String {
    "480p横".into()
}

fn validate_http_url(raw: &str, label: &str) -> Result<reqwest::Url> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| AppError::new("config", format!("{label}无效")))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new(
            "config",
            format!("请填写不含密钥、查询参数的 HTTP(S) {label}"),
        ));
    }
    Ok(url)
}

fn parse_resolutions_json(raw: &str) -> Result<Vec<String>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("config", "请填写 resolution JSON 列表"));
    }
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|_| AppError::new("config", "resolution 须为 JSON 字符串数组"))?;
    let Some(items) = value.as_array() else {
        return Err(AppError::new("config", "resolution 须为 JSON 字符串数组"));
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let Some(text) = item.as_str().map(str::trim).filter(|v| !v.is_empty()) else {
            return Err(AppError::new(
                "config",
                "resolution 列表每一项须为非空字符串",
            ));
        };
        if seen.insert(text.to_owned()) {
            out.push(text.to_owned());
        }
    }
    if out.is_empty() {
        return Err(AppError::new("config", "resolution 列表不能为空"));
    }
    Ok(out)
}

fn migrate_legacy_endpoints(profile: &mut ApiProfile) {
    if profile.platform_type.trim().is_empty() {
        profile.platform_type = default_platform_type();
    }
    if profile.query_url.trim().is_empty() && !profile.submit_url.trim().is_empty() {
        if let Ok(url) = reqwest::Url::parse(profile.submit_url.trim()) {
            profile.query_url = format!(
                "{}/api/v1/comfyui/comfyui_workflow/result/{{task_id}}",
                url.origin().ascii_serialization()
            );
        }
    }
    if profile.resolutions.trim().is_empty() && !profile.submit_url.trim().is_empty() {
        let h3_803 = profile.submit_url.contains("minimax_h3_803");
        let resolutions = if h3_803 {
            serde_json::json!([
                "480p竖(480*864)",
                "768p竖(768*1376)",
                "1088p竖(1088*1920)",
                "1440p竖(1440*2560)",
                "480p横(864*480)",
                "768p横(1376*768)",
                "1088p横(1920*1088)",
                "1440p横(2560*1440)"
            ])
        } else {
            serde_json::json!(["480p横", "480p竖", "768p横", "768p竖", "960p横", "960p竖"])
        };
        profile.resolutions = serde_json::to_string_pretty(&resolutions).unwrap_or_default();
        if profile.default_seed.trim().is_empty() {
            let seed = if h3_803 {
                "803"
            } else if profile.submit_url.contains("minimax_h3_zm_u24") {
                "683072603085674"
            } else if profile
                .submit_url
                .contains("minimax_h3_image_audio_to_video_v2_15s")
            {
                "731242627237534"
            } else {
                "548628410878779"
            };
            profile.default_seed = seed.into();
        }
    }
}

impl Configuration {
    pub fn normalize(mut self) -> Result<Self> {
        if self.profiles.is_empty() {
            self.active_profile_id.clear();
            if self.default_resolution.is_empty() {
                self.default_resolution = default_resolution();
            }
            return Ok(self);
        }
        let mut ids = HashSet::new();
        for profile in &mut self.profiles {
            if profile.id != "legacy" && uuid::Uuid::parse_str(&profile.id).is_err() {
                return Err(AppError::new("config", "API 配置标识无效"));
            }
            if !ids.insert(profile.id.clone()) {
                return Err(AppError::new("config", "API 配置标识重复"));
            }
            profile.name = profile.name.trim().to_owned();
            profile.platform_type = profile.platform_type.trim().to_ascii_lowercase();
            if profile.platform_type.is_empty() {
                profile.platform_type = default_platform_type();
            }
            if profile.platform_type != "autodl" {
                return Err(AppError::new(
                    "config",
                    "暂不支持的 API 类型，当前仅支持 AutoDL",
                ));
            }
            migrate_legacy_endpoints(profile);
            profile.submit_url = profile.submit_url.trim().trim_end_matches('/').to_owned();
            profile.query_url = profile.query_url.trim().to_owned();
            profile.default_seed = profile.default_seed.trim().to_owned();
            validate_http_url(&profile.submit_url, "提交任务地址")?;
            let query = validate_http_url(
                &profile.query_url.replace("{task_id}", "task-id"),
                "查询任务地址",
            )?;
            if !profile.query_url.contains("{task_id}") && query.path().trim_matches('/').is_empty()
            {
                return Err(AppError::new(
                    "config",
                    "查询任务地址须包含 {task_id}，或指向可追加 task_id 的路径",
                ));
            }
            let resolutions = parse_resolutions_json(&profile.resolutions)?;
            profile.resolutions = serde_json::to_string(&resolutions).unwrap_or_default();
            if profile.name.is_empty() {
                return Err(AppError::new("config", "请填写配置名称"));
            }
            if !profile.default_seed.is_empty() && profile.default_seed.parse::<i64>().is_err() {
                return Err(AppError::new("config", "默认 seed 须为整数，或留空"));
            }
        }
        if !ids.contains(&self.active_profile_id) {
            return Err(AppError::new("config", "请选择当前使用的 API 配置"));
        }
        if let Some(active) = self
            .profiles
            .iter()
            .find(|profile| profile.id == self.active_profile_id)
        {
            if let Ok(items) = parse_resolutions_json(&active.resolutions) {
                if self.default_resolution.is_empty()
                    || !items.iter().any(|item| item == &self.default_resolution)
                {
                    self.default_resolution = items[0].clone();
                }
            }
        } else if self.default_resolution.is_empty() {
            self.default_resolution = default_resolution();
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> Configuration {
        Configuration {
            profiles: vec![ApiProfile {
                id: "legacy".into(),
                name: " Default ".into(),
                platform_type: "autodl".into(),
                submit_url: " https://example.test/api/submit ".into(),
                query_url: "https://example.test/api/result/{task_id}".into(),
                resolutions: r#"["480p横(864*480)","768p横(1376*768)"]"#.into(),
                default_seed: "123".into(),
                has_authorization: true,
            }],
            active_profile_id: "legacy".into(),
            default_resolution: default_resolution(),
        }
    }

    #[test]
    fn normalizes_profiles_and_validates_selection() {
        let normalized = config().normalize().unwrap();
        assert_eq!(
            normalized.profiles[0].submit_url,
            "https://example.test/api/submit"
        );
        assert_eq!(normalized.profiles[0].name, "Default");
        let mut invalid = config();
        invalid.active_profile_id = "missing".into();
        assert!(invalid.normalize().is_err());
        let mut duplicate = config();
        duplicate.profiles.push(duplicate.profiles[0].clone());
        assert!(duplicate.normalize().is_err());

        let empty = Configuration {
            profiles: Vec::new(),
            active_profile_id: "deleted-profile".into(),
            default_resolution: default_resolution(),
        }
        .normalize()
        .unwrap();
        assert_eq!(empty.active_profile_id, "");
    }

    #[test]
    fn migrates_legacy_base_url_profiles() {
        let legacy = Configuration {
            profiles: vec![ApiProfile {
                id: "legacy".into(),
                name: "旧配置".into(),
                platform_type: String::new(),
                submit_url: "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u30"
                    .into(),
                query_url: String::new(),
                resolutions: String::new(),
                default_seed: String::new(),
                has_authorization: false,
            }],
            active_profile_id: "legacy".into(),
            default_resolution: String::new(),
        }
        .normalize()
        .unwrap();
        let profile = &legacy.profiles[0];
        assert_eq!(profile.platform_type, "autodl");
        assert!(profile.query_url.contains("{task_id}"));
        assert!(profile.resolutions.contains("960p横"));
        assert_eq!(profile.default_seed, "548628410878779");
    }

    #[test]
    fn migrates_standard_h3_workflows_with_their_own_seeds() {
        for (workflow, seed) in [
            ("minimax_h3_zm_u30", "548628410878779"),
            ("minimax_h3_zm_u24", "683072603085674"),
            ("minimax_h3_image_audio_to_video_v2_15s", "731242627237534"),
        ] {
            let mut legacy = config();
            let profile = &mut legacy.profiles[0];
            profile.submit_url =
                format!("https://autodl.art/api/v1/comfyui/comfyui_workflow/{workflow}");
            profile.resolutions.clear();
            profile.default_seed.clear();
            let normalized = legacy.normalize().unwrap();
            let profile = &normalized.profiles[0];
            assert_eq!(
                parse_resolutions_json(&profile.resolutions).unwrap(),
                vec!["480p横", "480p竖", "768p横", "768p竖", "960p横", "960p竖"]
            );
            assert_eq!(profile.default_seed, seed, "{workflow}");
        }
    }

    #[test]
    fn migrates_h3_803_without_overwriting_custom_values() {
        let mut legacy = config();
        let profile = &mut legacy.profiles[0];
        profile.submit_url =
            "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_803".into();
        profile.query_url.clear();
        profile.resolutions.clear();
        profile.default_seed.clear();
        let mut normalized = legacy.normalize().unwrap();
        let profile = &normalized.profiles[0];
        assert_eq!(profile.default_seed, "803");
        assert_eq!(
            parse_resolutions_json(&profile.resolutions).unwrap(),
            vec![
                "480p竖(480*864)",
                "768p竖(768*1376)",
                "1088p竖(1088*1920)",
                "1440p竖(1440*2560)",
                "480p横(864*480)",
                "768p横(1376*768)",
                "1088p横(1920*1088)",
                "1440p横(2560*1440)",
            ]
        );
        assert_eq!(
            profile.query_url,
            "https://autodl.art/api/v1/comfyui/comfyui_workflow/result/{task_id}"
        );
        normalized.profiles[0].default_seed = "42".into();
        normalized.profiles[0].resolutions = r#"["768p横(1376*768)"]"#.into();
        let custom = normalized.normalize().unwrap();
        assert_eq!(custom.profiles[0].default_seed, "42");
        assert_eq!(custom.profiles[0].resolutions, r#"["768p横(1376*768)"]"#);
    }

    #[test]
    fn rejects_credentials_in_portable_endpoint_metadata() {
        for url in [
            "file:///tmp/api",
            "https://user:secret@example.test",
            "https://example.test?key=secret",
        ] {
            let mut invalid = config();
            invalid.profiles[0].submit_url = url.into();
            assert!(invalid.normalize().is_err());
        }
    }
}
