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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    pub format_version: u32,
    pub layout: String,
    #[serde(default)]
    pub libraries: ProjectLibraries,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLibraries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub characters: Option<String>,
    #[serde(default)]
    pub voices: String,
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
    let text = std::str::from_utf8(&bytes).map_err(|_| {
        AppError::new(
            "encoding",
            "文件不是 UTF-8，未做任何修改；请先转换为 UTF-8 编码",
        )
    })?;
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
            "磁盘文件已改变，请先复制编辑内容备份，再重新读取磁盘版本",
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
fn metadata_paths(root: &Path) -> Result<(PathBuf, PathBuf)> {
    let dir = root.join(".drama-craft");
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::new("path", "项目元数据目录不能是链接"));
    }
    let file = dir.join("project.json");
    if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::new("path", "项目元数据文件不能是链接"));
    }
    Ok((dir, file))
}
fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| allowed.iter().any(|item| value.eq_ignore_ascii_case(item)))
}
fn validate_library(path: &Path, allowed: &[&str], label: &str) -> Result<PathBuf> {
    if path.as_os_str().is_empty() {
        return Err(AppError::new("library", format!("{label}目录不能为空")));
    }
    let path = canonical_directory(path)?;
    let matched = WalkDir::new(&path)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .any(|entry| entry.file_type().is_file() && has_extension(entry.path(), allowed));
    if !matched {
        return Err(AppError::new(
            "library",
            format!("{label}目录中没有支持的素材文件"),
        ));
    }
    Ok(path)
}

pub(crate) fn regular_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_owned();
        }
    }
    value.into_owned()
}

pub fn load_project(root: &Path) -> Result<(ProjectMeta, Option<String>)> {
    let (_, file) = metadata_paths(root)?;
    if file.exists() {
        let metadata: ProjectMeta = serde_json::from_slice(&fs::read(file)?)?;
        if metadata.format_version != 1 {
            return Err(AppError::new(
                "version",
                "项目格式版本不受支持，请使用兼容版本的客户端",
            ));
        }
        if metadata.libraries.voices.is_empty() {
            return Err(AppError::new(
                "project_setup",
                "此项目尚未配置声音目录，请先选择后再导入",
            ));
        }
        validate_library(
            Path::new(&metadata.libraries.voices),
            &["mp3", "wav", "flac", "ogg", "m4a", "mp4"],
            "声音",
        )?;
        if let Some(characters) = &metadata.libraries.characters {
            validate_library(
                Path::new(characters),
                &["png", "jpg", "jpeg", "webp", "gif", "bmp", "txt", "md"],
                "角色",
            )?;
        }
        return Ok((metadata, None));
    }
    Err(AppError::new(
        "project_setup",
        "此项目尚未配置声音目录，请先选择后再导入",
    ))
}
fn fresh_metadata(root: &Path, libraries: ProjectLibraries) -> ProjectMeta {
    ProjectMeta {
        id: Uuid::new_v4().to_string(),
        name: root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        format_version: 1,
        layout: "preserve".into(),
        libraries,
    }
}
pub fn configure_project(
    root: &Path,
    character_source: Option<&Path>,
    voice_source: &Path,
) -> Result<ProjectMeta> {
    let (dir, file) = metadata_paths(root)?;
    let root = fs::canonicalize(root)?;
    let voices = validate_library(
        voice_source,
        &["mp3", "wav", "flac", "ogg", "m4a", "mp4"],
        "声音",
    )?;
    let characters = character_source
        .map(|source| {
            validate_library(
                source,
                &["png", "jpg", "jpeg", "webp", "gif", "bmp", "txt", "md"],
                "角色",
            )
        })
        .transpose()?;
    let libraries = ProjectLibraries {
        characters: characters.as_deref().map(regular_path),
        voices: regular_path(&voices),
    };
    let existing = if file.exists() {
        let metadata: ProjectMeta = serde_json::from_slice(&fs::read(&file)?)?;
        if !metadata.libraries.voices.is_empty() {
            return Err(AppError::new("library", "项目素材库已经配置"));
        }
        Some(metadata)
    } else {
        None
    };
    fs::create_dir_all(&dir)?;
    let metadata = existing
        .map(|mut value| {
            value.libraries = libraries.clone();
            value
        })
        .unwrap_or_else(|| fresh_metadata(&root, libraries));
    atomic_write(
        &file,
        &serde_json::to_vec_pretty(&metadata)?,
        !file.exists(),
    )?;
    Ok(metadata)
}
pub fn create_project(
    parent: &Path,
    name: &str,
    character_source: Option<&Path>,
    voice_source: &Path,
) -> Result<PathBuf> {
    validate_name(name)?;
    if ignored(name) {
        return Err(AppError::new("name", "请选择非隐藏项目名称"));
    }
    let root = canonical_directory(parent)?.join(name);
    fs::create_dir(&root)?; // Deliberately fails if the directory already exists.
    let root = fs::canonicalize(root)?;
    configure_project(&root, character_source, voice_source)?;
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
    let agents_content = agents_md(
        name,
        character_source.map(|p| p.to_string_lossy().into_owned()),
        &voice_source.to_string_lossy(),
    );
    create_document(&root, "AGENTS.md", &agents_content)?;
    Ok(root)
}

fn agents_md(
    project_name: &str,
    character_directory: Option<String>,
    voice_directory: &str,
) -> String {
    let char_dir = character_directory.as_deref().unwrap_or("未配置");
    format!(
        r#"# {project_name}

> 本文件由 DramaCraft 自动生成，供第三方编辑器（Cursor、Codex、Claude 等）
> 识别项目结构并辅助创作剧本。请勿删除；可按需补充项目特有的约束。

## 项目用途

本目录是一个 **DramaCraft 短剧项目**。
工作流：在本目录中用 Markdown 编写故事大纲与分集剧本 →
在 DramaCraft 客户端打开目录，进入故事板，配置视频 API 后直接生成视频。

## 目录结构

```
{project_name}/
├── .drama-craft/          # 项目元数据（勿手动编辑）
│   └── project.json
├── AGENTS.md              # 本文件 — 项目结构说明
├── 剧本大纲.md            # 故事大纲、角色设计、分集规划
├── 分镜总表.md            # 全剧分镜索引
└── E01-集名.md …          # 各集剧本（按需创建）
```

## 素材库

- 角色图目录：`{char_dir}`
- 声音样本目录：`{voice_directory}`

## 创作指南

### 1. 故事大纲（剧本大纲.md）

已包含以下章节，请逐项填写：

- **故事背景**：世界观、时代、基本设定
- **人物与目标**：主要角色及其性格、动机、关系
- **完整故事**：完整故事梗概（3–5 段）
- **分集规划**：每集核心事件与转折

### 2. 分集剧本格式（v1）

每集为独立 `.md` 文件。**首行必须**是：

```
<!-- drama-craft:episode:v1 -->
```

紧接一级标题 `# 第01集 集名`，之后依次是：

1. `本集内容：` — 一段话概括本集
2. `## 角色绑定` — 表格列：`角色ID | 名称 | 角色图 | 音色文件 | 使用镜号`
   - 角色 ID 用 `C001`，旁白用 `N001`；同一作品跨集保持 ID 一致
3. `## 本集使用素材` — 表格列：`素材ID | 名称 | 类型 | 文件 | 使用镜号`
   - 类型写场景、道具或状态变体
4. `## 本集声音安排` — 表格列：`镜号 | 角色ID | 发声方式 | 台词 | 发声区间`
   - 发声方式写画内、画外或旁白
5. 分镜区 — 每镜以 `## S001 镜头名` 开头

### 3. 分镜结构

```markdown
## S001 镜头名

角色：C001、N001

### 故事走向

描述本镜动作和剧情变化（纯文本段落）。

### 首帧生成

出图文件名：`01 首帧_S001.png`。

**首帧图片提示词**

\```text
场景与角色的静态画面描述。
\```

### 视频生成

视频文件名：`01 S001.mp4`。

| API参数 | 提示词标签 | 上传素材 |
|---|---|---|
| `ref_image_0` | `<Picture 1>` | `01 首帧_S001.png` |

**视频提示词｜duration=5，resolution=480p横**

\```text
<Picture 1>：本镜完整首帧。
动作、摄影机行为与声音描述。
\```
```

### 4. 格式要点

- 使用镜号逐项列出（`S001、S002`），不用范围缩写
- 路径写在行内代码或 Markdown 链接内，空项用 `—`
- 不得凭空编造已存在的素材文件名
- 首帧标签固定为 `**首帧图片提示词**`
- 视频标签固定为 `**视频提示词｜duration=N，resolution=WxH**`
- 标签后紧跟一个 `text` 代码围栏，围栏内为完整提示词

## 注意事项

- Markdown 是唯一的编辑源，所有剧本内容保存在 `.md` 文件中
- 不要手动编辑 `.drama-craft/` 目录下的文件
- 分镜 ID 在同一集内不可重复
- 角色 ID 跨集保持一致
"#
    )
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
