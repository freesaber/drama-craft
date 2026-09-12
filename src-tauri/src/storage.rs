use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}
impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new("io", e.to_string())
    }
}
impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new("metadata", e.to_string())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub format_version: u32,
    pub layout: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub path: String,
    pub name: String,
}
#[derive(Serialize)]
pub struct Scan {
    pub documents: Vec<Document>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub text: String,
    pub hash: String,
    pub readonly: bool,
}
#[derive(Serialize)]
pub struct Candidate {
    pub name: String,
    pub path: String,
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"))
}
fn ignored(name: &str) -> bool {
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist")
}
pub fn canonical_directory(path: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(path)?;
    if !root.is_dir() {
        return Err(AppError::new("path", "请选择文件夹"));
    }
    Ok(root)
}
pub fn scan(root: &Path) -> Result<Scan> {
    let mut documents = Vec::new();
    let mut warnings = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !ignored(&e.file_name().to_string_lossy()))
    {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                warnings.push(e.to_string());
                continue;
            }
        };
        if entry.file_type().is_symlink() {
            continue;
        }
        if entry.file_type().is_file() && is_markdown(entry.path()) {
            documents.push(Document {
                path: entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| AppError::new("path", "项目路径无效"))?
                    .to_string_lossy()
                    .replace('\\', "/"),
                name: entry.file_name().to_string_lossy().into_owned(),
            });
        }
    }
    documents.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Scan {
        documents,
        warnings,
    })
}
pub fn candidates(root: &Path) -> Result<Vec<Candidate>> {
    let mut result = Vec::new();
    for item in fs::read_dir(root)? {
        let item = item?;
        if !item.file_type()?.is_dir() || ignored(&item.file_name().to_string_lossy()) {
            continue;
        }
        let path = item.path();
        if path.join(".drama-craft/project.json").exists() || direct_markdown(&path)? {
            result.push(Candidate {
                name: item.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}
pub fn direct_markdown(root: &Path) -> Result<bool> {
    for item in fs::read_dir(root)? {
        let item = item?;
        if item.file_type()?.is_file()
            && is_markdown(&item.path())
            && !item.file_name().eq_ignore_ascii_case("AGENTS.md")
            && !item.file_name().eq_ignore_ascii_case("README.md")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

// Resolve existing files and new leaf names through their canonical parent.
// No writes are allowed into metadata, hidden paths, or linked directories.
pub fn document_path(root: &Path, relative: &str, existing: bool) -> Result<PathBuf> {
    let rel = Path::new(relative);
    if rel.as_os_str().is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(AppError::new("path", "文档路径必须位于当前项目内"));
    }
    for part in rel.components() {
        let name = part.as_os_str().to_string_lossy();
        validate_name(&name)?;
        if ignored(&name) {
            return Err(AppError::new("path", "不能访问隐藏或应用管理目录"));
        }
    }
    if !is_markdown(rel) {
        return Err(AppError::new("path", "仅支持 Markdown 文档"));
    }
    let target = root.join(rel);
    let parent = fs::canonicalize(
        target
            .parent()
            .ok_or_else(|| AppError::new("path", "缺少父目录"))?,
    )?;
    if !parent.starts_with(root) {
        return Err(AppError::new("path", "路径超出项目目录"));
    }
    // Reject reparse/symlink components, even when their targets remain in the project.
    let mut current = root.to_path_buf();
    for part in rel.components() {
        current.push(part.as_os_str());
        if let Ok(meta) = fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(AppError::new("path", "不写入链接文件或链接目录"));
            }
        }
    }
    if existing {
        let canonical = fs::canonicalize(&target)?;
        if !canonical.starts_with(root) || !canonical.is_file() {
            return Err(AppError::new("path", "无效文档路径"));
        }
    }
    Ok(target)
}
pub fn validate_name(name: &str) -> Result<()> {
    let stem = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if name.is_empty()
        || name.len() > 240
        || name.ends_with([' ', '.'])
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || reserved
        || name == "."
        || name == ".."
    {
        return Err(AppError::new(
            "name",
            "名称包含 Windows 不支持的字符或保留名称",
        ));
    }
    Ok(())
}
pub fn read_document(root: &Path, relative: &str) -> Result<Snapshot> {
    let path = document_path(root, relative, true)?;
    let bytes = fs::read(&path)?;
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| AppError::new("encoding", "文件不是 UTF-8，未做任何修改；请先另存为 UTF-8"))?;
    Ok(Snapshot {
        text: text.trim_start_matches('\u{feff}').replace("\r\n", "\n"),
        hash: hash(&bytes),
        readonly: fs::metadata(path)?.permissions().readonly(),
    })
}
pub fn atomic_write(path: &Path, bytes: &[u8], new_only: bool) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("path", "缺少父目录"))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    if new_only {
        temp.persist_noclobber(path)
            .map_err(|e| AppError::from(e.error))?;
    } else {
        temp.persist(path).map_err(|e| AppError::from(e.error))?;
    }
    Ok(())
}
pub fn save_document(
    root: &Path,
    relative: &str,
    text: &str,
    expected_hash: &str,
) -> Result<Snapshot> {
    let path = document_path(root, relative, false)?;
    let original = fs::read(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::new("conflict", "文件已被删除或移动，请另存编辑内容")
        } else {
            e.into()
        }
    })?;
    if hash(&original) != expected_hash {
        return Err(AppError::new(
            "conflict",
            "磁盘文件已改变，请重新读取或将编辑内容另存为新文档",
        ));
    }
    if fs::metadata(&path)?.permissions().readonly() {
        return Err(AppError::new("readonly", "文档为只读，未保存"));
    }
    let old =
        std::str::from_utf8(&original).map_err(|_| AppError::new("encoding", "文件不是 UTF-8"))?;
    let mut output = text.replace("\r\n", "\n");
    if old.contains("\r\n") {
        output = output.replace('\n', "\r\n");
    }
    if old.starts_with('\u{feff}') {
        output.insert(0, '\u{feff}');
    }
    atomic_write(&path, output.as_bytes(), false)?;
    read_document(root, relative)
}
pub fn create_document(root: &Path, relative: &str, text: &str) -> Result<Snapshot> {
    let path = document_path(root, relative, false)?;
    atomic_write(&path, text.replace("\r\n", "\n").as_bytes(), true)?;
    read_document(root, relative)
}
pub fn load_project(root: &Path) -> Result<(ProjectMeta, Option<String>)> {
    let dir = root.join(".drama-craft");
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::new("path", "项目元数据目录不能是链接"));
    }
    let file = dir.join("project.json");
    if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::new("path", "项目元数据文件不能是链接"));
    }
    if file.exists() {
        let metadata: ProjectMeta = serde_json::from_slice(&fs::read(file)?)?;
        if metadata.format_version != 1 {
            return Err(AppError::new(
                "version",
                "项目格式版本不受支持，请使用兼容版本的客户端",
            ));
        }
        return Ok((metadata, None));
    }
    let metadata = ProjectMeta {
        id: Uuid::new_v4().to_string(),
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        format_version: 1,
        layout: "preserve".into(),
    };
    let initialize = || -> Result<()> {
        fs::create_dir_all(&dir)?;
        atomic_write(&file, &serde_json::to_vec_pretty(&metadata)?, true)
    };
    let warning = initialize().err().map(|e| {
        format!(
            "无法保存项目标识，本次仍可浏览；项目可能只读：{}",
            e.message
        )
    });
    Ok((metadata, warning))
}
pub fn create_project(parent: &Path, name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    if ignored(name) {
        return Err(AppError::new("name", "请选择非隐藏项目名称"));
    }
    let root = canonical_directory(parent)?.join(name);
    fs::create_dir(&root)?; // Deliberately fails if the directory already exists.
    let root = fs::canonicalize(root)?;
    let (_, warning) = load_project(&root)?;
    if let Some(warning) = warning {
        return Err(AppError::new("io", warning));
    }
    create_document(
        &root,
        "剧本大纲.md",
        "# 故事大纲\n\n## 故事背景\n\n## 人物与目标\n\n## 完整故事\n\n## 分集规划\n",
    )?;
    create_document(
        &root,
        "分镜总表.md",
        "# 分镜总表\n\n| 镜号 | 集 | 镜头名 | 秒数 | 备注 |\n|---|---|---|---:|---|\n",
    )?;
    Ok(root)
}

#[derive(Serialize)]
pub struct Media {
    pub reference: String,
    pub path: Option<String>,
    pub exists: bool,
    pub kind: String,
}
pub fn resolve_media(root: &Path, document: &str, reference: &str) -> Result<Media> {
    let doc = document_path(root, document, true)?;
    let value = reference
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    let path = Path::new(value);
    let kind = match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => "image",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" => "audio",
        "mp4" | "webm" | "mov" => "video",
        _ => return Err(AppError::new("media", "仅可读取本地图片、音频和视频")),
    };
    if value.contains("://") || value.starts_with("\\\\") || value.starts_with("//") {
        return Err(AppError::new("media", "P0 不加载远程或网络共享素材"));
    }
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        doc.parent().unwrap().join(path)
    };
    let resolved = fs::canonicalize(&full).ok().filter(|p| p.is_file());
    Ok(Media {
        reference: reference.into(),
        exists: resolved.is_some(),
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        kind: kind.into(),
    })
}
