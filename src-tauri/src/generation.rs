use crate::storage::{self, AppError, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Local, SecondsFormat};
use reqwest::{header, Client};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const DATABASE_NAME: &str = "generations.sqlite3";
const AUDIO_REQUIRED_WORKFLOW: &str = "minimax_h3_z0903";
const AUDIO_OPTIONAL_WORKFLOW: &str = "minimax_h3_z0902";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationSettings {
    pub profile_id: String,
    pub submit_url: String,
    pub query_url: String,
    pub resolutions: Vec<String>,
    pub authorization: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationInput {
    pub document: String,
    pub shot_id: String,
    pub prompt: String,
    pub duration: u8,
    pub resolution: String,
    pub seed: Option<i64>,
    pub image_refs: Vec<String>,
    pub audio_refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRecord {
    pub task_id: String,
    pub document: String,
    pub shot_id: String,
    pub status: String,
    pub prompt: String,
    pub duration: u8,
    pub resolution: String,
    pub seed: Option<i64>,
    pub remote_url: Option<String>,
    pub local_file: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn open_database(root: &Path) -> Result<Connection> {
    let dir = root.join(".drama-craft");
    fs::create_dir_all(&dir)?;
    let connection = Connection::open(dir.join(DATABASE_NAME))
        .map_err(|e| AppError::new("database", e.to_string()))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS generations (
               task_id TEXT PRIMARY KEY,
               document TEXT NOT NULL,
               shot_id TEXT NOT NULL,
               status TEXT NOT NULL,
               prompt TEXT NOT NULL,
               duration INTEGER NOT NULL,
               resolution TEXT NOT NULL,
               seed INTEGER,
               image_refs TEXT NOT NULL,
               audio_refs TEXT NOT NULL,
               remote_url TEXT,
               local_file TEXT,
               error TEXT,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS generation_shot_history
               ON generations(document, shot_id, created_at DESC);
             CREATE TABLE IF NOT EXISTS generation_providers (
               task_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, base_url TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS batch_jobs (
               job_id TEXT PRIMARY KEY,
               job_type TEXT NOT NULL,
               name TEXT NOT NULL,
               document TEXT NOT NULL,
               status TEXT NOT NULL,
               scheduled_at TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS batch_jobs_updated
               ON batch_jobs(updated_at DESC);
             CREATE TABLE IF NOT EXISTS batch_job_items (
               item_id TEXT PRIMARY KEY,
               job_id TEXT NOT NULL,
               shot_id TEXT NOT NULL,
               shot_title TEXT NOT NULL,
               status TEXT NOT NULL,
               prompt TEXT NOT NULL,
               duration INTEGER NOT NULL,
               resolution TEXT NOT NULL,
               seed INTEGER,
               image_refs TEXT NOT NULL,
               audio_refs TEXT NOT NULL,
               generation_task_id TEXT,
               submitted_at TEXT,
               local_file TEXT,
               error TEXT,
               sort_order INTEGER NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS batch_job_items_job
               ON batch_job_items(job_id, sort_order);",
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let _ = connection.execute("ALTER TABLE batch_jobs ADD COLUMN result_file TEXT", []);
    let _ = connection.execute("ALTER TABLE batch_job_items ADD COLUMN submitted_at TEXT", []);
    Ok(connection)
}

fn database(root: &Path) -> Result<Connection> {
    open_database(root)
}

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GenerationRecord> {
    Ok(GenerationRecord {
        task_id: row.get(0)?,
        document: row.get(1)?,
        shot_id: row.get(2)?,
        status: row.get(3)?,
        prompt: row.get(4)?,
        duration: row.get(5)?,
        resolution: row.get(6)?,
        seed: row.get(7)?,
        remote_url: row.get(8)?,
        local_file: row.get(9)?,
        error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

pub fn task_provider(root: &Path, task_id: &str) -> Result<Option<(String, String)>> {
    use rusqlite::OptionalExtension;
    database(root)?
        .query_row(
            "SELECT profile_id, base_url FROM generation_providers WHERE task_id = ?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|e| AppError::new("database", e.to_string()))
}

pub fn history(root: &Path, document: &str, shot_id: &str) -> Result<Vec<GenerationRecord>> {
    if !root.join(".drama-craft").join(DATABASE_NAME).exists() {
        return Ok(Vec::new());
    }
    let connection = database(root)?;
    let mut statement = connection
        .prepare(
            "SELECT task_id, document, shot_id, status, prompt, duration, resolution,
                    seed, remote_url, local_file, error, created_at, updated_at
               FROM generations WHERE document = ?1 AND shot_id = ?2
               ORDER BY created_at DESC LIMIT 50",
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let records = statement
        .query_map(params![document, shot_id], row)
        .map_err(|e| AppError::new("database", e.to_string()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    Ok(records)
}

fn get(root: &Path, task_id: &str) -> Result<GenerationRecord> {
    database(root)?
        .query_row(
            "SELECT task_id, document, shot_id, status, prompt, duration, resolution,
                    seed, remote_url, local_file, error, created_at, updated_at
               FROM generations WHERE task_id = ?1",
            [task_id],
            row,
        )
        .map_err(|e| AppError::new("database", e.to_string()))
}

fn parse_http_url(raw: &str) -> Result<reqwest::Url> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = reqwest::Url::parse(trimmed)
        .map_err(|_| AppError::new("config", "请先填写有效的 http:// 或 https:// 地址"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::new(
            "config",
            "请先填写有效的 http:// 或 https:// 地址",
        ));
    }
    Ok(url)
}

fn submit_endpoint(settings: &GenerationSettings, has_ref_audio: bool) -> Result<String> {
    let url = parse_http_url(&settings.submit_url)?;
    let mut endpoint = url.as_str().trim_end_matches('/').to_owned();
    if !has_ref_audio && endpoint.contains(AUDIO_REQUIRED_WORKFLOW) {
        endpoint = endpoint.replace(AUDIO_REQUIRED_WORKFLOW, AUDIO_OPTIONAL_WORKFLOW);
    }
    Ok(endpoint)
}

fn result_endpoint(settings: &GenerationSettings, task_id: &str) -> Result<String> {
    let template = settings.query_url.trim();
    if template.is_empty() {
        return Err(AppError::new("config", "请先填写查询任务地址"));
    }
    if template.contains("{task_id}") {
        let filled = template.replace("{task_id}", task_id);
        parse_http_url(&filled)?;
        return Ok(filled);
    }
    let base = parse_http_url(template)?;
    Ok(format!(
        "{}/{}",
        base.as_str().trim_end_matches('/'),
        task_id
    ))
}

fn client(settings: &GenerationSettings) -> Result<Client> {
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

fn mime(path: &Path) -> Result<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "png" => Ok("image/png"),
        "webp" => Ok("image/webp"),
        "mp3" => Ok("audio/mpeg"),
        "wav" => Ok("audio/wav"),
        "flac" => Ok("audio/flac"),
        "mp4" => Ok("video/mp4"),
        _ => Err(AppError::new("media", "参考素材格式不受视频接口支持")),
    }
}

fn api_media(root: &Path, document: &str, reference: &str) -> Result<String> {
    if reference.starts_with("https://") || reference.starts_with("http://") {
        return Ok(reference.to_owned());
    }
    let media = storage::resolve_media(root, document, reference)?;
    let path = media
        .path
        .ok_or_else(|| AppError::new("media", format!("参考素材不存在：{reference}")))?;
    let path = Path::new(&path);
    Ok(format!(
        "data:{};base64,{}",
        mime(path)?,
        STANDARD.encode(fs::read(path)?)
    ))
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
        let message = value.get("msg").and_then(Value::as_str).unwrap_or(code);
        return Err(AppError::new("api", message));
    }
    Ok(value)
}

fn resolution_prefix_match(shot: &str, item: &str) -> bool {
    match item.strip_prefix(shot) {
        Some(rest) => {
            rest.is_empty()
                || rest.starts_with('(')
                || rest.starts_with(' ')
                || rest.starts_with('（')
        }
        None => false,
    }
}

fn resolve_resolution(value: &str, resolutions: &[String]) -> Result<String> {
    if resolutions.is_empty() {
        return Err(AppError::new(
            "config",
            "当前 API 配置未设置 resolution 列表",
        ));
    }
    let shot = value.trim();
    if shot.is_empty() {
        return Ok(resolutions[0].clone());
    }
    if let Some(exact) = resolutions.iter().find(|item| item.as_str() == shot) {
        return Ok(exact.clone());
    }
    let prefixed: Vec<&String> = resolutions
        .iter()
        .filter(|item| resolution_prefix_match(shot, item))
        .collect();
    if prefixed.len() == 1 {
        return Ok(prefixed[0].clone());
    }
    if prefixed.len() > 1 {
        return Ok(prefixed
            .iter()
            .find(|item| item.contains('('))
            .copied()
            .unwrap_or(prefixed[0])
            .clone());
    }
    Err(AppError::new(
        "input",
        "视频分辨率不在当前 API 配置的 resolution 列表中",
    ))
}

pub async fn submit(
    root: &Path,
    settings: &GenerationSettings,
    input: GenerationInput,
) -> Result<GenerationRecord> {
    if input.prompt.trim().is_empty() || input.prompt.chars().count() > 10_000 {
        return Err(AppError::new("input", "视频提示词须为 1—10000 个字符"));
    }
    if !(1..=15).contains(&input.duration) {
        return Err(AppError::new("input", "视频时长须为 1—15 秒"));
    }
    let resolution = resolve_resolution(&input.resolution, &settings.resolutions)?;
    if input.image_refs.is_empty() || input.image_refs.len() > 9 || input.audio_refs.len() > 3 {
        return Err(AppError::new(
            "input",
            "需要 1—9 张参考图，最多可带 3 个参考音频",
        ));
    }
    let mut body = json!({
        "prompt": input.prompt,
        "duration": input.duration,
        "resolution": resolution,
    });
    if let Some(seed) = input.seed {
        body["seed"] = json!(seed);
    }
    for (index, reference) in input.image_refs.iter().enumerate() {
        body[format!("ref_image_{index}")] = json!(api_media(root, &input.document, reference)?);
    }
    for (index, reference) in input.audio_refs.iter().enumerate() {
        body[format!("ref_audio_{index}")] = json!(api_media(root, &input.document, reference)?);
    }
    let has_ref_audio = body.get("ref_audio_0").is_some();
    let value = envelope(
        client(settings)?
            .post(submit_endpoint(settings, has_ref_audio)?)
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
    let now = Local::now().to_rfc3339_opts(SecondsFormat::Secs, false);
    {
        let mut connection = database(root)?;
        let transaction = connection
            .transaction()
            .map_err(|e| AppError::new("database", e.to_string()))?;
        transaction
            .execute(
                "INSERT OR REPLACE INTO generations
             (task_id, document, shot_id, status, prompt, duration, resolution, seed,
              image_refs, audio_refs, remote_url, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    task_id,
                    input.document,
                    input.shot_id,
                    status,
                    input.prompt,
                    input.duration,
                    resolution,
                    input.seed,
                    serde_json::to_string(&input.image_refs).unwrap_or_default(),
                    serde_json::to_string(&input.audio_refs).unwrap_or_default(),
                    remote_url,
                    now,
                ],
            )
            .map_err(|e| AppError::new("database", e.to_string()))?;
        transaction.execute(
        "INSERT OR REPLACE INTO generation_providers (task_id, profile_id, base_url) VALUES (?1, ?2, ?3)",
        params![task_id, settings.profile_id, settings.submit_url],
    ).map_err(|e| AppError::new("database", e.to_string()))?;
        transaction
            .commit()
            .map_err(|e| AppError::new("database", e.to_string()))?;
    }
    let record = get(root, &task_id)?;
    if matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "success" | "succeeded"
    ) {
        if let Some(url) = record.remote_url.clone() {
            let (stored_status, local_file, error) =
                match download(root, settings, &record, &url).await {
                    Ok(file) => (status, Some(file), None),
                    Err(e) => ("download_failed".into(), None, Some(e.message)),
                };
            database(root)?
                .execute(
                    "UPDATE generations SET status = ?2, local_file = ?3, error = ?4,
                            updated_at = ?5 WHERE task_id = ?1",
                    params![
                        task_id,
                        stored_status,
                        local_file,
                        error,
                        Local::now().to_rfc3339_opts(SecondsFormat::Secs, false),
                    ],
                )
                .map_err(|e| AppError::new("database", e.to_string()))?;
        }
    }
    get(root, &task_id)
}

fn result_url(data: &Value) -> Option<String> {
    data.get("results")?
        .as_array()?
        .iter()
        .find(|item| {
            item.get("type").and_then(Value::as_str) == Some("video")
                || item.get("file_type").and_then(Value::as_str) == Some("mp4")
        })?
        .get("url")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn video_stem(document: &Path, shot_id: &str, timestamp: &str) -> String {
    let name = document
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let number: String = name
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if number.is_empty() {
        format!("{shot_id}_{timestamp}")
    } else {
        format!("{number:0>2} {shot_id}_{timestamp}")
    }
}

fn same_file_contents(left: &Path, right: &Path) -> std::io::Result<bool> {
    if fs::metadata(left)?.len() != fs::metadata(right)?.len() {
        return Ok(false);
    }
    let mut left = fs::File::open(left)?;
    let mut right = fs::File::open(right)?;
    let mut left_buffer = [0_u8; 64 * 1024];
    let mut right_buffer = [0_u8; 64 * 1024];
    loop {
        let left_count = left.read(&mut left_buffer)?;
        let right_count = right.read(&mut right_buffer)?;
        if left_count != right_count || left_buffer[..left_count] != right_buffer[..right_count] {
            return Ok(false);
        }
        if left_count == 0 {
            return Ok(true);
        }
    }
}

fn persist_download(
    mut temp: tempfile::NamedTempFile,
    parent: &Path,
    stem: &str,
    task_id: &str,
) -> Result<String> {
    let task_suffix = &task_id[..8.min(task_id.len())];
    for collision in 0_u32.. {
        let filename = match collision {
            0 => format!("{stem}.mp4"),
            1 => format!("{stem}_{task_suffix}.mp4"),
            number => format!("{stem}_{task_suffix}_{number}.mp4"),
        };
        let target = parent.join(&filename);
        match temp.persist_noclobber(&target) {
            Ok(_) => return Ok(filename),
            Err(error) if target.is_file() => {
                temp = error.file;
                if same_file_contents(temp.path(), &target)? {
                    return Ok(filename);
                }
            }
            Err(error) => return Err(AppError::from(error.error)),
        }
    }
    unreachable!()
}

async fn download(
    root: &Path,
    settings: &GenerationSettings,
    record: &GenerationRecord,
    url: &str,
) -> Result<String> {
    let document = storage::document_path(root, &record.document, true)?;
    let parent = document
        .parent()
        .ok_or_else(|| AppError::new("path", "文档缺少父目录"))?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let stem = video_stem(&document, &record.shot_id, &timestamp);
    let mut response = client(settings)?
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::new("network", e.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::new(
            "download",
            format!("视频下载失败：{}", response.status()),
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
    persist_download(temp, parent, &stem, &record.task_id)
}

pub async fn poll(
    root: &Path,
    settings: &GenerationSettings,
    task_id: &str,
) -> Result<GenerationRecord> {
    let existing = get(root, task_id)?;
    if existing.status == "completed" && existing.local_file.is_some() {
        return Ok(existing);
    }
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
    let failed = matches!(
        status.to_ascii_lowercase().as_str(),
        "failed" | "error" | "cancelled"
    );
    let remote_url = result_url(data);
    let mut local_file = existing.local_file.clone();
    let mut error = if failed {
        Some(
            value
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("视频生成失败")
                .to_owned(),
        )
    } else {
        None
    };
    let completed = matches!(
        status.to_ascii_lowercase().as_str(),
        "completed" | "success" | "succeeded"
    );
    if completed && local_file.is_none() {
        match remote_url.as_deref() {
            Some(url) => match download(root, settings, &existing, url).await {
                Ok(file) => local_file = Some(file),
                Err(e) => error = Some(e.message),
            },
            None => error = Some("任务已完成，但结果中没有视频地址".into()),
        }
    }
    let stored_status = if completed && local_file.is_none() {
        "download_failed"
    } else {
        status
    };
    database(root)?
        .execute(
            "UPDATE generations SET status = ?2, remote_url = ?3, local_file = ?4,
                    error = ?5, updated_at = ?6 WHERE task_id = ?1",
            params![
                task_id,
                stored_status,
                remote_url,
                local_file,
                error,
                Local::now().to_rfc3339_opts(SecondsFormat::Secs, false),
            ],
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    get(root, task_id)
}

pub fn import_media(
    root: &Path,
    document: &str,
    source: &str,
    shot_id: &str,
    slot: &str,
) -> Result<String> {
    let source = fs::canonicalize(source)?;
    if !source.is_file() {
        return Err(AppError::new("media", "请选择图片或音频文件"));
    }
    mime(&source)?;
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("bin");
    let document = storage::document_path(root, document, true)?;
    let parent = document
        .parent()
        .ok_or_else(|| AppError::new("path", "文档缺少父目录"))?;
    let safe_slot: String = slot
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect();
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let filename = format!(
        "{}_{}_{}_{}.{}",
        shot_id,
        safe_slot,
        Local::now().format("%Y%m%d-%H%M%S"),
        &suffix[..8],
        extension
    );
    let destination = parent.join(&filename);
    let bytes = fs::read(source)?;
    storage::atomic_write(&destination, &bytes, true)?;
    Ok(filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        net::{TcpListener, TcpStream},
        thread,
    };
    use tempfile::tempdir;

    #[test]
    fn resolves_short_resolution_labels_against_current_list() {
        let list = vec!["480p竖(480*864)".into(), "480p横(864*480)".into()];
        assert_eq!(
            resolve_resolution("480p横", &list).unwrap(),
            "480p横(864*480)"
        );
        assert_eq!(
            resolve_resolution("480p横(864*480)", &list).unwrap(),
            "480p横(864*480)"
        );
        assert_eq!(resolve_resolution("", &list).unwrap(), "480p竖(480*864)");
        assert!(resolve_resolution("999p", &list).is_err());
    }

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
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .unwrap();
        stream.write_all(body).unwrap();
    }

    fn fixture_settings(submit_url: &str) -> GenerationSettings {
        GenerationSettings {
            profile_id: "fixture".into(),
            submit_url: submit_url.into(),
            query_url: "https://example.test/result/{task_id}".into(),
            resolutions: vec!["768p横(1376*768)".into()],
            authorization: String::new(),
        }
    }

    #[test]
    fn z0903_without_audio_rewrites_to_z0902() {
        let z0903 =
            fixture_settings("https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_z0903");
        assert_eq!(
            submit_endpoint(&z0903, false).unwrap(),
            "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_z0902"
        );
        assert_eq!(
            submit_endpoint(&z0903, true).unwrap(),
            "https://autodl.art/api/v1/comfyui/comfyui_workflow/minimax_h3_z0903"
        );
        assert_eq!(
            submit_endpoint(&fixture_settings("https://example.test/submit"), false).unwrap(),
            "https://example.test/submit"
        );
    }

    #[test]
    fn video_names_use_the_episode_document_number() {
        for (document, expected) in [
            ("01 测试.md", "01 S007_20260913-222911"),
            ("episodes/2 测试.md", "02 S007_20260913-222911"),
            ("episodes/123 测试.md", "123 S007_20260913-222911"),
            ("01 目录/episode.md", "S007_20260913-222911"),
        ] {
            assert_eq!(
                video_stem(Path::new(document), "S007", "20260913-222911"),
                expected
            );
        }
    }

    #[test]
    fn concurrent_download_of_the_same_result_reuses_the_existing_file() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("01 S001_20260918-010203.mp4");
        fs::write(&target, b"same-video").unwrap();
        let mut temp = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        temp.write_all(b"same-video").unwrap();

        let filename =
            persist_download(temp, dir.path(), "01 S001_20260918-010203", "12345678-task").unwrap();

        assert_eq!(filename, "01 S001_20260918-010203.mp4");
        assert_eq!(fs::read(target).unwrap(), b"same-video");
        assert!(!dir
            .path()
            .join("01 S001_20260918-010203_12345678.mp4")
            .exists());
    }

    #[test]
    fn colliding_download_with_different_contents_uses_a_task_suffix() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("01 S001_20260918-010203.mp4"),
            b"other-video",
        )
        .unwrap();
        let mut temp = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
        temp.write_all(b"new-video").unwrap();

        let filename =
            persist_download(temp, dir.path(), "01 S001_20260918-010203", "12345678-task").unwrap();

        assert_eq!(filename, "01 S001_20260918-010203_12345678.mp4");
        assert_eq!(fs::read(dir.path().join(&filename)).unwrap(), b"new-video");
    }

    #[test]
    fn submits_polls_downloads_and_keeps_history() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut submit, _) = listener.accept().unwrap();
            let submitted = request(&mut submit);
            assert!(submitted.starts_with("POST /submit "));
            assert!(submitted
                .to_ascii_lowercase()
                .contains("authorization: token fixture"));
            assert!(submitted.contains("data:image/png;base64,"));
            let body: Value =
                serde_json::from_str(submitted.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body["seed"], 683072603085674_i64);
            assert_eq!(
                body["ref_audio_0"],
                format!(
                    "data:audio/mpeg;base64,{}",
                    STANDARD.encode(b"synthetic-audio")
                )
            );
            assert!(body.get("authorization").is_none());
            respond(
                &mut submit,
                "application/json",
                br#"{"code":"Success","data":{"task_id":"task-1","status":"queued"}}"#,
            );

            let (mut poll, _) = listener.accept().unwrap();
            assert!(request(&mut poll).starts_with("GET /result/task-1 "));
            let body = format!(
                "{{\"code\":\"Success\",\"data\":{{\"status\":\"completed\",\"results\":[{{\"url\":\"http://{address}/video.mp4\",\"type\":\"video\",\"file_type\":\"mp4\"}}]}}}}"
            );
            respond(&mut poll, "application/json", body.as_bytes());

            let (mut video, _) = listener.accept().unwrap();
            assert!(request(&mut video).starts_with("GET /video.mp4 "));
            respond(&mut video, "video/mp4", b"synthetic-video");
        });

        let project = tempfile::tempdir().unwrap();
        let root = storage::canonical_directory(project.path()).unwrap();
        storage::create_document(&root, "01 测试.md", "# S001 测试\n").unwrap();
        fs::write(root.join("frame.png"), b"synthetic-image").unwrap();
        fs::write(root.join("voice.mp3"), b"synthetic-audio").unwrap();
        let submit_url = format!("http://{address}/submit");
        let settings = GenerationSettings {
            profile_id: "fixture".into(),
            submit_url: submit_url.clone(),
            query_url: format!("http://{address}/result/{{task_id}}"),
            resolutions: vec!["768p横(1376*768)".into()],
            authorization: "Token fixture".into(),
        };
        let record = tauri::async_runtime::block_on(submit(
            &root,
            &settings,
            GenerationInput {
                document: "01 测试.md".into(),
                shot_id: "S001".into(),
                prompt: "向前走".into(),
                duration: 5,
                resolution: "768p横(1376*768)".into(),
                seed: Some(683072603085674),
                image_refs: vec!["frame.png".into()],
                audio_refs: vec!["voice.mp3".into()],
            },
        ))
        .unwrap();
        assert_eq!(record.status, "queued");
        assert_eq!(
            task_provider(&root, "task-1").unwrap(),
            Some(("fixture".into(), submit_url))
        );
        assert_eq!(task_provider(&root, "legacy-task").unwrap(), None);
        let completed =
            tauri::async_runtime::block_on(poll(&root, &settings, &record.task_id)).unwrap();
        assert_eq!(completed.status, "completed");
        let file = completed.local_file.unwrap();
        assert!(file.starts_with("01 S001_"), "{file}");
        assert!(file.ends_with(".mp4"), "{file}");
        assert_eq!(fs::read(root.join(&file)).unwrap(), b"synthetic-video");
        assert_eq!(history(&root, "01 测试.md", "S001").unwrap().len(), 1);
        server.join().unwrap();
    }

    fn post_to_workflow(workflow: &str, audio_refs: Vec<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let expected = workflow.to_owned();
        let server = thread::spawn(move || {
            let (mut submit, _) = listener.accept().unwrap();
            assert!(request(&mut submit).starts_with(&format!("POST {expected} ")));
            respond(
                &mut submit,
                "application/json",
                br#"{"code":"Success","data":{"task_id":"task-custom","status":"queued"}}"#,
            );
        });

        let project = tempfile::tempdir().unwrap();
        let root = storage::canonical_directory(project.path()).unwrap();
        storage::create_document(&root, "01 测试.md", "# S001 测试\n").unwrap();
        fs::write(root.join("frame.png"), b"synthetic-image").unwrap();
        if !audio_refs.is_empty() {
            fs::write(root.join("voice.mp3"), b"synthetic-audio").unwrap();
        }
        let settings = GenerationSettings {
            profile_id: "fixture".into(),
            submit_url: format!(
                "http://{address}/api/v1/comfyui/comfyui_workflow/minimax_h3_z0903"
            ),
            query_url: format!("http://{address}/result/{{task_id}}"),
            resolutions: vec!["768p横(1376*768)".into()],
            authorization: String::new(),
        };
        tauri::async_runtime::block_on(submit(
            &root,
            &settings,
            GenerationInput {
                document: "01 测试.md".into(),
                shot_id: "S001".into(),
                prompt: "向前走".into(),
                duration: 5,
                resolution: "768p横(1376*768)".into(),
                seed: None,
                image_refs: vec!["frame.png".into()],
                audio_refs,
            },
        ))
        .unwrap();
        server.join().unwrap();
    }

    #[test]
    fn submit_z0903_without_audio_posts_to_z0902() {
        post_to_workflow("/api/v1/comfyui/comfyui_workflow/minimax_h3_z0902", vec![]);
    }

    #[test]
    fn submit_z0903_with_audio_keeps_z0903() {
        post_to_workflow(
            "/api/v1/comfyui/comfyui_workflow/minimax_h3_z0903",
            vec!["voice.mp3".into()],
        );
    }

    #[test]
    fn media_body_encodes_audio_video_bytes_and_rejects_escape() {
        let project = tempfile::tempdir().unwrap();
        let root = storage::canonical_directory(project.path()).unwrap();
        storage::create_document(&root, "episode.md", "# S001\n").unwrap();
        for (file, mime) in [
            ("sample.mp3", "audio/mpeg"),
            ("sample.wav", "audio/wav"),
            ("sample.flac", "audio/flac"),
            ("sample.mp4", "video/mp4"),
        ] {
            fs::write(root.join(file), [0, 1, 2, 254, 255]).unwrap();
            assert_eq!(
                api_media(&root, "episode.md", file).unwrap(),
                format!("data:{mime};base64,AAEC/v8=")
            );
        }
        assert!(api_media(&root, "episode.md", "../outside.mp3").is_err());
    }
}
