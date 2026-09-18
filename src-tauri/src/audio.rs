use crate::generation;
use crate::storage::{self, AppError, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Local, SecondsFormat};
use reqwest::{header, Client};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub profiles: Vec<ApiProfile>,
    pub active_profile_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfile {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub platform_type: String,
    pub submit_url: String,
    pub query_url: String,
    #[serde(default)]
    pub has_authorization: bool,
}

impl Configuration {
    pub fn normalize(mut self) -> Result<Self> {
        let mut ids = std::collections::HashSet::new();
        for profile in &mut self.profiles {
            profile.id = profile.id.trim().to_owned();
            profile.name = profile.name.trim().to_owned();
            profile.submit_url = profile.submit_url.trim().to_owned();
            profile.query_url = profile.query_url.trim().to_owned();
            profile.platform_type = profile.platform_type.trim().to_ascii_lowercase();
            if uuid::Uuid::parse_str(&profile.id).is_err() {
                return Err(AppError::new("config", "音频 API 配置标识无效"));
            }
            if profile.id.is_empty() || !ids.insert(profile.id.clone()) {
                return Err(AppError::new("config", "音频 API 配置 ID 缺失或重复"));
            }
            if profile.name.is_empty()
                || profile.submit_url.is_empty()
                || profile.query_url.is_empty()
            {
                return Err(AppError::new("config", "音频 API 配置内容不完整"));
            }
            if profile.platform_type != "autodl" {
                return Err(AppError::new(
                    "config",
                    "暂不支持的音频 API 类型，当前仅支持 AutoDL",
                ));
            }
            parse_http_url(&profile.submit_url)?;
            let probe = profile.query_url.replace("{task_id}", "probe");
            parse_http_url(&probe)?;
            profile.has_authorization = false;
        }
        if self.profiles.is_empty() {
            self.active_profile_id.clear();
        } else if !self
            .profiles
            .iter()
            .any(|item| item.id == self.active_profile_id)
        {
            return Err(AppError::new("config", "请选择有效的音频 API 配置"));
        }
        Ok(self)
    }
}

#[derive(Clone)]
pub struct AudioSettings {
    pub profile_id: String,
    pub submit_url: String,
    pub query_url: String,
    pub authorization: String,
}

#[derive(Clone)]
pub struct AudioInput {
    pub document: String,
    pub character_id: String,
    pub character_name: String,
    pub text: String,
    pub voice_ref: String,
    pub options: AudioOptions,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct AudioOptions {
    pub control_method: String,
    pub random: bool,
    pub sad: f64,
    pub calm: f64,
    pub angry: f64,
    pub happy: f64,
    pub afraid: f64,
    pub disgusted: f64,
    pub melancholic: f64,
}

impl Default for AudioOptions {
    fn default() -> Self {
        Self {
            control_method: "与音色参考音频相同".into(),
            random: false,
            sad: 0.0,
            calm: 0.3,
            angry: 0.0,
            happy: 0.5,
            afraid: 0.0,
            disgusted: 0.0,
            melancholic: 0.0,
        }
    }
}

impl AudioOptions {
    pub fn validate(&self) -> Result<()> {
        if !matches!(
            self.control_method.as_str(),
            "与音色参考音频相同" | "使用情感参考音频" | "使用情感向量控制"
        ) {
            return Err(AppError::new("input", "不支持的情绪控制方式"));
        }
        for value in [
            self.sad,
            self.calm,
            self.angry,
            self.happy,
            self.afraid,
            self.disgusted,
            self.melancholic,
        ] {
            if !value.is_finite() || !(0.0..=1.4).contains(&value) {
                return Err(AppError::new("input", "情绪参数须在 0—1.4 之间"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRecord {
    pub task_id: String,
    pub status: String,
    pub local_file: Option<String>,
    pub error: Option<String>,
}

fn parse_http_url(raw: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|_| AppError::new("config", "请填写有效的音频 API 地址"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::new(
            "config",
            "请填写不含密钥、查询参数的 HTTP(S) 音频 API 地址",
        ));
    }
    Ok(url)
}

fn result_endpoint(settings: &AudioSettings, task_id: &str) -> Result<String> {
    let template = settings.query_url.trim();
    let value = if template.contains("{task_id}") {
        template.replace("{task_id}", task_id)
    } else {
        format!("{}/{}", template.trim_end_matches('/'), task_id)
    };
    parse_http_url(&value)?;
    Ok(value)
}

fn client(settings: &AudioSettings) -> Result<Client> {
    let mut headers = header::HeaderMap::new();
    if !settings.authorization.trim().is_empty() {
        headers.insert(
            header::AUTHORIZATION,
            header::HeaderValue::from_str(settings.authorization.trim())
                .map_err(|_| AppError::new("config", "Authorization 内容无效"))?,
        );
    }
    Client::builder()
        .default_headers(headers)
        .no_proxy()
        .build()
        .map_err(|e| AppError::new("network", e.to_string()))
}

async fn envelope(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| AppError::new("network", e.to_string()))?;
    if !status.is_success() {
        return Err(AppError::new("api", format!("API 返回 {status}：{text}")));
    }
    let value: Value = serde_json::from_str(&text)
        .map_err(|_| AppError::new("api", format!("API 返回内容不是 JSON：{text}")))?;
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !code.is_empty() && !code.eq_ignore_ascii_case("success") {
        return Err(AppError::new(
            "api",
            value.get("msg").and_then(Value::as_str).unwrap_or(code),
        ));
    }
    Ok(value)
}

fn audio_data(root: &Path, document: &str, reference: &str) -> Result<String> {
    if reference.starts_with("http://") || reference.starts_with("https://") {
        return Ok(reference.to_owned());
    }
    let media = storage::resolve_media(root, document, reference)?;
    let path = media
        .path
        .ok_or_else(|| AppError::new("media", format!("音色参考不存在：{reference}")))?;
    let path = Path::new(&path);
    let mime = match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        _ => {
            return Err(AppError::new(
                "media",
                "音色参考须为 mp3、wav、flac、ogg 或 m4a",
            ))
        }
    };
    Ok(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(fs::read(path)?)
    ))
}

fn ensure_table(root: &Path) -> Result<()> {
    generation::open_database(root)?
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS audio_generations (
           task_id TEXT PRIMARY KEY,
           document TEXT NOT NULL,
           character_id TEXT NOT NULL,
           character_name TEXT NOT NULL,
           status TEXT NOT NULL,
           remote_url TEXT,
           local_file TEXT,
           error TEXT,
           profile_id TEXT NOT NULL,
           submit_url TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );",
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    Ok(())
}

fn get(root: &Path, task_id: &str) -> Result<AudioRecord> {
    ensure_table(root)?;
    generation::open_database(root)?
        .query_row(
            "SELECT task_id, status, local_file, error FROM audio_generations WHERE task_id = ?1",
            [task_id],
            |row| {
                Ok(AudioRecord {
                    task_id: row.get(0)?,
                    status: row.get(1)?,
                    local_file: row.get(2)?,
                    error: row.get(3)?,
                })
            },
        )
        .map_err(|e| AppError::new("database", e.to_string()))
}

pub fn task_provider(root: &Path, task_id: &str) -> Result<Option<(String, String)>> {
    ensure_table(root)?;
    generation::open_database(root)?
        .query_row(
            "SELECT profile_id, submit_url FROM audio_generations WHERE task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| AppError::new("database", e.to_string()))
}

fn result_url(data: &Value) -> Option<String> {
    data.get("results")?
        .as_array()?
        .iter()
        .find(|item| {
            item.get("type").and_then(Value::as_str) == Some("audio")
                || matches!(
                    item.get("file_type").and_then(Value::as_str),
                    Some("wav" | "mp3" | "flac" | "m4a" | "ogg")
                )
        })?
        .get("url")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn safe_name(value: &str) -> String {
    let name: String = value
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = name.trim().trim_end_matches(['.', ' ']);
    if trimmed.is_empty() {
        "角色".into()
    } else {
        trimmed.to_owned()
    }
}

fn audio_stem(document: &Path, character_name: &str, timestamp: &str) -> String {
    let stem = document
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let number: String = stem
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let episode = if number.is_empty() {
        "00".into()
    } else {
        format!("{number:0>2}")
    };
    format!("{episode}_{}_{timestamp}", safe_name(character_name))
}

fn request_body(text: &str, voice: &str, options: &AudioOptions) -> Value {
    json!({
        "emo_sad": options.sad, "emo_calm": options.calm,
        "emo_angry": options.angry, "emo_happy": options.happy,
        "emo_afraid": options.afraid, "emo_random": options.random,
        "prompt_text": text, "emo_disgusted": options.disgusted,
        "emo_ref_audio": voice, "emo_surprised": "0",
        "prompt_simple": voice, "emo_melancholic": options.melancholic,
        "emo_control_method": options.control_method
    })
}

async fn download(
    root: &Path,
    settings: &AudioSettings,
    task_id: &str,
    document: &str,
    character_name: &str,
    url: &str,
    extension: &str,
) -> Result<String> {
    let document_path = storage::document_path(root, document, true)?;
    let parent = document_path
        .parent()
        .ok_or_else(|| AppError::new("path", "文档缺少父目录"))?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S");
    let base = audio_stem(&document_path, character_name, &timestamp.to_string());
    let mut response = client(settings)?
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::new("network", e.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "download",
            format!("音频下载失败：{}", response.status()),
        ));
    }
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| AppError::new("download", e.to_string()))?
    {
        temp.write_all(&chunk)?;
    }
    temp.as_file().sync_all()?;
    let suffix = &task_id[..8.min(task_id.len())];
    for collision in 0_u32.. {
        let filename = if collision == 0 {
            format!("{base}.{extension}")
        } else {
            format!("{base}_{suffix}_{collision}.{extension}")
        };
        match temp.persist_noclobber(parent.join(&filename)) {
            Ok(_) => return Ok(filename),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temp = error.file
            }
            Err(error) => return Err(AppError::from(error.error)),
        }
    }
    unreachable!()
}

pub async fn submit(
    root: &Path,
    settings: &AudioSettings,
    input: AudioInput,
) -> Result<AudioRecord> {
    if input.text.trim().is_empty() || input.text.chars().count() > 2048 {
        return Err(AppError::new("input", "角色台词须为 1—2048 个字符"));
    }
    if input.voice_ref.trim().is_empty() {
        return Err(AppError::new("input", "角色没有绑定音色参考"));
    }
    input.options.validate()?;
    parse_http_url(&settings.submit_url)?;
    let voice = audio_data(root, &input.document, &input.voice_ref)?;
    let body = request_body(&input.text, &voice, &input.options);
    let value = envelope(
        client(settings)?
            .post(settings.submit_url.trim())
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::new("network", e.to_string()))?,
    )
    .await?;
    let data = value.get("data").unwrap_or(&value);
    let task_id = data
        .get("task_id")
        .or_else(|| data.get("taskId"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::new("api", "提交成功，但返回内容缺少 task_id"))?
        .to_owned();
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("submitted")
        .to_owned();
    let remote_url = result_url(data);
    ensure_table(root)?;
    let stamp = Local::now().to_rfc3339_opts(SecondsFormat::Secs, false);
    generation::open_database(root)?.execute(
        "INSERT OR REPLACE INTO audio_generations (task_id, document, character_id, character_name, status, remote_url, profile_id, submit_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![task_id, input.document, input.character_id, input.character_name, status, remote_url, settings.profile_id, settings.submit_url, stamp],
    ).map_err(|e| AppError::new("database", e.to_string()))?;
    if matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "success" | "succeeded"
    ) {
        return poll(root, settings, &task_id).await;
    }
    get(root, &task_id)
}

pub async fn poll(root: &Path, settings: &AudioSettings, task_id: &str) -> Result<AudioRecord> {
    let existing = get(root, task_id)?;
    if existing.status == "completed" && existing.local_file.is_some() {
        return Ok(existing);
    }
    let connection = generation::open_database(root)?;
    let (document, character_name): (String, String) = connection
        .query_row(
            "SELECT document, character_name FROM audio_generations WHERE task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    drop(connection);
    let value = envelope(
        client(settings)?
            .get(result_endpoint(settings, task_id)?)
            .send()
            .await
            .map_err(|e| AppError::new("network", e.to_string()))?,
    )
    .await?;
    let data = value.get("data").unwrap_or(&value);
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("processing");
    let completed = matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "success" | "succeeded"
    );
    let failed = matches!(
        status.to_ascii_lowercase().as_str(),
        "failed" | "error" | "cancelled"
    );
    let remote_url = result_url(data);
    let extension = data
        .get("results")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("url").and_then(Value::as_str) == remote_url.as_deref())
        })
        .and_then(|item| item.get("file_type"))
        .and_then(Value::as_str)
        .unwrap_or("wav")
        .to_ascii_lowercase();
    let extension = match extension.as_str() {
        "wav" | "mp3" | "flac" | "m4a" | "ogg" => extension.as_str(),
        _ => "wav",
    };
    let mut local_file = existing.local_file;
    let mut error = if failed {
        Some(
            value
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("音频生成失败")
                .to_owned(),
        )
    } else {
        None
    };
    if completed && local_file.is_none() {
        match remote_url.as_deref() {
            Some(url) => match download(
                root,
                settings,
                task_id,
                &document,
                &character_name,
                url,
                extension,
            )
            .await
            {
                Ok(file) => local_file = Some(file),
                Err(reason) => error = Some(reason.message),
            },
            None => error = Some("任务已完成，但结果中没有音频地址".into()),
        }
    }
    let stored_status = if completed && local_file.is_none() {
        "download_failed"
    } else {
        status
    };
    generation::open_database(root)?.execute("UPDATE audio_generations SET status = ?2, remote_url = ?3, local_file = ?4, error = ?5, updated_at = ?6 WHERE task_id = ?1", params![task_id, stored_status, remote_url, local_file, error, Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)]).map_err(|e| AppError::new("database", e.to_string()))?;
    get(root, task_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        net::{TcpListener, TcpStream},
        thread,
    };

    fn request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(split) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..split + 4]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                if bytes.len() >= split + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8(bytes).unwrap()
    }

    fn respond(stream: &mut TcpStream, content_type: &str, body: &[u8]) {
        write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
        stream.write_all(body).unwrap();
    }

    #[test]
    fn request_matches_indextts2_contract() {
        let body = request_body(
            "你好",
            "https://example.test/voice.wav",
            &AudioOptions::default(),
        );
        assert_eq!(body["prompt_text"], "你好");
        assert_eq!(body["prompt_simple"], "https://example.test/voice.wav");
        assert_eq!(body["emo_ref_audio"], "https://example.test/voice.wav");
        assert_eq!(body["emo_control_method"], "与音色参考音频相同");
        assert_eq!(body["emo_calm"], 0.3);
        assert_eq!(body["emo_happy"], 0.5);
        assert_eq!(body["emo_surprised"], "0");
    }

    #[test]
    fn configurable_emotions_are_serialized_and_validated() {
        let options = AudioOptions {
            control_method: "使用情感向量控制".into(),
            random: true,
            happy: 1.4,
            angry: 0.7,
            ..AudioOptions::default()
        };
        options.validate().unwrap();
        let body = request_body("测试", "voice", &options);
        assert_eq!(body["emo_control_method"], "使用情感向量控制");
        assert_eq!(body["emo_random"], true);
        assert_eq!(body["emo_happy"], 1.4);
        assert_eq!(body["emo_angry"], 0.7);

        let invalid = AudioOptions {
            happy: 1.5,
            ..AudioOptions::default()
        };
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn audio_name_uses_episode_character_and_timestamp() {
        assert_eq!(
            audio_stem(Path::new("002 终焉.md"), "林/小北", "20260918-120000"),
            "002_林_小北_20260918-120000"
        );
    }

    #[test]
    fn configuration_rejects_credentials_in_portable_urls() {
        let id = uuid::Uuid::new_v4().to_string();
        let config = Configuration {
            active_profile_id: id.clone(),
            profiles: vec![ApiProfile {
                id,
                name: "音频".into(),
                platform_type: "autodl".into(),
                submit_url: "https://token@example.test/submit".into(),
                query_url: "https://example.test/result/{task_id}".into(),
                has_authorization: false,
            }],
        };
        assert!(config.normalize().is_err());
    }

    #[test]
    fn submits_polls_and_downloads_character_audio() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut submit_stream, _) = listener.accept().unwrap();
            let submitted = request(&mut submit_stream);
            assert!(submitted.starts_with("POST /submit "));
            assert!(submitted
                .to_ascii_lowercase()
                .contains("authorization: token audio"));
            let body: Value =
                serde_json::from_str(submitted.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body["prompt_text"], "第一句。\n第二句。");
            assert!(body["prompt_simple"]
                .as_str()
                .unwrap()
                .starts_with("data:audio/wav;base64,"));
            respond(
                &mut submit_stream,
                "application/json",
                br#"{"code":"Success","data":{"task_id":"audio-1","status":"queued"}}"#,
            );

            let (mut poll_stream, _) = listener.accept().unwrap();
            assert!(request(&mut poll_stream).starts_with("GET /result/audio-1 "));
            let body = format!("{{\"code\":\"Success\",\"data\":{{\"status\":\"completed\",\"results\":[{{\"url\":\"http://{address}/result.wav\",\"type\":\"audio\",\"file_type\":\"wav\"}}]}}}}");
            respond(&mut poll_stream, "application/json", body.as_bytes());

            let (mut audio_stream, _) = listener.accept().unwrap();
            assert!(request(&mut audio_stream).starts_with("GET /result.wav "));
            respond(&mut audio_stream, "audio/wav", b"synthetic-wav");
        });

        let project = tempfile::tempdir().unwrap();
        let root = storage::canonical_directory(project.path()).unwrap();
        storage::create_document(&root, "02 测试.md", "# 测试\n").unwrap();
        fs::write(root.join("秦墨.wav"), b"voice").unwrap();
        let settings = AudioSettings {
            profile_id: "fixture".into(),
            submit_url: format!("http://{address}/submit"),
            query_url: format!("http://{address}/result/{{task_id}}"),
            authorization: "Token audio".into(),
        };
        let submitted = tauri::async_runtime::block_on(submit(
            &root,
            &settings,
            AudioInput {
                document: "02 测试.md".into(),
                character_id: "C001".into(),
                character_name: "秦墨".into(),
                text: "第一句。\n第二句。".into(),
                voice_ref: "秦墨.wav".into(),
                options: AudioOptions::default(),
            },
        ))
        .unwrap();
        assert_eq!(submitted.status, "queued");
        let completed = tauri::async_runtime::block_on(poll(&root, &settings, "audio-1")).unwrap();
        assert_eq!(completed.status, "completed");
        let file = completed.local_file.unwrap();
        assert!(file.starts_with("02_秦墨_"), "{file}");
        assert!(file.ends_with(".wav"), "{file}");
        assert_eq!(fs::read(root.join(file)).unwrap(), b"synthetic-wav");
        server.join().unwrap();
    }
}
