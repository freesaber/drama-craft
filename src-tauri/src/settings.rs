use crate::storage::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
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

impl Configuration {
    pub fn normalize(mut self) -> Result<Self> {
        if self.default_resolution.is_empty() {
            self.default_resolution = default_resolution();
        }
        if !matches!(
            self.default_resolution.as_str(),
            "480p横" | "480p竖" | "768p横" | "768p竖" | "480p(1:1)" | "768p(1:1)"
        ) {
            return Err(AppError::new("config", "默认分辨率不在接口支持范围内"));
        }
        if self.profiles.is_empty() {
            self.active_profile_id.clear();
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
            profile.base_url = profile.base_url.trim().trim_end_matches('/').to_owned();
            let url = reqwest::Url::parse(&profile.base_url)
                .map_err(|_| AppError::new("config", "API 服务地址无效"))?;
            if profile.name.is_empty()
                || !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(AppError::new(
                    "config",
                    "请填写配置名称和不含密钥、查询参数的 HTTP(S) 提交地址",
                ));
            }
        }
        if !ids.contains(&self.active_profile_id) {
            return Err(AppError::new("config", "请选择当前使用的 API 配置"));
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
                base_url: " https://example.test/ ".into(),
                has_authorization: true,
            }],
            active_profile_id: "legacy".into(),
            default_resolution: default_resolution(),
        }
    }
    #[test]
    fn normalizes_profiles_and_validates_selection() {
        let normalized = config().normalize().unwrap();
        assert_eq!(normalized.profiles[0].base_url, "https://example.test");
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
    fn rejects_credentials_in_portable_endpoint_metadata() {
        for url in [
            "file:///tmp/api",
            "https://user:secret@example.test",
            "https://example.test?key=secret",
        ] {
            let mut invalid = config();
            invalid.profiles[0].base_url = url.into();
            assert!(invalid.normalize().is_err());
        }
    }
}
