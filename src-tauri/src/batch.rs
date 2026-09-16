use crate::generation::{self, GenerationInput, GenerationSettings};
use crate::storage::{AppError, Result};
use chrono::{DateTime, Local, SecondsFormat};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
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
    }
}

fn load_job(connection: &rusqlite::Connection, job_id: &str) -> Result<BatchJob> {
    let (job_type, name, document, status, scheduled_at, created_at, updated_at) = connection
        .query_row(
            "SELECT job_type, name, document, status, scheduled_at, created_at, updated_at
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
    ))
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

pub fn create_job(root: &Path, input: CreateBatchJobInput) -> Result<BatchJob> {
    if !matches!(input.job_type.as_str(), "generation" | "merge") {
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
        if item.prompt.trim().is_empty() || item.prompt.chars().count() > 10_000 {
            return Err(AppError::new(
                "input",
                format!("{} 的视频提示词无效", item.shot_id),
            ));
        }
        if !(1..=15).contains(&item.duration) {
            return Err(AppError::new(
                "input",
                format!("{} 的时长须为 1—15 秒", item.shot_id),
            ));
        }
        if item.image_refs.is_empty() || item.image_refs.len() > 9 || item.audio_refs.len() > 3 {
            return Err(AppError::new(
                "input",
                format!("{} 需要 1—9 张参考图，最多 3 段参考音频", item.shot_id),
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
            "SELECT job_id FROM batch_jobs
              WHERE status IN ('scheduled', 'running')
              ORDER BY created_at ASC",
        )
        .map_err(|e| AppError::new("database", e.to_string()))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| AppError::new("database", e.to_string()))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| AppError::new("database", e.to_string()))?;
    for id in &ids {
        let items = load_items(&connection, id)?;
        for item in items {
            let _ = sync_item_from_generation(&connection, &item)?;
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
                  WHERE status IN ('scheduled', 'running')
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

#[cfg(test)]
mod tests {
    use super::*;
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
}
