use crate::audio::{self, AudioInput, AudioSettings};
use crate::generation::{self, GenerationInput, GenerationSettings};
use crate::storage::{AppError, Result};
use chrono::{DateTime, Local, SecondsFormat};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{path::Path, thread};
use uuid::Uuid;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJobItemInput {
    pub shot_id: String,
    pub shot_title: String,
    pub prompt: String,
    pub duration: u8,
    pub resolution: String,
    pub seed: Option<i64>,
    pub image_refs: Vec<String>,
    pub audio_refs: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBatchJobInput {
    pub job_type: String,
    pub name: String,
    pub document: String,
    pub delay_hours: u8,
    pub items: Vec<BatchJobItemInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeShotInput {
    pub shot_id: String,
    pub shot_title: String,
    pub local_file: String,
    pub duration: u8,
    pub resolution: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeEpisodeInput {
    pub document: String,
    pub name: String,
    pub items: Vec<MergeShotInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJobItem {
    pub item_id: String,
    pub job_id: String,
    pub shot_id: String,
    pub shot_title: String,
    pub status: String,
    pub prompt: String,
    pub duration: u8,
    pub resolution: String,
    pub seed: Option<i64>,
    pub image_refs: Vec<String>,
    pub audio_refs: Vec<String>,
    pub generation_task_id: Option<String>,
    pub local_file: Option<String>,
    pub error: Option<String>,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchJob {
    pub job_id: String,
    pub job_type: String,
    pub name: String,
    pub document: String,
    pub status: String,
    pub scheduled_at: String,
    pub created_at: String,
    pub updated_at: String,
    pub item_total: i64,
    pub item_completed: i64,
    pub item_cancelled: i64,
    pub item_failed: i64,
    pub items: Vec<BatchJobItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchAdvanceResult {
    pub submitted: Option<BatchJobItem>,
    pub jobs: Vec<BatchJob>,
}

fn now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

fn parse_time(value: &str) -> Result<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Local))
        .map_err(|e| AppError::new("input", format!("时间格式无效：{e}")))
}

fn decode_refs(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}

fn item_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BatchJobItem> {
    Ok(BatchJobItem {
        item_id: row.get(0)?,
        job_id: row.get(1)?,
        shot_id: row.get(2)?,
        shot_title: row.get(3)?,
        status: row.get(4)?,
        prompt: row.get(5)?,
        duration: row.get(6)?,
        resolution: row.get(7)?,
        seed: row.get(8)?,
        image_refs: decode_refs(row.get(9)?),
        audio_refs: decode_refs(row.get(10)?),
        generation_task_id: row.get(11)?,
        local_file: row.get(12)?,
        error: row.get(13)?,
        sort_order: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

const ITEM_SELECT: &str = "SELECT item_id, job_id, shot_id, shot_title, status, prompt, duration,
       resolution, seed, image_refs, audio_refs, generation_task_id, local_file, error,
       sort_order, created_at, updated_at
  FROM batch_job_items";

fn load_items(connection: &rusqlite::Connection, job_id: &str) -> Result<Vec<BatchJobItem>> {
    let mut statement = connection
        .prepare(&format!(
            "{ITEM_SELECT} WHERE job_id = ?1 ORDER BY sort_order ASC, created_at ASC"
        ))
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let items = statement
        .query_map([job_id], item_row)
        .map_err(|e| AppError::new("database", e.to_string()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    Ok(items)
}

fn summarize(items: &[BatchJobItem]) -> (i64, i64, i64, i64) {
    let total = items.len() as i64;
    let completed = items
        .iter()
        .filter(|item| item.status == "completed")
        .count() as i64;
    let cancelled = items
        .iter()
        .filter(|item| item.status == "cancelled")
        .count() as i64;
    let failed = items
        .iter()
        .filter(|item| matches!(item.status.as_str(), "failed" | "download_failed"))
        .count() as i64;
    (total, completed, cancelled, failed)
}

fn derive_job_status(current: &str, items: &[BatchJobItem]) -> String {
    if current == "cancelled" || items.iter().all(|item| item.status == "cancelled") {
        return "cancelled".into();
    }
    if items.is_empty() {
        return current.to_owned();
    }
    let active = items
        .iter()
        .any(|item| matches!(item.status.as_str(), "pending" | "submitted" | "running"));
    if active {
        if current == "scheduled" {
            return "scheduled".into();
        }
        return "running".into();
    }
    if items
        .iter()
        .any(|item| matches!(item.status.as_str(), "failed" | "download_failed"))
    {
        return "failed".into();
    }
    if items.iter().any(|item| item.status == "completed") {
        return "completed".into();
    }
    current.to_owned()
}

fn job_from_parts(
    job_id: String,
    job_type: String,
    name: String,
    document: String,
    status: String,
    scheduled_at: String,
    created_at: String,
    updated_at: String,
    items: Vec<BatchJobItem>,
    result_file: Option<String>,
) -> BatchJob {
    let (item_total, item_completed, item_cancelled, item_failed) = summarize(&items);
    BatchJob {
        job_id,
        job_type,
        name,
        document,
        status,
        scheduled_at,
        created_at,
        updated_at,
        item_total,
        item_completed,
        item_cancelled,
        item_failed,
        items,
        result_file,
    }
}

fn load_job(connection: &rusqlite::Connection, job_id: &str) -> Result<BatchJob> {
    let (job_type, name, document, status, scheduled_at, created_at, updated_at, result_file) =
        connection
            .query_row(
                "SELECT job_type, name, document, status, scheduled_at, created_at, updated_at,
                        result_file
                   FROM batch_jobs WHERE job_id = ?1",
                [job_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .map_err(|e| AppError::new("database", e.to_string()))?;
    let items = load_items(connection, job_id)?;
    Ok(job_from_parts(
        job_id.to_owned(),
        job_type,
        name,
        document,
        status,
        scheduled_at,
        created_at,
        updated_at,
        items,
        result_file.filter(|value| !value.is_empty()),
    ))
}

fn has_in_flight_generation(connection: &rusqlite::Connection) -> Result<bool> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM batch_job_items AS items
               JOIN batch_jobs AS jobs ON jobs.job_id = items.job_id
              WHERE jobs.job_type = 'generation'
                AND items.status IN ('submitted', 'running')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    Ok(count > 0)
}

fn refresh_job_status(connection: &rusqlite::Connection, job_id: &str) -> Result<BatchJob> {
    let mut job = load_job(connection, job_id)?;
    let next = derive_job_status(&job.status, &job.items);
    if next != job.status {
        let stamp = now();
        connection
            .execute(
                "UPDATE batch_jobs SET status = ?2, updated_at = ?3 WHERE job_id = ?1",
                params![job_id, next, stamp],
            )
            .map_err(|e| AppError::new("database", e.to_string()))?;
        job.status = next;
        job.updated_at = stamp;
    }
    Ok(job)
}

fn sync_item_from_generation(
    connection: &rusqlite::Connection,
    item: &BatchJobItem,
) -> Result<Option<BatchJobItem>> {
    let Some(task_id) = item.generation_task_id.as_deref() else {
        return Ok(None);
    };
    if matches!(item.status.as_str(), "cancelled") {
        return Ok(None);
    }
    let Some((status, local_file, error)) = connection
        .query_row(
            "SELECT status, local_file, error FROM generations WHERE task_id = ?1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| AppError::new("database", e.to_string()))?
    else {
        return Ok(None);
    };
    let mapped = match status.to_ascii_lowercase().as_str() {
        "completed" | "success" | "succeeded" if local_file.is_some() => "completed",
        "failed" | "error" => "failed",
        "cancelled" => "cancelled",
        "download_failed" => "download_failed",
        "submitted" | "pending" | "queued" => "submitted",
        _ => "running",
    };
    if mapped == item.status
        && local_file == item.local_file
        && error.as_deref() == item.error.as_deref()
    {
        return Ok(None);
    }
    let stamp = now();
    connection
        .execute(
            "UPDATE batch_job_items
                SET status = ?2, local_file = ?3, error = ?4, updated_at = ?5
              WHERE item_id = ?1",
            params![item.item_id, mapped, local_file, error, stamp],
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let mut next = item.clone();
    next.status = mapped.into();
    next.local_file = local_file;
    next.error = error;
    next.updated_at = stamp;
    Ok(Some(next))
}

fn sync_item_from_audio(
    connection: &rusqlite::Connection,
    item: &BatchJobItem,
) -> Result<Option<BatchJobItem>> {
    let Some(task_id) = item.generation_task_id.as_deref() else {
        return Ok(None);
    };
    if item.status == "cancelled" {
        return Ok(None);
    }
    let Some((status, local_file, error)) = connection
        .query_row(
            "SELECT status, local_file, error FROM audio_generations WHERE task_id = ?1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| AppError::new("database", e.to_string()))?
    else {
        return Ok(None);
    };
    let mapped = match status.to_ascii_lowercase().as_str() {
        "completed" | "success" | "succeeded" if local_file.is_some() => "completed",
        "failed" | "error" => "failed",
        "cancelled" => "cancelled",
        "download_failed" => "download_failed",
        "submitted" | "pending" | "queued" => "submitted",
        _ => "running",
    };
    if mapped == item.status
        && local_file == item.local_file
        && error.as_deref() == item.error.as_deref()
    {
        return Ok(None);
    }
    let stamp = now();
    connection.execute("UPDATE batch_job_items SET status = ?2, local_file = ?3, error = ?4, updated_at = ?5 WHERE item_id = ?1", params![item.item_id, mapped, local_file, error, stamp]).map_err(|e| AppError::new("database", e.to_string()))?;
    let mut next = item.clone();
    next.status = mapped.into();
    next.local_file = local_file;
    next.error = error;
    next.updated_at = stamp;
    Ok(Some(next))
}

pub fn create_job(root: &Path, input: CreateBatchJobInput) -> Result<BatchJob> {
    if !matches!(input.job_type.as_str(), "generation" | "audio") {
        return Err(AppError::new("input", "不支持的任务类型"));
    }
    if input.delay_hours > 12 {
        return Err(AppError::new("input", "延时最多 12 小时"));
    }
    if input.items.is_empty() {
        return Err(AppError::new("input", "请至少选择一个分镜"));
    }
    if input.name.trim().is_empty() {
        return Err(AppError::new("input", "任务名称不能为空"));
    }
    if input.document.trim().is_empty() {
        return Err(AppError::new("input", "缺少文档路径"));
    }
    for item in &input.items {
        if item.shot_id.trim().is_empty() {
            return Err(AppError::new("input", "分镜编号不能为空"));
        }
        let prompt_limit = if input.job_type == "audio" {
            2_048
        } else {
            10_000
        };
        if item.prompt.trim().is_empty() || item.prompt.chars().count() > prompt_limit {
            return Err(AppError::new(
                "input",
                format!("{} 的生成文本无效", item.shot_id),
            ));
        }
        if input.job_type == "generation" && !(1..=15).contains(&item.duration) {
            return Err(AppError::new(
                "input",
                format!("{} 的时长须为 1—15 秒", item.shot_id),
            ));
        }
        if input.job_type == "generation"
            && (item.image_refs.is_empty()
                || item.image_refs.len() > 9
                || item.audio_refs.len() > 3)
        {
            return Err(AppError::new(
                "input",
                format!("{} 需要 1—9 张参考图，最多 3 段参考音频", item.shot_id),
            ));
        }
        if input.job_type == "audio"
            && (item.shot_title.trim().is_empty() || item.audio_refs.len() != 1)
        {
            return Err(AppError::new(
                "input",
                format!("{} 缺少角色名称或音色参考", item.shot_id),
            ));
        }
    }

    let stamp = now();
    let scheduled_at = (Local::now() + chrono::Duration::hours(i64::from(input.delay_hours)))
        .to_rfc3339_opts(SecondsFormat::Secs, false);
    let status = if input.delay_hours == 0 {
        "running"
    } else {
        "scheduled"
    };
    let job_id = Uuid::new_v4().to_string();
    let mut connection = generation::open_database(root)?;
    let transaction = connection
        .transaction()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    transaction
        .execute(
            "INSERT INTO batch_jobs
             (job_id, job_type, name, document, status, scheduled_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                job_id,
                input.job_type,
                input.name.trim(),
                input.document,
                status,
                scheduled_at,
                stamp
            ],
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    for (index, item) in input.items.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO batch_job_items
                 (item_id, job_id, shot_id, shot_title, status, prompt, duration, resolution,
                  seed, image_refs, audio_refs, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                params![
                    Uuid::new_v4().to_string(),
                    job_id,
                    item.shot_id,
                    item.shot_title,
                    item.prompt,
                    item.duration,
                    item.resolution,
                    item.seed,
                    serde_json::to_string(&item.image_refs).unwrap_or_default(),
                    serde_json::to_string(&item.audio_refs).unwrap_or_default(),
                    index as i64,
                    stamp,
                ],
            )
            .map_err(|e| AppError::new("database", e.to_string()))?;
    }
    transaction
        .commit()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    load_job(&generation::open_database(root)?, &job_id)
}

pub fn merge_episode(root: &Path, input: MergeEpisodeInput) -> Result<BatchJob> {
    if input.items.is_empty() {
        return Err(AppError::new("input", "请至少选择一个分镜"));
    }
    if input.name.trim().is_empty() {
        return Err(AppError::new("input", "任务名称不能为空"));
    }
    if input.document.trim().is_empty() {
        return Err(AppError::new("input", "缺少文档路径"));
    }
    for item in &input.items {
        if item.shot_id.trim().is_empty() {
            return Err(AppError::new("input", "分镜编号不能为空"));
        }
        if item.local_file.trim().is_empty() {
            return Err(AppError::new(
                "input",
                format!("{} 没有当前视频，无法合并", item.shot_id),
            ));
        }
    }
    let stamp = now();
    let job_id = Uuid::new_v4().to_string();
    let mut connection = generation::open_database(root)?;
    let transaction = connection
        .transaction()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    if has_active_merge(&transaction, &input.document)? {
        return Err(AppError::new(
            "busy",
            "当前集已有合并任务进行中，请到任务列表查看",
        ));
    }
    transaction
        .execute(
            "INSERT INTO batch_jobs
             (job_id, job_type, name, document, status, scheduled_at, created_at, updated_at)
             VALUES (?1, 'merge', ?2, ?3, 'running', ?4, ?4, ?4)",
            params![job_id, input.name.trim(), input.document, stamp],
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    for (index, item) in input.items.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO batch_job_items
                 (item_id, job_id, shot_id, shot_title, status, prompt, duration, resolution,
                  seed, image_refs, audio_refs, local_file, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 'pending', '', ?5, ?6, NULL, '[]', '[]', ?7, ?8, ?9, ?9)",
                params![
                    Uuid::new_v4().to_string(),
                    job_id,
                    item.shot_id,
                    item.shot_title,
                    item.duration.max(1),
                    item.resolution,
                    item.local_file,
                    index as i64,
                    stamp,
                ],
            )
            .map_err(|e| AppError::new("database", e.to_string()))?;
    }
    transaction
        .commit()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let job = load_job(&connection, &job_id)?;
    drop(connection);

    let root_buf = root.to_path_buf();
    let document = input.document.clone();
    let references: Vec<String> = input
        .items
        .iter()
        .map(|item| item.local_file.clone())
        .collect();
    let worker_id = job_id.clone();
    if let Err(error) = thread::Builder::new()
        .name("drama-craft-merge".into())
        .spawn(move || run_merge_job(&root_buf, &worker_id, &document, &references))
    {
        let _ = finish_merge_job(
            root,
            &job_id,
            Err(AppError::new(
                "ffmpeg",
                format!("无法启动合并任务：{error}"),
            )),
        );
        return Err(AppError::new(
            "ffmpeg",
            format!("无法启动合并任务：{error}"),
        ));
    }
    Ok(job)
}

fn normalize_document(value: &str) -> String {
    value.replace('\\', "/")
}

fn has_active_merge(connection: &rusqlite::Connection, document: &str) -> Result<bool> {
    let mut statement = connection
        .prepare(
            "SELECT document FROM batch_jobs
              WHERE job_type = 'merge' AND status IN ('scheduled', 'running')",
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let documents = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| AppError::new("database", e.to_string()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let needle = normalize_document(document);
    Ok(documents
        .iter()
        .any(|value| normalize_document(value) == needle))
}

fn run_merge_job(root: &Path, job_id: &str, document: &str, references: &[String]) {
    let claimed = (|| -> Result<usize> {
        let connection = generation::open_database(root)?;
        let stamp = now();
        connection
            .execute(
                "UPDATE batch_job_items
                    SET status = 'running', updated_at = ?2
                  WHERE job_id = ?1 AND status = 'pending'",
                params![job_id, stamp],
            )
            .map_err(|e| AppError::new("database", e.to_string()))
            .map(|changed| changed as usize)
    })();
    match claimed {
        Ok(0) | Err(_) => return,
        Ok(_) => {}
    }
    let outcome = crate::ffmpeg::concat_videos(root, document, references);
    let _ = finish_merge_job(root, job_id, outcome);
}

fn finish_merge_job(root: &Path, job_id: &str, outcome: Result<String>) -> Result<()> {
    let connection = generation::open_database(root)?;
    let status: String = connection
        .query_row(
            "SELECT status FROM batch_jobs WHERE job_id = ?1",
            [job_id],
            |row| row.get(0),
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    if status != "running" {
        return Ok(());
    }
    let updated = now();
    match outcome {
        Ok(filename) => {
            connection
                .execute(
                    "UPDATE batch_jobs
                        SET status = 'completed', result_file = ?2, updated_at = ?3
                      WHERE job_id = ?1 AND status = 'running'",
                    params![job_id, filename, updated],
                )
                .map_err(|e| AppError::new("database", e.to_string()))?;
            connection
                .execute(
                    "UPDATE batch_job_items
                        SET status = 'completed', updated_at = ?2
                      WHERE job_id = ?1 AND status = 'running'",
                    params![job_id, updated],
                )
                .map_err(|e| AppError::new("database", e.to_string()))?;
        }
        Err(error) => {
            connection
                .execute(
                    "UPDATE batch_jobs
                        SET status = 'failed', updated_at = ?2
                      WHERE job_id = ?1 AND status = 'running'",
                    params![job_id, updated],
                )
                .map_err(|e| AppError::new("database", e.to_string()))?;
            connection
                .execute(
                    "UPDATE batch_job_items
                        SET status = 'failed', error = ?2, updated_at = ?3
                      WHERE job_id = ?1 AND status IN ('pending', 'running')",
                    params![job_id, error.message, updated],
                )
                .map_err(|e| AppError::new("database", e.to_string()))?;
        }
    }
    Ok(())
}

pub fn list_jobs(root: &Path) -> Result<Vec<BatchJob>> {
    if !root
        .join(".drama-craft")
        .join("generations.sqlite3")
        .exists()
    {
        return Ok(Vec::new());
    }
    let connection = generation::open_database(root)?;
    let mut statement = connection
        .prepare("SELECT job_id FROM batch_jobs ORDER BY created_at DESC LIMIT 200")
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| AppError::new("database", e.to_string()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let mut jobs = Vec::with_capacity(ids.len());
    for id in ids {
        jobs.push(load_job(&connection, &id)?);
    }
    Ok(jobs)
}

pub fn get_job(root: &Path, job_id: &str) -> Result<BatchJob> {
    load_job(&generation::open_database(root)?, job_id)
}

pub fn cancel_job(root: &Path, job_id: &str) -> Result<BatchJob> {
    let connection = generation::open_database(root)?;
    let stamp = now();
    let changed = connection
        .execute(
            "UPDATE batch_jobs SET status = 'cancelled', updated_at = ?2 WHERE job_id = ?1",
            params![job_id, stamp],
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    if changed == 0 {
        return Err(AppError::new("input", "任务不存在"));
    }
    connection
        .execute(
            "UPDATE batch_job_items
                SET status = 'cancelled', updated_at = ?2
              WHERE job_id = ?1
                AND status IN ('pending', 'scheduled')",
            params![job_id, stamp],
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    refresh_job_status(&connection, job_id)
}

pub fn cancel_item(root: &Path, item_id: &str) -> Result<BatchJob> {
    let connection = generation::open_database(root)?;
    let (job_id, status): (String, String) = connection
        .query_row(
            "SELECT job_id, status FROM batch_job_items WHERE item_id = ?1",
            [item_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| AppError::new("input", "任务明细不存在"))?;
    if !matches!(status.as_str(), "pending" | "scheduled") {
        return Err(AppError::new(
            "input",
            "仅可取消尚未提交到视频服务的分镜明细",
        ));
    }
    let stamp = now();
    connection
        .execute(
            "UPDATE batch_job_items SET status = 'cancelled', updated_at = ?2 WHERE item_id = ?1",
            params![item_id, stamp],
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    refresh_job_status(&connection, &job_id)
}

pub fn sync_jobs(root: &Path) -> Result<Vec<BatchJob>> {
    if !root
        .join(".drama-craft")
        .join("generations.sqlite3")
        .exists()
    {
        return Ok(Vec::new());
    }
    let connection = generation::open_database(root)?;
    let mut statement = connection
        .prepare(
            "SELECT job_id, job_type FROM batch_jobs
              WHERE status IN ('scheduled', 'running') AND job_type IN ('generation', 'audio')
              ORDER BY created_at ASC",
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let ids = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| AppError::new("database", e.to_string()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    for (id, job_type) in &ids {
        let items = load_items(&connection, id)?;
        for item in items {
            if job_type == "audio" {
                let _ = sync_item_from_audio(&connection, &item)?;
            } else {
                let _ = sync_item_from_generation(&connection, &item)?;
            }
        }
        refresh_job_status(&connection, id)?;
    }
    list_jobs(root)
}

pub async fn advance(root: &Path, settings: &GenerationSettings) -> Result<BatchAdvanceResult> {
    let _ = sync_jobs(root)?;

    struct PendingSubmit {
        job_id: String,
        item_id: String,
        input: GenerationInput,
    }

    let pending_submit = {
        let connection = generation::open_database(root)?;
        let mut statement = connection
            .prepare(
                "SELECT job_id, status, scheduled_at FROM batch_jobs
                  WHERE status IN ('scheduled', 'running') AND job_type = 'generation'
                  ORDER BY scheduled_at ASC, created_at ASC",
            )
            .map_err(|e| AppError::new("database", e.to_string()))?;
        let candidates = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| AppError::new("database", e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| AppError::new("database", e.to_string()))?;
        drop(statement);

        let stamp = now();
        let current = Local::now();
        let wait_for_result = has_in_flight_generation(&connection)?;
        let mut chosen: Option<PendingSubmit> = None;
        for (job_id, status, scheduled_at) in candidates {
            if parse_time(&scheduled_at)? > current {
                continue;
            }
            if status == "scheduled" {
                connection
                    .execute(
                        "UPDATE batch_jobs SET status = 'running', updated_at = ?2 WHERE job_id = ?1",
                        params![job_id, stamp],
                    )
                    .map_err(|e| AppError::new("database", e.to_string()))?;
            }
            if wait_for_result {
                refresh_job_status(&connection, &job_id)?;
                continue;
            }
            let pending = connection
                .query_row(
                    &format!(
                        "{ITEM_SELECT}
                          WHERE job_id = ?1 AND status = 'pending'
                          ORDER BY sort_order ASC, created_at ASC
                          LIMIT 1"
                    ),
                    [&job_id],
                    item_row,
                )
                .optional()
                .map_err(|e| AppError::new("database", e.to_string()))?;
            if let Some(item) = pending {
                let document: String = connection
                    .query_row(
                        "SELECT document FROM batch_jobs WHERE job_id = ?1",
                        [&job_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| AppError::new("database", e.to_string()))?;
                chosen = Some(PendingSubmit {
                    job_id,
                    item_id: item.item_id.clone(),
                    input: GenerationInput {
                        document,
                        shot_id: item.shot_id,
                        prompt: item.prompt,
                        duration: item.duration,
                        resolution: item.resolution,
                        seed: item.seed,
                        image_refs: item.image_refs,
                        audio_refs: item.audio_refs,
                    },
                });
                break;
            }
            refresh_job_status(&connection, &job_id)?;
        }
        chosen
    };

    let submitted = if let Some(target) = pending_submit {
        let still_pending = {
            let connection = generation::open_database(root)?;
            connection
                .query_row(
                    "SELECT status FROM batch_job_items WHERE item_id = ?1",
                    [&target.item_id],
                    |row| row.get::<_, String>(0),
                )
                .map(|status| status == "pending")
                .unwrap_or(false)
        };
        if !still_pending {
            None
        } else {
            match generation::submit(root, settings, target.input).await {
                Ok(record) => {
                    let connection = generation::open_database(root)?;
                    let mapped = if record.local_file.is_some() {
                        "completed"
                    } else if matches!(
                        record.status.to_ascii_lowercase().as_str(),
                        "failed" | "error" | "cancelled" | "download_failed"
                    ) {
                        record.status.as_str()
                    } else {
                        "submitted"
                    };
                    let updated = now();
                    connection
                        .execute(
                            "UPDATE batch_job_items
                                SET status = ?2, generation_task_id = ?3, local_file = ?4,
                                    error = ?5, updated_at = ?6
                              WHERE item_id = ?1 AND status = 'pending'",
                            params![
                                target.item_id,
                                mapped,
                                record.task_id,
                                record.local_file,
                                record.error,
                                updated,
                            ],
                        )
                        .map_err(|e| AppError::new("database", e.to_string()))?;
                    refresh_job_status(&connection, &target.job_id)?;
                    load_items(&connection, &target.job_id)?
                        .into_iter()
                        .find(|row| row.item_id == target.item_id)
                }
                Err(error) => {
                    let connection = generation::open_database(root)?;
                    let updated = now();
                    connection
                        .execute(
                            "UPDATE batch_job_items
                                SET status = 'failed', error = ?2, updated_at = ?3
                              WHERE item_id = ?1 AND status = 'pending'",
                            params![target.item_id, error.message, updated],
                        )
                        .map_err(|e| AppError::new("database", e.to_string()))?;
                    refresh_job_status(&connection, &target.job_id)?;
                    load_items(&connection, &target.job_id)?
                        .into_iter()
                        .find(|row| row.item_id == target.item_id)
                }
            }
        }
    } else {
        None
    };

    Ok(BatchAdvanceResult {
        submitted,
        jobs: list_jobs(root)?,
    })
}

pub async fn advance_audio(root: &Path, settings: &AudioSettings) -> Result<BatchAdvanceResult> {
    let _ = sync_jobs(root)?;
    let target = {
        let connection = generation::open_database(root)?;
        let in_flight: i64 = connection.query_row(
            "SELECT COUNT(*) FROM batch_job_items AS items JOIN batch_jobs AS jobs ON jobs.job_id = items.job_id WHERE jobs.job_type = 'audio' AND items.status IN ('submitted', 'running')",
            [], |row| row.get(0),
        ).map_err(|e| AppError::new("database", e.to_string()))?;
        if in_flight > 0 {
            None
        } else {
            let mut statement = connection.prepare(
                "SELECT job_id, status, scheduled_at, document FROM batch_jobs WHERE status IN ('scheduled', 'running') AND job_type = 'audio' ORDER BY scheduled_at ASC, created_at ASC"
            ).map_err(|e| AppError::new("database", e.to_string()))?;
            let jobs = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| AppError::new("database", e.to_string()))?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| AppError::new("database", e.to_string()))?;
            drop(statement);
            let mut selected = None;
            for (job_id, status, scheduled_at, document) in jobs {
                if parse_time(&scheduled_at)? > Local::now() {
                    continue;
                }
                if status == "scheduled" {
                    connection.execute("UPDATE batch_jobs SET status = 'running', updated_at = ?2 WHERE job_id = ?1", params![job_id, now()]).map_err(|e| AppError::new("database", e.to_string()))?;
                }
                let pending = connection.query_row(
                    &format!("{ITEM_SELECT} WHERE job_id = ?1 AND status = 'pending' ORDER BY sort_order ASC, created_at ASC LIMIT 1"),
                    [&job_id], item_row,
                ).optional().map_err(|e| AppError::new("database", e.to_string()))?;
                if let Some(item) = pending {
                    selected = Some((
                        job_id,
                        item.clone(),
                        AudioInput {
                            document,
                            character_id: item.shot_id,
                            character_name: item.shot_title,
                            text: item.prompt,
                            voice_ref: item.audio_refs.first().cloned().unwrap_or_default(),
                            options: if item.resolution.trim().is_empty() {
                                audio::AudioOptions::default()
                            } else {
                                serde_json::from_str(&item.resolution)
                                    .map_err(|_| AppError::new("input", "音频任务参数快照无效"))?
                            },
                        },
                    ));
                    break;
                }
                refresh_job_status(&connection, &job_id)?;
            }
            selected
        }
    };
    let submitted = if let Some((job_id, item, input)) = target {
        match audio::submit(root, settings, input).await {
            Ok(record) => {
                let connection = generation::open_database(root)?;
                let mapped = if record.local_file.is_some() {
                    "completed"
                } else if matches!(
                    record.status.to_ascii_lowercase().as_str(),
                    "failed" | "error" | "cancelled" | "download_failed"
                ) {
                    record.status.as_str()
                } else {
                    "submitted"
                };
                connection.execute("UPDATE batch_job_items SET status = ?2, generation_task_id = ?3, local_file = ?4, error = ?5, updated_at = ?6 WHERE item_id = ?1 AND status = 'pending'", params![item.item_id, mapped, record.task_id, record.local_file, record.error, now()]).map_err(|e| AppError::new("database", e.to_string()))?;
                refresh_job_status(&connection, &job_id)?;
                load_items(&connection, &job_id)?
                    .into_iter()
                    .find(|row| row.item_id == item.item_id)
            }
            Err(error) => {
                let connection = generation::open_database(root)?;
                connection.execute("UPDATE batch_job_items SET status = 'failed', error = ?2, updated_at = ?3 WHERE item_id = ?1 AND status = 'pending'", params![item.item_id, error.message, now()]).map_err(|e| AppError::new("database", e.to_string()))?;
                refresh_job_status(&connection, &job_id)?;
                load_items(&connection, &job_id)?
                    .into_iter()
                    .find(|row| row.item_id == item.item_id)
            }
        }
    } else {
        None
    };
    Ok(BatchAdvanceResult {
        submitted,
        jobs: list_jobs(root)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn sample_item(shot: &str) -> BatchJobItemInput {
        BatchJobItemInput {
            shot_id: shot.into(),
            shot_title: format!("{shot} 标题"),
            prompt: "测试提示词".into(),
            duration: 5,
            resolution: "768p竖(768*1376)".into(),
            seed: None,
            image_refs: vec!["frame.png".into()],
            audio_refs: vec![],
        }
    }

    #[test]
    fn create_cancel_job_and_item() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let job = create_job(
            root,
            CreateBatchJobInput {
                job_type: "generation".into(),
                name: "本集批量生成".into(),
                document: "01.md".into(),
                delay_hours: 2,
                items: vec![sample_item("S001"), sample_item("S002")],
            },
        )
        .unwrap();
        assert_eq!(job.status, "scheduled");
        assert_eq!(job.item_total, 2);
        assert_eq!(job.items.len(), 2);
        assert!(job.items.iter().all(|item| item.status == "pending"));

        let after_item = cancel_item(root, &job.items[0].item_id).unwrap();
        assert_eq!(after_item.items[0].status, "cancelled");
        assert_eq!(after_item.items[1].status, "pending");
        assert_eq!(after_item.status, "scheduled");

        let cancelled = cancel_job(root, &job.job_id).unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled
            .items
            .iter()
            .all(|item| item.status == "cancelled"));
    }

    #[test]
    fn rejects_empty_batch() {
        let dir = tempdir().unwrap();
        let error = create_job(
            dir.path(),
            CreateBatchJobInput {
                job_type: "generation".into(),
                name: "空任务".into(),
                document: "01.md".into(),
                delay_hours: 0,
                items: vec![],
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "input");
    }

    #[test]
    fn creates_audio_job_without_video_fields() {
        let dir = tempdir().unwrap();
        let job = create_job(
            dir.path(),
            CreateBatchJobInput {
                job_type: "audio".into(),
                name: "本集批量音频".into(),
                document: "01.md".into(),
                delay_hours: 0,
                items: vec![BatchJobItemInput {
                    shot_id: "C01".into(),
                    shot_title: "秦墨".into(),
                    prompt: "这是角色台词。".into(),
                    duration: 1,
                    resolution: String::new(),
                    seed: None,
                    image_refs: vec![],
                    audio_refs: vec!["01 音色_秦墨.wav".into()],
                }],
            },
        )
        .unwrap();
        assert_eq!(job.job_type, "audio");
        assert_eq!(job.items[0].shot_title, "秦墨");
        assert_eq!(job.items[0].audio_refs, vec!["01 音色_秦墨.wav"]);
    }

    fn two_shot_job(root: &std::path::Path) -> BatchJob {
        create_job(
            root,
            CreateBatchJobInput {
                job_type: "generation".into(),
                name: "本集批量生成".into(),
                document: "01.md".into(),
                delay_hours: 0,
                items: vec![sample_item("S001"), sample_item("S002")],
            },
        )
        .unwrap()
    }

    fn set_item_status(root: &std::path::Path, shot_id: &str, status: &str) {
        let connection = generation::open_database(root).unwrap();
        connection
            .execute(
                "UPDATE batch_job_items SET status = ?2 WHERE shot_id = ?1",
                params![shot_id, status],
            )
            .unwrap();
    }

    fn dummy_settings() -> GenerationSettings {
        GenerationSettings {
            profile_id: "fixture".into(),
            submit_url: "http://127.0.0.1:1/submit".into(),
            query_url: "http://127.0.0.1:1/result/{task_id}".into(),
            resolutions: vec!["768p竖(768*1376)".into()],
            authorization: String::new(),
        }
    }

    #[test]
    fn advance_does_not_submit_next_while_previous_in_flight() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let job = two_shot_job(root);
        set_item_status(root, "S001", "submitted");
        let advanced = tauri::async_runtime::block_on(advance(root, &dummy_settings())).unwrap();
        assert!(advanced.submitted.is_none());
        let items = get_job(root, &job.job_id).unwrap().items;
        assert_eq!(items[0].status, "submitted");
        assert_eq!(items[1].status, "pending");
    }

    #[test]
    fn advance_submits_next_after_previous_result() {
        use std::{
            io::{Read, Write},
            net::{TcpListener, TcpStream},
        };

        fn read_request(stream: &mut TcpStream) -> String {
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

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut submit, _) = listener.accept().unwrap();
            let submitted = read_request(&mut submit);
            assert!(submitted.starts_with("POST /submit "));
            let body = br#"{"code":"Success","data":{"task_id":"task-2","status":"queued"}}"#;
            write!(
                submit,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            submit.write_all(body).unwrap();
        });

        let dir = tempdir().unwrap();
        let root = crate::storage::canonical_directory(dir.path()).unwrap();
        crate::storage::create_document(&root, "01.md", "# S001\n").unwrap();
        fs::write(root.join("frame.png"), b"synthetic-image").unwrap();
        let job = two_shot_job(&root);
        set_item_status(&root, "S001", "failed");
        let settings = GenerationSettings {
            profile_id: "fixture".into(),
            submit_url: format!("http://{address}/submit"),
            query_url: format!("http://{address}/result/{{task_id}}"),
            resolutions: vec!["768p竖(768*1376)".into()],
            authorization: String::new(),
        };
        let advanced = tauri::async_runtime::block_on(advance(&root, &settings)).unwrap();
        assert_eq!(
            advanced
                .submitted
                .as_ref()
                .map(|item| item.shot_id.as_str()),
            Some("S002")
        );
        let items = get_job(&root, &job.job_id).unwrap().items;
        assert_eq!(items[0].status, "failed");
        assert_eq!(items[1].status, "submitted");
        assert_eq!(items[1].generation_task_id.as_deref(), Some("task-2"));
        server.join().unwrap();
    }

    #[test]
    fn merge_episode_writes_result_and_task_record() {
        let dir = tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("01.md"), "# 一集\n").unwrap();
        let first = root.join("S001.mp4");
        let second = root.join("S002.mp4");
        if !crate::ffmpeg::write_test_clip(&first, 1) || !crate::ffmpeg::write_test_clip(&second, 1)
        {
            panic!("未找到打包的 FFmpeg，请先运行 npm run ffmpeg:download");
        }
        let job = merge_episode(
            &root,
            MergeEpisodeInput {
                document: "01.md".into(),
                name: "合并任务 · 01.md · 2".into(),
                items: vec![
                    MergeShotInput {
                        shot_id: "S001".into(),
                        shot_title: "一".into(),
                        local_file: "S001.mp4".into(),
                        duration: 5,
                        resolution: "480p横".into(),
                    },
                    MergeShotInput {
                        shot_id: "S002".into(),
                        shot_title: "二".into(),
                        local_file: "S002.mp4".into(),
                        duration: 5,
                        resolution: "480p横".into(),
                    },
                ],
            },
        )
        .unwrap();
        assert_eq!(job.job_type, "merge");
        assert_eq!(job.status, "running");
        assert!(job.result_file.is_none());
        let job = wait_merge_job(&root, &job.job_id);
        assert_eq!(job.status, "completed");
        assert_eq!(job.item_completed, 2);
        let filename = job.result_file.expect("result");
        assert!(filename.starts_with("01 merge_"));
        assert!(root.join(&filename).is_file());
        assert_eq!(job.items[0].local_file.as_deref(), Some("S001.mp4"));
        assert_eq!(fs::read_to_string(root.join("01.md")).unwrap(), "# 一集\n");
    }

    #[test]
    fn rejects_second_merge_while_episode_busy() {
        let dir = tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("01.md"), "# 一集\n").unwrap();
        let clip = root.join("S001.mp4");
        if !crate::ffmpeg::write_test_clip(&clip, 1) {
            panic!("未找到打包的 FFmpeg，请先运行 npm run ffmpeg:download");
        }
        let connection = generation::open_database(&root).unwrap();
        let stamp = now();
        connection
            .execute(
                "INSERT INTO batch_jobs
                 (job_id, job_type, name, document, status, scheduled_at, created_at, updated_at)
                 VALUES ('job-busy', 'merge', '占用', '01.md', 'running', ?1, ?1, ?1)",
                params![stamp],
            )
            .unwrap();
        drop(connection);
        let error = merge_episode(
            &root,
            MergeEpisodeInput {
                document: "01.md".into(),
                name: "第二次".into(),
                items: vec![MergeShotInput {
                    shot_id: "S001".into(),
                    shot_title: "一".into(),
                    local_file: "S001.mp4".into(),
                    duration: 5,
                    resolution: "480p横".into(),
                }],
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "busy");
    }

    fn wait_merge_job(root: &std::path::Path, job_id: &str) -> BatchJob {
        for _ in 0..400 {
            let job = get_job(root, job_id).unwrap();
            if !matches!(job.status.as_str(), "running" | "scheduled") {
                return job;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("merge job did not finish");
    }
}
