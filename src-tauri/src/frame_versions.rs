use crate::{
    generation,
    storage::{self, AppError, Result},
};
use chrono::{Local, SecondsFormat};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameVersion {
    pub id: String,
    pub archived_reference: String,
    pub archived_at: String,
}

fn database(root: &Path) -> Result<Connection> {
    let connection = generation::open_database(root)?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS frame_versions (
           id TEXT PRIMARY KEY,
           document TEXT NOT NULL,
           shot_id TEXT NOT NULL,
           reference TEXT NOT NULL,
           archived_reference TEXT NOT NULL,
           archived_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS frame_versions_shot
           ON frame_versions(document, shot_id, reference, archived_at DESC);",
        )
        .map_err(db_error)?;
    Ok(connection)
}

fn db_error(error: rusqlite::Error) -> AppError {
    AppError::new("database", error.to_string())
}

fn validate_shot(shot_id: &str) -> Result<()> {
    if !shot_id.starts_with('S')
        || !shot_id[1..].chars().all(|c| c.is_ascii_digit())
        || shot_id.len() < 2
    {
        return Err(AppError::new("input", "镜号无效"));
    }
    Ok(())
}

fn frame_path(root: &Path, document: &str, reference: &str) -> Result<PathBuf> {
    let doc = storage::document_path(root, document, true)?;
    let relative = Path::new(reference);
    if reference.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AppError::new("path", "首帧必须使用项目内相对图片路径"));
    }
    for part in relative.components() {
        storage::validate_name(&part.as_os_str().to_string_lossy())?;
    }
    let extension = relative
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"
    ) {
        return Err(AppError::new("media", "首帧文件必须是图片"));
    }
    let path = doc
        .parent()
        .ok_or_else(|| AppError::new("path", "文档缺少父目录"))?
        .join(relative);
    let target_parent = path
        .parent()
        .ok_or_else(|| AppError::new("path", "首帧缺少父目录"))?;
    let mut existing_parent = target_parent;
    while !existing_parent.exists() {
        existing_parent = existing_parent
            .parent()
            .ok_or_else(|| AppError::new("path", "首帧缺少父目录"))?;
    }
    let parent = fs::canonicalize(existing_parent)?;
    if !parent.starts_with(root) {
        return Err(AppError::new("path", "首帧路径超出项目目录"));
    }
    if fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(AppError::new("path", "首帧不能是链接文件"));
    }
    Ok(path)
}

fn new_archive(path: &Path) -> Result<(PathBuf, String)> {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::new("path", "首帧文件名无效"))?;
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let stamp = Local::now().format("%Y%m%d-%H%M%S-%3f");
    let name = format!(
        "{stem}__{stamp}_{}.{}",
        &Uuid::new_v4().simple().to_string()[..8],
        ext
    );
    storage::validate_name(&name)?;
    Ok((path.with_file_name(&name), name))
}

fn archive_path(
    root: &Path,
    document: &str,
    reference: &str,
    archived_reference: &str,
) -> Result<PathBuf> {
    let current = frame_path(root, document, reference)?;
    let archived = frame_path(root, document, archived_reference)?;
    let stem = current
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let name = archived
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let suffix = name.strip_prefix(&format!("{stem}__")).unwrap_or("");
    let timestamp = suffix.get(..19).unwrap_or("");
    let archive_id = suffix.get(20..28).unwrap_or("");
    let extension = current
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("");
    if archived.parent() != current.parent()
        || archived.extension() != current.extension()
        || timestamp.len() != 19
        || !timestamp.chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 15) {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        })
        || !suffix.get(19..).unwrap_or("").starts_with('_')
        || archive_id.len() != 8
        || !archive_id.chars().all(|c| c.is_ascii_hexdigit())
        || suffix.get(28..) != Some(format!(".{extension}").as_str())
    {
        return Err(AppError::new("history", "历史首帧路径无效"));
    }
    Ok(archived)
}

fn archive_current(path: &Path) -> Result<Option<(PathBuf, String, bool)>> {
    if !path.exists() {
        return Ok(None);
    }
    let (archived, name) = new_archive(path)?;
    if fs::rename(path, &archived).is_ok() {
        return Ok(Some((archived, name, true)));
    }
    let mut source = fs::File::open(path)?;
    let mut target = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&archived)?;
    let copied = std::io::copy(&mut source, &mut target).and_then(|_| target.sync_all());
    if let Err(error) = copied {
        drop(target);
        let _ = fs::remove_file(&archived);
        return Err(error.into());
    }
    Ok(Some((archived, name, false)))
}

fn apply_bytes(
    path: &Path,
    bytes: &[u8],
    archived: &Option<(PathBuf, String, bool)>,
) -> Result<()> {
    if archived.as_ref().is_some_and(|(_, _, renamed)| *renamed) || !path.exists() {
        storage::atomic_write(path, bytes, true)
    } else {
        storage::replace_file(path, bytes)
    }
}

fn rollback(path: &Path, archived: &Option<(PathBuf, String, bool)>) -> Result<()> {
    if let Some((history, _, renamed)) = archived {
        if *renamed {
            if path.exists() {
                fs::remove_file(path)?;
            }
            fs::rename(history, path)?;
        } else {
            let bytes = fs::read(history)?;
            storage::replace_file(path, &bytes)?;
            fs::remove_file(history)?;
        }
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn history(
    root: &Path,
    document: &str,
    shot_id: &str,
    reference: &str,
) -> Result<Vec<FrameVersion>> {
    validate_shot(shot_id)?;
    frame_path(root, document, reference)?;
    let connection = database(root)?;
    let mut statement = connection
        .prepare(
            "SELECT id, archived_reference, archived_at FROM frame_versions
         WHERE document = ?1 AND shot_id = ?2 AND reference = ?3
         ORDER BY archived_at DESC, rowid DESC",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![document, shot_id, reference], |row| {
            Ok(FrameVersion {
                id: row.get(0)?,
                archived_reference: row.get(1)?,
                archived_at: row.get(2)?,
            })
        })
        .map_err(db_error)?;
    let versions = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(db_error)?;
    for version in &versions {
        archive_path(root, document, reference, &version.archived_reference)?;
    }
    Ok(versions)
}

pub fn replace(
    root: &Path,
    document: &str,
    shot_id: &str,
    reference: &str,
    source: &str,
) -> Result<storage::Media> {
    validate_shot(shot_id)?;
    let path = frame_path(root, document, reference)?;
    let source = fs::canonicalize(source)?;
    if !source.is_file() {
        return Err(AppError::new("media", "请选择图片文件"));
    }
    let source_ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let target_ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if source_ext != target_ext
        && !(source_ext == "jpeg" && target_ext == "jpg")
        && !(source_ext == "jpg" && target_ext == "jpeg")
    {
        return Err(AppError::new("media", "所选图片格式须与首帧文件名一致"));
    }
    if fs::canonicalize(&path).ok().as_ref() == Some(&source) {
        return storage::resolve_media(root, document, reference);
    }
    let bytes = fs::read(source)?;
    fs::create_dir_all(
        path.parent()
            .ok_or_else(|| AppError::new("path", "首帧缺少父目录"))?,
    )?;
    if !fs::canonicalize(path.parent().unwrap())?.starts_with(root) {
        return Err(AppError::new("path", "首帧路径超出项目目录"));
    }
    let mut connection = database(root)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let archived = archive_current(&path)?;
    let result = (|| -> Result<()> {
        apply_bytes(&path, &bytes, &archived)?;
        if let Some((_, name, _)) = &archived {
            let now = Local::now().to_rfc3339_opts(SecondsFormat::Millis, false);
            let archived_reference = Path::new(reference)
                .with_file_name(name)
                .to_string_lossy()
                .replace('\\', "/");
            transaction.execute(
                "INSERT INTO frame_versions (id, document, shot_id, reference, archived_reference, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![Uuid::new_v4().to_string(), document, shot_id, reference, archived_reference, now],
            ).map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    })();
    if let Err(error) = result {
        if let Err(rollback_error) = rollback(&path, &archived) {
            return Err(AppError::new(
                "conflict",
                format!(
                    "{}; 回滚首帧失败：{}",
                    error.message, rollback_error.message
                ),
            ));
        }
        return Err(error);
    }
    storage::resolve_media(root, document, reference)
}

pub fn restore(
    root: &Path,
    document: &str,
    shot_id: &str,
    reference: &str,
    version_id: &str,
) -> Result<storage::Media> {
    validate_shot(shot_id)?;
    let path = frame_path(root, document, reference)?;
    let mut connection = database(root)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let archived_reference: String = transaction.query_row(
        "SELECT archived_reference FROM frame_versions WHERE id = ?1 AND document = ?2 AND shot_id = ?3 AND reference = ?4",
        params![version_id, document, shot_id, reference], |row| row.get(0),
    ).map_err(|_| AppError::new("history", "历史版本不存在或不属于当前镜头"))?;
    let selected = archive_path(root, document, reference, &archived_reference)?;
    if !selected.is_file() {
        return Err(AppError::new("history", "历史图片文件不存在"));
    }
    let bytes = fs::read(&selected)?;
    let archived = archive_current(&path)?;
    let result = (|| -> Result<()> {
        apply_bytes(&path, &bytes, &archived)?;
        if let Some((_, name, _)) = &archived {
            let now = Local::now().to_rfc3339_opts(SecondsFormat::Millis, false);
            let new_reference = Path::new(reference)
                .with_file_name(name)
                .to_string_lossy()
                .replace('\\', "/");
            transaction.execute(
                "INSERT INTO frame_versions (id, document, shot_id, reference, archived_reference, archived_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![Uuid::new_v4().to_string(), document, shot_id, reference, new_reference, now],
            ).map_err(db_error)?;
        }
        transaction
            .execute(
                "DELETE FROM frame_versions WHERE id = ?1",
                params![version_id],
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)
    })();
    if let Err(error) = result {
        if let Err(rollback_error) = rollback(&path, &archived) {
            return Err(AppError::new(
                "conflict",
                format!(
                    "{}; 回滚首帧失败：{}",
                    error.message, rollback_error.message
                ),
            ));
        }
        return Err(error);
    }
    let _ = fs::remove_file(selected);
    storage::resolve_media(root, document, reference)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_and_restore_swap_current_with_archived_version() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("01 测试.md"), "# 测试\n").unwrap();
        let first = root.join("incoming-a.png");
        let second = root.join("incoming-b.png");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let reference = "01 首帧_S0001.png";
        replace(
            &root,
            "01 测试.md",
            "S0001",
            reference,
            first.to_str().unwrap(),
        )
        .unwrap();
        assert!(history(&root, "01 测试.md", "S0001", reference)
            .unwrap()
            .is_empty());
        replace(
            &root,
            "01 测试.md",
            "S0001",
            reference,
            second.to_str().unwrap(),
        )
        .unwrap();
        let versions = history(&root, "01 测试.md", "S0001", reference).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(
            fs::read(root.join(&versions[0].archived_reference)).unwrap(),
            b"first"
        );
        assert_eq!(fs::read(root.join(reference)).unwrap(), b"second");
        assert!(history(&root, "01 测试.md", "S0002", reference)
            .unwrap()
            .is_empty());
        let old_id = versions[0].id.clone();
        let old_path = root.join(&versions[0].archived_reference);
        restore(&root, "01 测试.md", "S0001", reference, &old_id).unwrap();
        let versions = history(&root, "01 测试.md", "S0001", reference).unwrap();
        assert_eq!(versions.len(), 1);
        assert_ne!(versions[0].id, old_id);
        assert!(!old_path.exists());
        assert_eq!(fs::read(root.join(reference)).unwrap(), b"first");
        assert_eq!(
            fs::read(root.join(&versions[0].archived_reference)).unwrap(),
            b"second"
        );
        assert_eq!(
            fs::read_to_string(root.join("01 测试.md")).unwrap(),
            "# 测试\n"
        );
        assert_eq!(fs::read(first).unwrap(), b"first");
        assert_eq!(fs::read(second).unwrap(), b"second");
    }

    #[test]
    fn rejects_unsafe_frame_references() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("01.md"), "# 测试\n").unwrap();
        assert_eq!(
            frame_path(&root, "01.md", "../escape.png")
                .unwrap_err()
                .code,
            "path"
        );
        assert_eq!(
            frame_path(&root, "01.md", "frame.mp4").unwrap_err().code,
            "media"
        );
    }
}
