use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
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
        .max_depth(1)
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

const SHOT_FLAGS_FILE: &str = "shot-flags.json";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShotFlags {
    #[serde(default = "shot_flags_version")]
    format_version: u32,
    #[serde(default)]
    discarded: BTreeMap<String, Vec<String>>,
}

fn shot_flags_version() -> u32 {
    1
}

fn shot_flags_path(root: &Path) -> Result<PathBuf> {
    let (dir, _) = metadata_paths(root)?;
    fs::create_dir_all(&dir)?;
    let file = dir.join(SHOT_FLAGS_FILE);
    if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(AppError::new("path", "项目元数据文件不能是链接"));
    }
    Ok(file)
}

fn document_flag_key(root: &Path, relative: &str) -> Result<String> {
    document_path(root, relative, true)?;
    Ok(relative.replace('\\', "/"))
}

fn validate_shot_id(shot_id: &str) -> Result<String> {
    let trimmed = shot_id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || trimmed.chars().any(|c| c.is_control() || "/\\".contains(c))
    {
        return Err(AppError::new("input", "分镜编号无效"));
    }
    Ok(trimmed.to_owned())
}

fn load_shot_flags(root: &Path) -> Result<ShotFlags> {
    let file = shot_flags_path(root)?;
    if !file.exists() {
        return Ok(ShotFlags {
            format_version: 1,
            discarded: BTreeMap::new(),
        });
    }
    let flags: ShotFlags = serde_json::from_slice(&fs::read(&file)?)?;
    if flags.format_version != 1 {
        return Err(AppError::new(
            "version",
            "项目格式版本不受支持，请使用兼容版本的客户端",
        ));
    }
    Ok(flags)
}

fn save_shot_flags(root: &Path, flags: &ShotFlags) -> Result<()> {
    atomic_write(
        &shot_flags_path(root)?,
        &serde_json::to_vec_pretty(flags)?,
        false,
    )
}

fn discarded_for(flags: &ShotFlags, document: &str) -> Vec<String> {
    flags.discarded.get(document).cloned().unwrap_or_default()
}

pub fn list_discarded_shots(root: &Path, document: &str) -> Result<Vec<String>> {
    let key = document_flag_key(root, document)?;
    Ok(discarded_for(&load_shot_flags(root)?, &key))
}

pub fn set_shot_discarded(
    root: &Path,
    document: &str,
    shot_id: &str,
    discarded: bool,
) -> Result<Vec<String>> {
    let key = document_flag_key(root, document)?;
    let shot_id = validate_shot_id(shot_id)?;
    let mut flags = load_shot_flags(root)?;
    let mut ids: BTreeSet<String> = discarded_for(&flags, &key).into_iter().collect();
    if discarded {
        ids.insert(shot_id);
    } else {
        ids.remove(&shot_id);
    }
    let next: Vec<String> = ids.into_iter().collect();
    if next.is_empty() {
        flags.discarded.remove(&key);
    } else {
        flags.discarded.insert(key.clone(), next.clone());
    }
    flags.format_version = 1;
    save_shot_flags(root, &flags)?;
    Ok(next)
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

pub fn rename_project(root: &Path, name: &str, rename_folder: bool) -> Result<PathBuf> {
    validate_name(name)?;
    if ignored(name) {
        return Err(AppError::new("name", "请选择非隐藏项目名称"));
    }
    let root = fs::canonicalize(root)?;
    let destination = root
        .parent()
        .ok_or_else(|| AppError::new("rename", "项目目录没有可用的父目录"))?
        .join(name);
    if rename_folder && destination.exists() {
        return Err(AppError::new("rename", "目标文件夹已存在"));
    }
    let (_, metadata_file) = metadata_paths(&root)?;
    let mut metadata: ProjectMeta = serde_json::from_slice(&fs::read(&metadata_file)?)?;
    metadata.name = name.to_owned();
    atomic_write(
        &metadata_file,
        &serde_json::to_vec_pretty(&metadata)?,
        false,
    )?;
    if !rename_folder {
        return Ok(root);
    }
    fs::rename(&root, &destination)?;
    Ok(destination)
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
        "# 故事大纲\n\n## 故事背景\n\n> 在此填写世界观、时代、基本设定。\n\n## 人物与目标\n\n> 列出主要角色及其性格、动机、关系。包括外貌特征简述，便于后续生成角色参考图。\n>\n> 示例格式：\n> - **角色名**：种族/外貌特征，性格，动机，与其他角色的关系\n\n## 完整故事\n\n> 完整故事梗概（3–5 段），含主要转折点。从开头写到结尾，不留悬念。\n\n## 分集规划\n\n> 每集核心事件与转折。按剧情自然划分章节，不预先硬凑集数。\n>\n> 示例格式：\n>\n> | 集 | 名称 | 剧情任务 |\n> |---|---|---|\n> | 0001 | 集名 | 本集核心事件 |\n\n## 旁白、对白与设计约束\n\n> - 旁白决定：待与用户确认（使用 / 不使用）\n> - 大纲确认后先完成全剧人物与对白，再写第0001集分镜\n> - 连续性注意事项（伤势、武器、人物关系的跨镜继承）\n> - 后续设计的约束和检查清单\n",
    )?;
    create_document(
        &root,
        "全剧人物与对白.md",
        "# 全剧人物与对白\n\n> 大纲确认后，先完成全剧人物登记和所有分集的完整对白，再写第0001集的首帧和视频提示词。本文是普通创作稿，不添加剧集 v1 标记；S 镜号是一条独立视频生成请求，不是场次、单次切镜或单句序号。\n\n## 全剧人物登记\n\n| 角色ID | 名称 | 性格与说话习惯 | 目标与关系 | 首现集 | 角色图 | 音色文件 |\n|---|---|---|---|---|---|---|\n\n> 登记全部人物，包括配角和画外发声者；只整体使用的背景群像另表管理。尚未生成或未确定的素材写待生成或待确认。\n\n## 逐集对白正文\n\n> 每集先用“人物名：实际台词”写出并保留可以连贯阅读的完整交谈及必要动作，此时不套镜号、秒数和字数格子。按作品题材与人物关系决定口吻。修复答非所问、指代不明和提纲式碎句，不把所有人写成惜字如金。\n\n## 分集镜号与对白\n\n> 正文修订后逐字分配到各集表格。每镜预计时长为 1—15 秒，若用户约定更窄范围则遵守该范围。按约4字/秒估算，并计入换气、换人、停顿、不可重叠动作及约10%余量。超时先调整分界或增加S单元，不压缩台词，不提高语速凑容量，不规定每镜最低字数。同镜多次发言分多行，无对白的必要单元也列出并说明作用。\n\n| 镜号 | 预计时长（秒） | 角色ID | 角色名称 | 发声方式 | 中文台词 | 必要动作或反应 |\n|---|---:|---|---|---|---|---|\n\n> 优先在换人、整句、完整分句或自然换气处拆分，不切断词语，不重复前段台词，也不在每段补总结。按发言顺序拼回表格，与正文逐字一致。单集参考时长允许按授权延长；真正的硬性上限冲突须记录，不以删词掩盖。\n\n## 逐集容量与连贯性检查\n\n> 逐镜记录时长、实际发音字数、发言次数、估算发声耗时、停顿与不可重叠动作、余量及判定；同镜多行不重复累加时长。不伪造精确发声区间，正式分镜时再安排。注明文本估算、未实测，不以试读或样片为交付前提。\n> 遮住大纲和核算表，连读正文，检查目标、阻力、回应、决定和承接。正式分镜保留原词与发言顺序，允许因容量增加生成单元；拆分后同步本稿、各集声音安排、镜号引用及视频台词。\n",
    )?;
    let voice_catalog = scan_voice_catalog(voice_source);
    let agents_content = agents_md(
        name,
        character_source.map(|p| p.to_string_lossy().into_owned()),
        &voice_source.to_string_lossy(),
        &voice_catalog,
    );
    create_document(&root, "AGENTS.md", &agents_content)?;
    atomic_write(
        &root.join("assets.json"),
        b"{\n  \"schemaVersion\": 1,\n  \"assets\": []\n}\n",
        true,
    )?;
    Ok(root)
}

/// The root index is intentionally visible to external writing agents. It is
/// read only by the app and never created when opening an existing project.
pub fn read_asset_index(root: &Path) -> Result<Option<String>> {
    let path = root.join("assets.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::new(
            "path",
            "assets.json 必须是项目根目录中的普通文件",
        ));
    }
    let bytes = fs::read(path)?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| AppError::new("assets", "assets.json 必须使用 UTF-8 编码"))
}

fn scan_voice_catalog(voice_dir: &Path) -> Vec<String> {
    let Ok(dir) = fs::canonicalize(voice_dir) else {
        return Vec::new();
    };
    let mut files: Vec<String> = WalkDir::new(&dir)
        .follow_links(false)
        .max_depth(2)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|e| {
            e.file_type().is_file()
                && has_extension(e.path(), &["mp3", "wav", "flac", "ogg", "m4a"])
        })
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    files
}

fn agents_md(
    project_name: &str,
    character_directory: Option<String>,
    voice_directory: &str,
    voice_catalog: &[String],
) -> String {
    let char_dir = character_directory.as_deref().unwrap_or("未配置");
    let voice_table = if voice_catalog.is_empty() {
        "（创建项目时未扫描到音色文件，请手动读取声音目录）".to_string()
    } else {
        let mut table =
            String::from("| 文件名 | 性别 | 年龄段 | 角色名 | 声音特征 |\n|---|---|---|---|---|\n");
        for file in voice_catalog {
            let stem = file.rsplit('.').last().unwrap_or(file);
            let parts: Vec<&str> = file.rsplit('.').nth(1).unwrap_or(stem).split('_').collect();
            if parts.len() >= 4 {
                table.push_str(&format!(
                    "| `{}` | {} | {} | {} | {} |\n",
                    file, parts[0], parts[1], parts[2], parts[3]
                ));
            } else {
                table.push_str(&format!("| `{}` | — | — | — | — |\n", file));
            }
        }
        table
    };
    format!(
        r#"# {project_name}

> 本文件由 DramaCraft 自动生成，供第三方编辑器（Cursor、Codex、Claude 等）
> 识别项目结构并辅助创作剧本。请勿删除；可按需补充项目特有的约束。

本目录是一个 **DramaCraft 短剧项目**。当前项目为空，尚未创建任何剧本。
请按照下方【创作引导流程】逐步与用户对话，完成从选题到分镜提示词的全部创作。

## 创作引导流程

> **重要**：以下流程是你的核心任务。打开本目录后，主动引导用户完成创作。
> 每一步都需要与用户确认后再进入下一步。不要跳步，不要未经确认就生成内容。

### 第一步：选择题材

询问用户想要创作什么类型的短剧。列出以下题材供选择（用户也可以自由描述）：

| 编号 | 题材 | 简述 |
|:---:|------|------|
| 1 | 都市生活 | 职场、租房、邻里、日常反转 |
| 2 | 废柴逆袭 | 被看不起的主角一路翻盘 |
| 3 | 重生复仇 | 重活一世，改写命运 |
| 4 | 真假千金 | 身份互换、真相大白 |
| 5 | 契约婚姻 | 假戏真做、先婚后爱 |
| 6 | 穿越古代 | 现代人穿越到古代求生 |
| 7 | 异世界 | 召唤/转生到奇幻世界冒险 |
| 8 | 民俗怪谈 | 乡村诡异传说、民间禁忌 |
| 9 | 赛博朋克 | 近未来科技与底层生存 |
| 10 | 末世囤货 | 灾难降临前的囤积与生存 |
| 11 | 架空历史 | 虚构朝代或平行历史线 |
| 12 | 动物拟人 | 拟人化动物角色的故事 |
| 13 | 修仙修真 | 修炼体系、宗门争斗 |
| 14 | 校园青春 | 校园恋爱、友情、成长 |
| 15 | 悬疑推理 | 案件、密室、层层反转 |
| 16 | 甜宠日常 | 高糖恋爱、花式撒糖 |
| 17 | 豪门恩怨 | 家族争产、权力暗斗 |
| 18 | 娱乐圈 | 练习生出道、明星背后 |
| 19 | 医疗职场 | 手术室内外的生死抉择 |
| 20 | 刑侦破案 | 刑警办案、连环线索 |
| 21 | 古风宫斗 | 后宫争宠、朝堂博弈 |
| 22 | 丧尸末日 | 病毒爆发、小队求生 |
| 23 | 盗墓探险 | 古墓机关、地下世界 |
| 24 | 电竞热血 | 战队组建、赛场逆袭 |
| 25 | 美食治愈 | 深夜食堂、料理与人情 |
| 26 | 萌宠日记 | 宠物视角、人宠温情 |
| 27 | 科幻太空 | 星际航行、外星接触 |
| 28 | 谍战风云 | 地下工作、双重身份 |
| 29 | 武侠江湖 | 江湖恩怨、快意行侠 |
| 30 | 乡村喜剧 | 村里趣事、朴实欢乐 |
| … | 自定义 | 用户自行描述题材和方向 |

### 第二步：确认集数与节奏

题材确定后，询问用户：

1. **目标单集时长、总集数有无硬性要求？**（可先以每集 1—2 分钟估算；未指定集数时，在故事与分集任务明确后再建议）
2. **有无镜数或视频生成时长限制？**（没有则按动作、对白和观众理解所需时间分配，不预设每镜等长）
3. **画面风格偏好？**（写实、动漫、3D渲染、水墨、像素风等）
4. **是否使用旁白？**（使用 / 不使用。确认不使用后，全剧不用旁白，由画面与角色对白承担叙事信息）
5. **横竖屏？**（默认 16:9 横屏 480p；也可选 9:16 竖屏）

如果用户不确定，先按每集约 60—120 秒讨论故事，依据自然的剧情任务建议集数，再推导镜数与各镜时长。禁止先固定「多少集 × 每集多少镜 × 每镜几秒」再填情节。用户已指定的硬性规格优先；容纳不下时先减少支线与重复信息、收窄单集任务，仍有冲突再说明取舍，不擅自改变规格。用户确认画面风格后，把完整风格描述视为全剧约束，在角色图、场景/道具/群像图、首帧和视频提示词中带入同一组核心风格词。旁白选择同样是全剧约束，写大纲前必须记录为「使用」或「不使用」。

### 素材身份规则（创作、检查与优化都必须遵守）

以下规则贯穿大纲、人物登记、素材生成、首帧、视频和所有后续检查/优化。不能因为旧稿已有群像、已有图片或要求保持文件路径，就保留违规的主体组合；拆分所需个人图尚未生成时明确列为待生成，不得用群像成员定位句代替个人图。

- **群像只能整体使用**：仅用于无需识别任何个人的背景群众。群像中的任何一个人物都禁止单独引用、点名、指出位置或衣着来定位、安排个人动作/反应/对白、绑定个人音色、单独定义 Subject。不能写“左边那个人”“某色衣服的成员”“群像中的某角色”等成员提取关系；只允许整群站立、行走、散开等群体行为，一个群像整体对应一个 Subject。
- **人物同框不等于群像**：两名或多名需要独立识别、说话、行动、反应或跨镜追踪的人物，各自登记为角色，各用个人角色图，并分别定义 Subject。即使本镜同时出场、衣服相似或同属一个组织，也不能合并为群像图。
- **全剧先分类，再定义素材**：全剧中只要某人需要单独使用，就从一开始按独立角色管理；从已有群像拆出个人时，本镜改用实际需要的人物各自的个人图。不得同时上传含有该人的群像图和他的个人图，不得用群像 Subject 覆盖个人 Subject，也不得写“个人 Subject 是群体 Subject 的成员、不是新增人物”来消除重复。确需背景群众时，群像中不得包含已单独引用的人物。
- **角色与道具各按归属登记**：个人角色图由角色绑定表管理，不在素材表重复登记；道具和背景群像由素材表管理。组合道具图同样只能整体使用，单独使用某件道具时必须有独立素材记录和单件图，不从组合图中提取单件。
- **项目编号不进入视频提示词**：视频提示词的整个 text 围栏（含 Subject/Audio 定义、时间线及其他段落）禁止出现角色、素材、旁白或项目镜号等内部编号，例如 `C0001`、`A0001`、`N0001`、`S0001`，也不写文件路径或资产索引键。身份对应关系留在围栏外的角色表、素材表、每镜角色字段及上传映射中。围栏内只用本条请求的 `<Picture N>`、`<Subject N>`、`<Audio N>`、需要时的 `<Video N>`、`[Shot N]` 和发声者 `(Sx)`；`(S1)` 是发声者标签，不是项目镜号。

### 第三步：构思故事大纲

根据题材和集数，与用户共同完成 `剧本大纲.md`：

1. 先提出 2—3 个故事方向供用户选择或融合
2. 用户选定方向后，写出完整大纲，包含：
   - **故事背景**：世界观、时代、基本设定
   - **人物与目标**：主要角色（3—6 个）及其性格、动机、外貌特征、关系
   - **背景群像（如有）**：只整体使用、不涉及任何个人识别或个人行为的群众；为群体命名并制作可复用群像素材。需要分别识别或行动的人物各自作为角色登记，不因同框或同属一个组织而合并
   - **组合素材拆分**：一张图中合并展示的多个道具或其他独立素材，只在它们需要共同出现的镜头中作为组合素材使用。任何组成项只要单独出现或需要单独识别，就必须在素材表中单独登记，并配自己的素材图；不得把组合图重复绑定给其中多个单项。只有镜头确实需要整组同时出现时，才引用组合图
   - **完整故事**：从开头到结尾的完整梗概（3—5 段），含主要转折
   - **分集规划**：每集一行，写明主角当前目标、阻碍、关键选择、实际结果与下一集承接；一集围绕一个核心任务展开
   - **时间与状态基准**：涉及多条时间线、回忆、穿越、期限或倒计时时，列明基准事件、事件先后与间隔、各集所在时间；记录关键资源、权限与人物知情状态
   - **旁白决定、对白与设计约束**：明确记录「使用旁白」或「不使用旁白」，并记录台词时长估算和连续性注意事项
3. 将大纲写入 `剧本大纲.md`，请用户确认
4. **凡写入项目的 `.md` 文件**（大纲、全剧人物与对白、各集分镜与提示词）都必须是标准 Markdown，见下方「标准 Markdown」节

### 第四步：先完成全剧人物与对白

大纲确认后，先完成 `全剧人物与对白.md`，覆盖全部分集，不得只写人物简介、台词摘要或第一集对白就进入分镜：

1. 登记全剧全部人物，包括主角、配角、反派和画外发声者，固定角色 ID、名称、性格、说话习惯、目标、关系和首现集；只整体使用的背景群像另表登记。任何需要个人识别、对白、动作或反应的人物都独立登记，个人角色图由角色绑定表管理。群像图只能整体引用，禁止从中提取任何个人或与包含同一人物的个人图混用。角色图和音色只引用已确认的文件，尚未确定的写待生成或待确认，不编造现存素材。
2. 逐集先写并保留“人物名：实际台词”的连续对白正文，不套镜号或秒数，按作品题材与人物关系修复表达和问答。修订后按「集 → S 镜号 → 发言顺序」逐字分配到镜号、预计时长、角色 ID、角色名称、发声方式、中文台词、必要动作或反应表；拼回后必须与正文一致。**S 镜号是一条 1—15 秒的独立视频生成请求，不是地点/时间场景、单次切镜或单句台词**；同镜多行重复镜号，无对白的必要镜头也列出。对白稿不使用「场一／场二」分组，不添加剧集 v1 标记，也不伪造精确发声窗口；它仍是普通 Markdown 创作稿，不是客户端新的解析格式。
3. 先设计完整交锋，再按声音、停顿、必要动作和理解时间划分 S 镜号：要求或试探、阻力、回应或反驳、条件变化、决定。不能把一整场对话直接标成一个 S 镜号。对白承担关键动机、判断与选择，简单动作配合对白；不能依靠长时间复杂打斗、凝视或沉默代替必要信息。人物只说当时知道的事，不重复画面、不提前泄露后续决定、不用废话凑字。
4. 每集记录参考时长、实际发音字数、必要无对白时长及容量风险，按下方“对白自然度、容量与拆分”核算。有效字数必须从已写出的台词逐行重算，不凭印象填数。逐次发言与整镜按约4字/秒估算，另计停顿、换人、不可重叠动作和约10%余量。超时先移动分界或增加S单元，不压缩台词；不规定逐镜最低字数，不靠整集平均值掩盖局部超时。在必要动作或反应中交代前后状态；首帧的具体写法留到正式分镜阶段，按用户授权延长单集参考时长，硬性上限冲突如实记录。
5. 遮住大纲和动作说明，仅凭对白复述各集目标、阻力、回应、决定和跨集承接；无法理解处先修订。具体可见动作可以由画面补足，不要求人物复述一切。
6. 全剧对白完成并通过自查后交用户确认，再写第0001集。用户已经授权连续完成这些阶段时直接继续，不重复请求确认；不得跳过全剧对白稿。

### 第五步：逐集生成分镜剧本

全剧人物与对白完成后，先按下方「叙事清晰与单集容量」完成本集故事底稿与检查，再依据对白稿写正式分镜；完整台词与发言顺序保持一致，容量不足时允许调整技术分界、增加S单元并同步引用。底稿检查属于写作过程，不额外增加逐集确认步骤：

1. 每集一个 `.md` 文件，文件名 `0001 集名.md`、`0002 集名.md`……
2. 每集必须包含：角色绑定表、素材表、新增素材提示词、声音安排表、所有分镜
3. 每个分镜必须包含：故事走向、首帧图片提示词、视频提示词
4. 文件必须符合「标准 Markdown」与「分集剧本格式（v1）」；表格、路径、标题写坏会导致客户端预览失败或报错
5. **先检查第0001集文稿，之后严格逐集完成正式分镜。** 全剧人物与对白稿完成后，先写第0001集供用户检查剧本；不要求生成样片。文稿确认或用户已授权连续完成时，每次只写并检查一集，不批量预写剩余集，也不并行写不同集；一集完成、登记新资产并核对复用后，才开始下一集。用户已授权连续工作时不必每集等待确认。正式分镜调整对白或镜号后，同步更新全剧对白稿、本集声音安排和视频实际台词。
6. **写第 N 集前先读取** `剧本大纲.md`、`全剧人物与对白.md`、根目录 `assets.json`，以及第 N-1 集剧本（第0001集无上一集）。上一集用于承接剧情状态；`assets.json` 用于查询全部已登记的跨集资产。复用时再读取索引所指的首现集角色表、素材表和生成提示词，逐字复制文件名，不能只看上一集或凭名称猜测。
7. **每集写完立即更新索引。** 将本集首现的新角色、场景、道具、群像和可复用状态变体登记到根目录 `assets.json`，ID、名称和首现集须与本集表格一致；新增角色还须同步全剧人物登记。首帧、视频和一次性画面不登记。完成校对后才写下一集。不要让并行子 agent 分别写不同集。

生成时注意：
- 角色 ID 跨集保持一致（C0001 始终是同一角色）
- 素材在**首次使用的那一集**提供完整生成提示词；后续集只引用同一文件名，不要另写一套提示词，更不要改集号前缀
- 前几集要为所有角色、场景和**会复用的群像**提供素材生成提示词；群像参考图只用于多人同框镜头
- 需要单独识别的人物各自使用独立角色 ID、个人角色图和 Subject；群像只能整体引用，禁止单独指认任何成员，禁止与包含同一人物的个人图或个人 Subject 混用
- 一张组合素材图里的道具或其他独立组成项，只要单独出镜或需要单独识别，就要在素材表中分别登记并配各自的独立素材图；组合图只用于整组共同出现的镜头，不得把同一张组合图重复绑定给多个单项
- 素材不只是「场景 + 主角 + 道具」：跨镜出现的跟班、村民、看客等必须进素材表并挂参考图
- 相邻镜切换主体时注意画面承接：若上一镜角色A在场，下一镜切到角色B视角，可用远景把角色A及其随从仍留在画内，避免画面突然只剩两人、空间跳切过硬
- 每镜检查对白自然度、必要剧情信息、逐句发声容量和首帧承接，遵守下方「对白自然度、容量与拆分」；不为字数或固定镜数改变完整台词
- 伤势、道具、关系等状态跨镜继承，不可遗忘
- 用户确认的画面风格是全剧约束；素材图、首帧与视频提示词都带入同一套核心风格词
- 写每镜视频提示词前，核对本镜角色表、素材表、上传映射所引用的角色图、场景图、道具图、群像图与它们对应的生成提示词，提取并复制用户确认的核心风格词
- 用户确认「不使用旁白」时，全剧不创建旁白角色，不写旁白台词，不在声音安排表登记旁白台词，也不上传或引用旁白音色；叙事信息改由可见动作、画内对白或明确属于某个角色的画外话语承担
- 视频提示词只写可拍摄的场景、动作、表情和必要音效；心理、回忆、设定说明中不影响理解的内容可以删，关键因果必须转成可见证据或有发声主体与 `<d>` 台词的对白、内心独白。禁止把小说式讲解写进时间线，也禁止为了去掉讲解而丢失必要信息。只删破折号、留下原句，同样禁止

### 第六步：全剧验收后交付

全部集写完后，先做「全剧验收」，再提醒用户：
1. 所有文件已生成，可在 DramaCraft 客户端打开本目录查看故事板；黄条诊断必须先清掉
2. 独立首帧按提示词生成或导入；尾帧承接镜须先取得来源视频，导出其实际尾帧并导入本镜首帧，不独立生图。由用户手动上传尾帧后再生成本镜视频
3. 配置视频 API 后，点击生成即可逐镜产出视频
4. 如需修改某一集或某一镜，直接编辑对应的 `.md` 文件

---

## 对白自然度、容量与拆分

以下是创作代理的写作与检查要求，不是客户端自动校验或生成效果保证。用户要求优先。先完成自然对白，再划分视频请求；单次接口上限不是整场交锋的上限。

- **先写完整表达**：人物按当下关系和目的交谈。保留听者理解所需的对象、条件、因果和回应，不写提纲、术语串、含糊比喻与机械表态。对白正文是基准，分配表和正式分镜不能另写缩略版。真正重复或错误的信息在正文阶段修订；已确认台词不因技术容量被压缩。
- **按实际容量核算**：普通发声先按约4字/秒估算，受伤、迟疑、强调时适当放慢；数字缩写按读法计数，实际说出的语气词也占时间，标点不计。另计换气、换人、停顿、不可重叠动作和约10%余量，能自然并行的动作不重复计时。逐次发言及整镜都要装得下，不能整镜合计合格却把长句塞进最后几秒，也不能靠快速说完达标。
- **不设字数下限**：不规定每镜最低字数，不因少一两个字补词，不用全剧平均字数判断质量。必要动作、反应和沉默说明剧情作用即可，不额外要求低对白豁免确认；空转或信息缺失按剧情修复。目标是自然、清楚且时间足够，不是达到密度数字。
- **容量不足就拆分**：先在用户允许范围内调整时长，再移动分界或增加S单元；不预设镜数。优先在换人、整句、完整分句或自然换气处划分，不切断词语，不重复台词，不加总结或重新交代设定。同一人物可连续说数个单元，拆分不强制换机位。余段过短时重新平衡前后分界，不靠无作用等待填时长。参考单集时长按授权延长；用户硬性上限仍无法兼容时记录冲突，不偷偷删词或改剧情。
- **分清内容与技术安排**：核心剧情、人物关系、事件顺序、知情状态、台词原词与发言顺序、最终结果保持一致。未生成视频的技术分界、镜数和时长可按上述规则调整。同步对白分配表、核算、本集声音安排、分镜标题和所有文件/镜号引用。新稿按顺序使用唯一S编号；已有生成记录的镜号不静默重编号，新增单元用未使用ID，来源按文档顺序指定。已有成片或用户锁定的时长需超出授权调整时记录影响，不能悄悄覆盖。
- **声音同步**：视频内每次发言分别标明主体、画内/画外、语气、音色和发声区间；简单动作可并行，不在同一台词块混写多人对白。每条请求重新核对Subject、Picture、Audio编号，保留角色音色对应。全剧正文、分配表、声音安排与视频台词逐字一致；缺少素材或能力不明如实记录。
- **验收记录**：在提示词代码块外记录“时长｜实际发音字数｜发言次数｜各次发声区间｜估算发声耗时｜停顿与不可重叠动作｜余量｜容量判定”。对白稿阶段不虚构精确发声区间。注明文本估算、未实测；不把试读、样片或人工逐镜确认设为继续写作的前置条件。

## 尾帧承接的首帧提示词

使用上一镜尾帧时，沿用原有 `### 首帧生成`、出图文件名及 `**首帧图片提示词**`，只把该提示词的text围栏内容固定写成以下五个字，不追加画面描述、风格词、编号或说明，不新增字段或承接表：

```text
上一镜尾帧
```

“上一镜”指本集文档顺序中紧邻的前一镜。仅在同地点、连续时间、同机位或连续运镜、前后状态相容时使用；第一镜、换场、跳时、反打或重新构图时，仍写正常的完整首帧图片提示词。长对白拆分不等于必须承接尾帧。

出图文件名仍保留本镜自己的首帧PNG；视频映射的 `ref_image_0` / `<Picture 1>` 也指向该文件。用户生成上一镜视频后，手动取得尾帧并上传为本镜首帧，再生成本镜视频。“上一镜尾帧”是给用户的操作提示，不提交给生图模型，也不代表客户端自动提帧或调度任务。

人物站位、朝向、道具、伤势、光线、机位与动作阶段的衔接，写在已有的故事走向和视频动作描述中，不增加首帧字段。视频提示词独立写全本段角色参考、音色、起始状态、动作和台词，不假设模型记得上一条请求；整个视频text围栏仍禁止项目ID或路径。尾帧只承接视觉，不传递音频；拆分避开词中，保持音色、语气与环境声一致。

## 叙事清晰与单集容量（先检查故事，再写分镜）

**目标：观众只看成片，也能理解人物当前要做什么、为什么做、行动造成什么变化。格式正确不等于故事成立。以下是外部创作 agent 的写作与审稿责任，客户端不会自动判断剧情是否合理。**

### 1. 先写连续故事，再拆镜

每集先写一段不含镜号、运镜和秒数的故事底稿，用自然中文串起「处境与目标 → 具体阻碍 → 选择与行动 → 可见结果」。底稿可放在工作笔记中，不改变分集 v1 格式。每个主要转折都要能回答：前面发生了什么，才使人物现在这样做？若只能用「然后又发生」串起无关事件，先调整故事，不能靠增加镜头术语掩盖断裂。

### 2. 一集一个核心任务，信息按需要进入

- 默认跟随一个主要视点、一个当前目标；副线与其他角色的出现必须影响这个目标。不要在一集里同时完成世界观讲解、多名人物介绍、多个机制教学和多个独立任务。
- 列出本集必须让观众知道的信息；只保留理解当前行动与结果必需的内容。后续才有用的身份、规则、道具背景，留到发挥作用时再建立。
- 第一集先建立人物的具体处境与眼前目标，不承担全剧设定说明。开场可以有悬念、倒叙或强烈反差，但进入依赖这些信息的下一步行动前，要提供足够的理解依据。
- 悬念可以隐藏真相、身份或远期计划；不能把当前行动的基本动机与障碍全部藏掉，再要求观众靠题材套路猜。结尾钩子应由本集结果产生，不能另插一件无关危机充当转折。

### 3. 关键因果必须进入成片

在拆镜时，为每条必要信息注明落在哪个镜号、由什么画面证据或哪句台词传达。这份核对可留在工作笔记中。仅写在大纲、本集梗概、镜头标题或「故事走向」中，不算已交代。

优先用动作及后果、人物关系、道具状态等可见证据表达；画面不足以说明时，用简短自然的对白或已明确发声主体的内心独白补足，遵守声音格式。皱眉、握拳、看手机、盯着某物，不能单独证明具体日期、过往事件或行动理由。屏幕与纸面上的关键文字须安排可读的构图和阅读时间，不能同时让手遮住或迅速收起；无法可靠呈现时另设声音依据。

### 4. 时间信息有统一参照

涉及期限或多条时间线时，先在大纲建立时间基准，再逐项核对日期、间隔、台词和画面文字。明确区分「距某事件还有多久」「某事件过去多久」「回到了哪个时间点」；不同事件的时间间隔不得混用。「之前」「之后」必须有观众已经知道的参照。

倒计时首次出现时，要让观众知道它指向什么事件、到期为何影响主角当前目标；若刻意隐藏到期真相，仍须建立可理解的当下压力。后续只在时间变化或影响决定时重申，不为每集打卡反复插入数字。回忆、梦境、现实切换需要可辨识的视听线索，不能只在镜头说明中标注。

### 5. 场景切换承接目标，结果先有条件

换地点或时间前后，交代人物为什么去、去做什么，以及必要的时间流逝或空间关系；可以用视线、声音、道具、动作衔接，不必把路程全部拍出。新角色登场应提供帮助、阻碍或改变决定，不能只为提前露面而打断主线。

人物取得资源、使用权限、完成交易或摆脱阻碍之前，应建立所需条件，或明确留下尚未完成的状态。不能先把成果当成已经获得，再到下一集补办取得它的前提；刻意倒叙也必须让观众辨认顺序。跨集开头继承上一集结尾的位置、道具归属、关系与知情状态。

### 6. 时长给理解与变化，不给固定格子

根据动作、对白、反应、必要的阅读和辨认时间分配时长，并核对所用视频接口支持的时长。一次生成单元以一个主要动作或连续的小任务为主，不能因接口允许多镜就塞入多个无关事件。不要把所有镜头机械写成相同秒数，也不要为了凑镜数拆出重复的看、摸、点头与停顿。

每镜应提供新信息、改变状态，或承担必要的情绪反应与空间承接。重复展示同一事实而无新作用时合并或删除。判断容量要看观众需理解多少新关系、规则和转折，而不只是台词能否念完。超出容量时，先删除重复与延后非必要信息，再收窄本集任务；仍放不下才考虑延长或按有结果的剧情节点拆集，涉及用户硬性规格时说明取舍。

### 7. 按观众实际能接收的内容验收

暂时遮住大纲、本集梗概、镜头标题和「故事走向」，只连读首帧画面、视频中的动作与实际台词：能否复述一条连续故事，说明人物为何行动、发生了什么变化？再核对必要信息与镜号的对应，确保去掉小说解释时没有丢掉因果。

若需要说「因为大纲写了」「观众应该能猜到」才能解释，视为未通过。先补证据、调整信息顺序或减少任务，再输出分镜；不能仅凭格式自检通过就交付。静音检查用于判断画面本身能传递多少信息，不要求有对白的作品完全无声也能表达全部设定。

## 目录结构

```
{project_name}/
├── .drama-craft/          # 项目元数据（勿手动编辑）
│   └── project.json
├── AGENTS.md              # 本文件 — 项目结构与创作引导
├── assets.json            # 作品级角色与素材检索索引
├── 剧本大纲.md            # 故事大纲、角色设计、分集规划
├── 全剧人物与对白.md      # 全部人物登记与逐集完整对白，先于第0001集分镜
├── 0001 集名.md             # 第1集分镜剧本
├── 0002 集名.md             # 第2集分镜剧本
└── …                      # 更多集数
```

## 素材库

- 角色图目录：`{char_dir}`
- 声音样本目录：`{voice_directory}`

### 作品级资产索引

根目录 `assets.json` 与本文件并列，是供创作 agent 查询和维护的索引。新项目初始为 `{{"schemaVersion":1,"assets":[]}}`。每条记录使用以下字段：`id`（角色 C0001、旁白 N0001 或素材 A0001，作品内稳定且不重用）、`type`（`character`、`scene`、`prop`、`crowd`、`variant`）、`name`（与首现集表格一致）、`aliases`（其他叫法数组）、`keywords`（简短检索词数组）、`firstDocument`（相对项目根目录的首现集 `.md` 路径）。`variant` 另填 `baseId`，指向已有资产 ID。示意：`{{"id":"A0001","type":"scene","name":"王宫大殿","aliases":[],"keywords":["王宫"],"firstDocument":"0001 集名.md"}}`；示意路径须在实际写出该集后换成真实路径。

索引不存素材文件名、音色路径或完整提示词。命中后按 `id` 到首现集的角色表或素材表读取文件名，再按同名标题读取提示词。新角色、新素材首次写入分集后立刻登记；首帧与生成视频不登记。写新集前先查索引，同名候选须核对，不能擅自合并。外部 agent 编辑 `assets.json`；DramaCraft 只读搜索和校验。

### 音色绑定规则（极其重要）

> **禁止编造不存在的音色文件名。** 角色的音色文件必须从声音目录中选择已有文件。

音色文件的命名格式为 `性别_年龄段_样本标签_声音特征.mp3`。
**注意：文件名中的"样本标签"只是音色的代号，不是剧本角色名。** 剧本角色名可以自由定义，与音色文件名无关。

选择音色的方法：**只看性别、年龄段和声音特征**，为剧本角色匹配最贴合的音色。示例：

| 剧本角色 | 角色特点 | 应选音色文件 | 匹配依据 |
|---|---|---|---|
| 林远舟（男，30岁，沉稳内敛） | 男性、青年、沉稳 | `男声_青年_倦收天_孤傲沉稳.MP3` | 性别＝男，年龄段＝青年，特征＝沉稳 |
| 苏晚晴（女，26岁，清冷聪慧） | 女性、青年、清冷 | `女声_青年_夏知秋_清冷轻熟.mp3` | 性别＝女，年龄段＝青年，特征＝清冷 |
| 老村长（男，65岁，饱经沧桑） | 男性、老年、沧桑 | `男声_老年_村长_沙哑沧桑.mp3` | 性别＝男，年龄段＝老年，特征＝沧桑 |

为角色选择音色时：
1. **优先读取声音目录**：如果你有文件系统访问权限，直接读取 `{voice_directory}` 目录获取最新文件列表
2. **无法访问时用下方快照**：以下是创建项目时扫描到的音色文件（可能不是最新的）
3. **只按性别＋年龄段＋声音特征匹配**：忽略文件名中的样本标签，根据角色的性别、年龄和性格选择最贴合的音色
4. **音色文件路径格式**：在角色绑定表中，把声音目录和文件名拼成完整路径，用正斜杠 `/` 连接。例如：若声音目录为 `F:/声音库`，文件为 `男声_青年_程寒_年轻利落.mp3`，则写 `F:/声音库/男声_青年_程寒_年轻利落.mp3`
5. **同一音色可供多个角色使用**：如果没有完美匹配，选择最接近的；不同角色可以使用同一个音色文件

#### 可用音色列表（创建时快照）

{voice_table}

> 如果用户后续添加了新的音色文件，请优先扫描声音目录获取最新列表。

---

## 格式规范

> 以下是 DramaCraft 客户端解析剧本所需的格式规范。
> 生成内容时**必须严格遵守**，否则客户端无法正确识别分镜和素材。

### 标准 Markdown（项目内全部 `.md` 通用）

**适用范围**：`剧本大纲.md`、`全剧人物与对白.md`、`0001 集名.md` / `0002 集名.md` 等每一集分镜与提示词文件，以及本项目中后续新增的任意 `.md`。
**不是只约束大纲。** 凡交付到项目目录的 Markdown，都必须能被标准 Markdown / GFM 正确渲染。客户端用同一套解析器预览与识别分镜；格式不合法时表格会糊成一段，分镜与素材也会解析失败。

必须遵守：

1. **真换行**：段落、列表项、表格的每一行都必须用真实换行分隔，禁止把多行挤在同一行，禁止用 `||` 拼接多行表格。
2. **表格语法完整**：表头、分隔行、数据行各占一行。分隔行只能使用 `|---|`、`|:---|`、`|---:|`、`|:---:|`，**禁止** `|::---|`、`|::---:|` 这类非法对齐写法。
3. **标题与围栏完整**：`#` / `##` / `###` 标题独占一行；代码围栏成对闭合（\`\`\`text … \`\`\`）。
4. **写完后自检**：若某段本应是表格，在预览中却变成一整段带很多 `|` 的文字，说明 Markdown 已写坏，必须先修好再交付。

正确表格示例：

```markdown
| 角色ID | 名称 | 年龄 |
|---|---|---|
| C0001 | 程寒 | 32岁 |
| C0002 | 苏晚晴 | 29岁 |
```

错误示例（禁止）：把多行写成 `| C0001 | … || C0002 | … |`，或分隔行写成 `|::---|`。

### 分集剧本格式（v1）

每集为独立 `.md` 文件，文件名建议 `0001 集名.md`、`0002 集名.md`。

#### 文件头

**首行必须**是（独占一行，不可省略）：

```
<!-- drama-craft:episode:v1 -->
```

紧接一级标题 `# 第0001集 集名`，再接一段 `本集内容：本集梗概文字`。
可选补充本集镜数和总时长，例如：`本集13镜，合计68秒（01:08）；每镜独立请求，16:9横屏。`

#### 角色绑定（必须）

`## 角色绑定` 必须直接使用下面这份四列表头与分隔行，列数、顺序均不可更改：

```markdown
| 角色ID | 名称 | 角色图 | 音色文件 |
|---|---|---|---|
```

- **角色表固定为四列**：表头、分隔行和每条数据行都必须是四个单元格。角色出场关系只在每镜 `角色：` 字段填写，不重复登记镜号
- 正式角色 ID 用 `C0001`、`C0002`……；仅当用户确认使用旁白时，旁白使用 `N0001`
- 同一作品**跨集保持 ID、名称及已确定的声音一致**
- 角色图写相对路径或角色库绝对路径；已确认使用的旁白可以没有角色图，写 `—`
- **音色文件必须从声音目录已有文件中选择**（参见上方「可用音色列表」），根据角色的性别、年龄和性格匹配最贴合的音色；文件名中的样本标签不是剧本角色名，禁止编造不存在的文件名
- **所有路径必须包在反引号内**（行内代码），例如 `` `0001 素材_秦墨.png` ``、`` `F:/声音库/男声_青年_程寒_年轻利落.mp3` ``；不要写成裸文本。音色路径格式：声音目录 `/` 文件名，用正斜杠连接

完整示意表：

```markdown
| 角色ID | 名称 | 角色图 | 音色文件 |
|---|---|---|---|
| C0001 | 秦墨 | `0001 素材_秦墨.png` | `F:/声音库/男声_青年_程寒_年轻利落.mp3` |
```

若用户确认使用旁白，再按同一四列格式添加 `N0001`；若确认不使用，角色表中不添加旁白行。

#### 素材表（必须）

`## 本集使用素材`，表格列及顺序**不可更改**：

```
| 素材ID | 名称 | 类型 | 文件 |
```

- 素材 ID 用 `A0001`、`A0002`……
- 类型写**场景、道具、状态变体或群像**
- 素材表只登记本集素材，不自动分配到各镜；每镜要上传的场景、道具或群像图片必须在该镜添加引用，或写入视频素材映射。
- **群像**：只整体使用的背景群众；跨镜复用时制作多人同框参考图，并在需要整群的镜头中引用。禁止单独引用、指认或定义其中任何成员；需要个人行为或身份的人物改用个人角色图
- **组合素材只在整组共同出镜时使用**：一张图合并多个道具或其他独立素材时，只有镜头需要它们同时出现，才能登记/引用这张组合图。某镜只用到其中一项，就只登记并引用该项的独立素材图，不要把组合图或无关组成项放进该镜的素材引用、GPT 附件或视频上传映射；不要为了凑齐组合图内容而额外定义镜头用不到的素材
- **按镜头需要控制素材数量**：只登记本集实际使用、且对画面识别、剧情信息或跨镜连续性有作用的素材。临时出现且无需保持外观一致的小物件可直接写入动作或画面描述，不必拆成素材。每镜只引用本镜实际可见且确有参考价值的素材，使用能完成任务的最少图片
- 角色参考图由角色表管理，不重复作为独立素材；群像只作为整体背景素材。任何个人发声或需独立识别时，该人必须作为独立角色管理，不能继续从群像图提取
- **路径必须写在行内代码或 Markdown 链接内**，例如 `` `0001 素材_外门庭院.png` ``；空项用 `—`；不要写成裸文本
- 不得凭空编造已存在的素材文件名
- **跨集同一素材 ID / 同一名称，文件名必须逐字相同**。后续集引用时从首现集或素材登记里复制，禁止把 `0005 素材_王宫大殿.png` 改成 `0003 素材_王宫大殿.png` 这类猜集号的写法

#### 新增素材生成提示词（推荐）

在素材表之后、声音安排之前，为本集**首次出现**的场景、道具、群像和角色参考图提供完整生成提示词。复用已有文件的条目不要再写提示词，也不要另造文件名。若本集是某素材的首现集，却没有同名 `### 标题` 和代码围栏，客户端卡片会既没有图、也没有提示词。

**标题格式要求**：三级标题必须能让客户端匹配到角色表或素材表中的名称。支持以下格式（以角色"林逸"、场景"王宫大殿"、群像"内门跟班"为例）：

| 格式 | 角色示例 | 场景示例 | 群像示例 |
|---|---|---|---|
| 直接使用名称（推荐） | `### 林逸` | `### 王宫大殿` | `### 内门跟班` |
| 名称+参考图后缀 | `### 林逸参考图` | — | `### 内门跟班参考图` |
| 前缀：名称 | `### 角色参考图：林逸` | `### 场景：王宫大殿` | `### 群像：内门跟班` |

> **禁止在标题中使用角色表/素材表中不存在的名称**——客户端按名称查找提示词，找不到则不显示。

**角色图提示词（必须用三视图模板）**：仅用于角色参考图，**不要**用于场景、道具或群像。画面 16:9。**不要写死某一种风格**（如「真人电影风格」）——风格沿用第二步与用户确认的画面风格。此处只固定三视图版式；中间「具体内容」换成该角色的外貌、服饰、持物等描述，并带上已确定的风格用语：

```text
生成图片，16：9。[此处写入已确定的画面风格]

具体内容

人物三视图角色设计展示
左侧：完整全身正面站姿，角色全身与武器完整展示
中间：面部特写肖像
右侧：人物侧面全身
三栏布局排版，角色设定参考图，极简纯白摄影棚背景，柔和摄影棚灯光，均匀漫射光，超清细节，8K。
不需要任何标注文字
```

**场景 / 道具提示词**：仍用单幅无人物母版（或单件道具图），**不要**套用三视图模板；风格同样沿用已确认方案，不在此写死。

**群像提示词**：只用于整体出场的背景群众；**不要**套用三视图。做成一张「多人同框、纯白背景」的群像参考图，只定义群体人数、共同服饰与整体外观，不为成员命名、分配个人身份或设置后续提取特征。后续各镜只整体引用；需要分别识别的少数人物用个人图，不使用群像。

```text
16:9横向单幅画面。[已确定的画面风格]。
纯白色背景，群像站位，角色居中，展示完整全身。
王宫侍卫群像：共8人，统一青灰布甲与黑色束发，体态自然略有差异，只作为整体背景群众，无独立角色或个人身份。
站姿自然，神情符合身份。禁止任何文字、字幕、水印、场景背景和多余角色。
```

```markdown
## 本集新增素材生成提示词

### 王宫大殿

生成后保存为：`0001 素材_王宫大殿.png`。

\```text
16:9横向单幅无人物场景母版。[已确定的画面风格]。详细的场景描述……
\```

### 内门跟班

生成后保存为：`0001 素材_内门跟班.png`。

\```text
16:9横向单幅画面。[已确定的画面风格]。
纯白色背景，群像站位，角色居中，展示完整全身。
内门跟班：共8人，统一灰蓝色弟子服与束发，只作为整体背景群众，不含本剧已登记的独立角色，不设置可单独提取的成员身份。
站姿自然，神情讥讽顺从。禁止任何文字、字幕、水印、场景背景和多余角色。
\```

### 林逸

生成后保存为：`0001 素材_林逸.png`。

\```text
生成图片，16：9。[已确定的画面风格]

二十岁中国男性青年，黑发短发，清秀面容，深棕色眼眸。身穿白色麻布衬衣外搭棕色简易皮甲，下身深色长裤和褐色短靴，腰间挂一柄普通铁剑。站姿自然，眼神温和。

人物三视图角色设计展示
左侧：完整全身正面站姿，角色全身与武器完整展示
中间：面部特写肖像
右侧：人物侧面全身
三栏布局排版，角色设定参考图，极简纯白摄影棚背景，柔和摄影棚灯光，均匀漫射光，超清细节，8K。
不需要任何标注文字
\```
```

素材在首次使用集提供完整提示词；后续集引用同一文件名，不重复提示词。

#### 声音安排（必须）

`## 本集声音安排`，表格列及顺序**不可更改**：

```
| 镜号 | 角色ID | 角色名称 | 台词 |
```

- **只列有台词的镜**：无对白的分镜不要放进声音安排表，不要写占位行
- 角色 ID 和角色名称必须与本集角色绑定表一致
- 画内、画外或旁白，以及具体发声时间，写在视频提示词对应的时间段中；「旁白」仅在用户已确认使用旁白时使用
- 同一镜有多人说话时，每人一行（镜号可重复）
- 没有台词的集仍保留空表头（只有列头，没有数据行）
- 该表与视频提示词中的台词应一致

#### 分镜结构

每镜以 `## S0001 镜头名` 开头，S 编号在本集内唯一。

**`角色：` 字段为必填**，列出本镜出场或发声的角色 ID，用顿号分隔；没有角色写 `角色：—`。

每镜依次包含 `### 故事走向`、`### 首帧生成`、`### 视频生成`。  
**标题必须写全称且不要加冒号**：写成 `### 故事走向`，**禁止** `### 故事走向：`；`### 首帧生成` / `### 视频生成` 同理。

**首帧提示词画面风格写法（硬性规则）**：

以下风格要求仅适用于需要独立生成图片的首帧；使用尾帧的首帧提示词固定为“上一镜尾帧”，不追加风格词，实际画面风格从上传的尾帧继承。视频提示词仍须写出统一风格。
- 每个用于独立生图的首帧图片提示词都必须在画幅比之后，**直接写出用户已确认的完整核心画面风格词**；不能因为附件里已有角色图或场景图就省略，也不能只写「沿用图片1风格」「风格同参考图」。附件负责锁定场景、外貌和服饰，不替代文字风格锚点。
- 首帧使用的核心风格词必须与角色图、场景/道具/群像图一致；可按当前镜头补充光线、色调和氛围，但不得改成另一种渲染或媒介风格。
- 例如用户确认的核心风格是「3D写实，PBR材质，电影级光照」，首帧必须以 `16:9横向单幅画面。3D写实，PBR材质，电影级光照。` 开头。若确认的是其他风格，逐字替换为实际风格，不得照抄示例或遗留方括号占位文字。

```markdown
## S0001 镜头名

角色：C0001、C0002

### 故事走向

描述本镜动作、剧情变化或结果（纯文本段落）。

### 首帧生成

出图文件名：`0001 首帧_S0001.png`。

GPT附件：**图片1＝场景母版（`0001 素材_场景.png`）；图片2＝角色A参考图（`角色A图路径`）；图片3＝角色B参考图（`角色B图路径`）；图片4＝内门跟班群像（`0001 素材_内门跟班.png`）**。

**首帧图片提示词**

\```text
16:9横向单幅画面。[此处逐字写入用户已确认的完整核心画面风格词，不得省略]。场景布局与光线沿用图片1。角色A外貌与服饰沿用图片2。角色B外貌与服饰沿用图片3。内门跟班外貌与服饰沿用图片4。
不复制参考图的白底、拼版或站姿。
中景或远景：写清景别与人物站位。跨镜复用的群像必须引用群像素材图；仅一次性背景人可用文字外形带过。相邻镜切换时，可把上一镜关键人物留在远景，避免画面突然只剩两人。
只画动作开始前的静态一刻，只写看得见的站位、表情、道具与光线，不写心理或回忆说明；只输出单幅画面，无字幕、格线或水印。
\```

### 视频生成

视频文件名：`0001 S0001.mp4`。

| API参数 | 提示词标签 | 上传素材 |
|---|---|---|
| `ref_image_0` | `<Picture 1>` | `0001 首帧_S0001.png` |
| `ref_image_1` | `<Picture 2>` | `角色A图路径` |
| `ref_image_2` | `<Picture 3>` | `角色B图路径` |
| `ref_image_3` | `<Picture 4>` | `0001 素材_内门跟班.png` |
| `ref_audio_0` | `<Audio 1>` | `音色文件路径` |

**视频提示词｜duration=5，resolution=480p横**

\```text
<Picture 1> is the first frame of [Shot 1].
<Subject 1> is the young apprentice in <Picture 2>, with a blue-gray work robe and a worn cloth bag.
<Subject 2> is the other young apprentice in <Picture 3>, with a light-cyan work outfit and dark wrist guards.
<Subject 3> is the group of attendants in <Picture 4>, wearing matching dark work robes.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1). Do not copy the source dialogue.

detailed_description:
The target video uses [replace with the visual style confirmed with the user, written in concise English]. Maintain that style and the rendering of <Picture 1> throughout the video.

[Shot 1] The shot begins from <Picture 1>, preserving its scene, lighting, and opening composition. The camera remains fixed, with no zoom or cuts.

From 0 to 3.5 seconds, <Subject 1> points at <Subject 2> with an angry expression. <Subject 1> (S1) speaks on screen in an irritated voice, using the timbre of <Audio 1>: <d>[Chinese] 你又迟到了!</d> <Subject 2> lowers their head and nods silently; <Subject 3> remains in the background.
From 3.5 to 5 seconds, <Subject 1> closes their mouth and turns away. <Subject 2> slowly raises their head.

No subtitles or watermark.

overall_soundscape:
Soft indoor room tone continues throughout, quieter than the dialogue.

non_diegetic_music:
N/A
\```

配音校验：时长D秒｜实际发音N字｜发言次数K｜各次发声区间｜
估算语速与含停顿耗时｜不可重叠动作耗时｜执行余量｜判定。估算，待试读验证。
```

> **GPT附件硬性规则（与崩拳等既有漫剧一致）**：
> - **每个 `图片N` 只绑定一个文件**。写成 `图片2＝苏铭参考图（\`0001 素材_苏铭.png\`）；图片3＝周元霸参考图（\`0001 素材_周元霸.png\`）`。
> - **禁止**把多个角色/素材塞进同一个 `图片N`，例如 `图片2＝角色参考图（\`苏铭.png\`、\`周元霸.png\`）` 或「图片2中的两个角色」。
> - 首帧提示词按角色逐条写清编号：`苏铭外貌与服饰沿用图片2。周元霸外貌与服饰沿用图片3。`，不要写笼统的「角色外貌沿用图片2」。
> - **群像只能整体引用**：仅整体出场的背景群众复用群像素材；任何需要个人识别、动作、反应或对白的人物都引用自己的个人图。禁止用群像图补充个人外观，禁止上传与个人图包含同一人的群像图。
> - **仅一次性背景人**：无需识别且不复用的路人可用一句外形带过；需再次追踪同一个人时登记独立角色，只有整体复用的背景群众才登记为群像。
> - **相邻镜画面承接**：切到另一主体时，若同一场景未切走，可用远景把上一镜关键人物（含群像）留在画内，避免画面突然只剩两人、空间跳切过硬。
> - 单角色镜可省略图片3；多角色/多道具/群像则继续 `图片4`、`图片5`… 编号连续。
> - 视频映射表同样一格一行上传素材，与 GPT附件编号独立编号（视频的 `<Picture 1>` 通常是本镜首帧，不继承首帧 GPT 的图片序号）。

> **视频提示词画面风格写法**：
> - 画面风格不是模板预设值。先在创作流程中与用户确认，再由创作 agent 将确认结果翻成简短、具体的英文，写在 `detailed_description:` 后、`[Shot 1]` 前；不得把方括号占位文字原样提交给视频模型。
> - 推荐格式：`The target video uses [已确认画面风格的简短英文描述]. Maintain that style and the rendering of <Picture 1> throughout the video.`。其中方括号内容必须替换；后一句要求视频沿用首帧已经呈现的风格，不代表在模板中固定某一种风格。
> - 同一作品沿用已确认的核心风格；镜头仍可根据剧情调整景别、光线和气氛。写提示词前核对本镜参考素材，避免新增与素材冲突的风格词。

> **H3 Ref2VA 主体与音色引用（逐条视频请求独立定义）**：
> - 实际发送给 H3 的视频提示词中，标签定义、动作、运镜、音效描述使用英文；中文对白只保留在 `<d>[Chinese] ...</d>` 中，可见的中文文字可保留原文。剧本标题、角色表、故事走向、首帧图片提示词等项目文档仍可使用中文。本模板保留 `detailed_description` 等精简结构，不等同于官方六节完整格式；真实生成效果仍需验证。官方原文：https://raw.githubusercontent.com/MiniMax-AI/MiniMax-H3/main/skills/h3-prompt-writing/references/ref-en.txt 。
> - `<Picture N>` 仍对应上传映射表的图片编号。首帧图是具体画面锚点，单独定义 `<Picture 1> is the first frame of [Shot 1].`，并在镜头开头引用。某张图片若只提供人物、场景、服装或道具的外观，不为它额外写独立 `<Picture N>` 定义行；直接在相应 Subject 定义中写来源，例如 `<Subject 1> is the young apprentice in <Picture 2>, with a blue-gray robe and a worn cloth bag.`。若图片本身还充当关键帧、尾帧或分镜构图锚点，才单独定义它的用途。
> - 每个需要追踪的可见主体使用稳定的 `<Subject N>`，定义其身份、外观特征和参考图片。独立人物各用自己的个人图和唯一 Subject；个人三视图的多个视角仍是同一个人。群像图只定义一个整体 Subject，不得再定义或指认成员 Subject，不得让整体 Subject 与个人 Subject 指向同一个人。Subject 定义一次，后续动作与发声始终引用该标签。视频正文用 `<Subject N>` 指代已定义的人物或物件，在首次出现时说明画面位置与动作，不反复插入中文人名。人物中文名保留在代码围栏外的角色绑定表、素材映射和故事走向中；若姓名确实被说出或显示在画面中，保留在相应台词或可见文字里。
> - **禁止项目内部编号**：视频提示词整个 text 围栏不含 C/A/N 加四位数字的角色/素材/旁白 ID，也不含 S 加四位数字的项目镜号；身份说明、括号备注、动作正文中都不能添加。只保留本条请求的 Picture、Subject、Audio、Video、Shot 和发声者标签，身份查表关系写在围栏外。
> - Subject 不是上传素材，不添加 `ref_subject_N` 参数或 Subject 映射行。上传表仍用 `ref_image_0` → `<Picture 1>`、`ref_audio_0` → `<Audio 1>`，编号与视频提示词一致。首帧 GPT 附件的一图一文件规则不变。
> - `(S1)`、`(S2)` 是本条视频的实际发声者编号，按首次发声顺序分配；无发声角色不分配。它与镜号、角色 ID、Subject 编号及 Audio 编号分别编号。切镜或画内转画外时沿用同一发声者 ID；下一条独立请求重新定义。
> - Audio 定义使用官方英文句式，例如 `<Audio 1> is the voice-timbre reference for <Subject 2> (S1).`。只借音色时明确不复制样本原对白；每句台词在对应镜头动作中再次引用 `<Audio N>`，例如 `<Subject 2> (S1) speaks on screen in a firm voice, using the timbre of <Audio 1>: <d>[Chinese] 台词.</d>`。多人发声分别绑定，不能靠素材顺序推测音色归属。
> - 没有可见主体的系统声或旁白，用稳定的英文声音描述和 `(Sx)` 绑定 Audio，不虚构 Subject，例如 `<Audio 2> is the voice-timbre reference for the off-screen system voice (S2).`。画外发声正文也用英文描述；若声音属于已有可见主体，继续使用其 `<Subject N> (Sx)`。
> - `<d>[Chinese] ...</d>` 保留中文原词，标点按官方 5.4 使用基本英文书写符号。完整陈述句、疑问句、感叹句在 `</d>` 前分别以 `.`, `?`, `!` 结尾；句内逗号和句号也用 `,`、`.`，去除重复或装饰性标点，不以 `。？！` 收尾。只参考音色时不复制样本原对白；确需复用或重演参考音频台词时保留原词及语言，听不清的部分写 `[unclear]`。
> - 内心独白写明 off-screen voiceover，并说明可见角色闭口。`<d>[Chinese] 台词.</d>` 成对闭合；`<Picture N>`、`<Subject N>`、`<Audio N>`、`<Video N>` 是引用标签，没有结束标签。不要增加自创控制标记。无台词镜头不编造 Audio 或发声者 ID。

> **视频提示词画面与发声规则（必须遵守）**：
> - 清楚区分动作描述与实际台词，按上述 Subject、发声者 ID、Audio 绑定规则写明谁说什么。格式正确仍需实际生成验证，不能把串音直接归因为中文或某一种标点。
> - **只写镜头能拍到、耳朵能听到的东西**：场景与道具状态、人物动作与走位、脸上和手上的可见变化、光线与摄影机行为、环境音效。不要写小说作者对读者的讲解。
> - **不要用破折号串联动作或代替正常标点。** 视频提示词正文用英文 `From X to Y seconds, ...` 标示时间段；不用 `—` 或 `——` 分隔动作、补充说明、转折或因果，应改用逗号、句号、分号和完整句，必要时补出动作主体及先后关系。人物台词只有确实表现突然中断时才可偶尔使用破折号，不能把它当作节奏标点反复出现。
> - **错误·破折号串动作**：`0—3秒：秦墨抬手——掌心亮起蓝光——石门随即打开。`
> - **正确·自然标点**：`From 0 to 3 seconds, <Subject 1> raises his right hand. Blue light appears in his palm, sweeps across the stone gate, and the gate opens to both sides.`
> - **`### 故事走向` 可以写心理、回忆、设定、因果。** 写视频提示词时必须翻译成可见动作，或交给角色发出；禁止把故事走向里的解释句原样搬进英文动作时间段。
> - **关键因果不能只留在故事走向里**：按「叙事清晰与单集容量」核对信息与镜号。删去小说说明后，必须仍有能传达必要信息的画面证据或台词；不能用皱眉、握拳等泛化反应代替具体事实。
> - **删掉破折号不够。** 「动作——解释」里，破折号只是记号。把「——」改成逗号或句号，但留下「仿佛在回忆某件往事」「东西还在，它真的没有消失」「那是兴奋和难以置信」「这在以前绝不可能」「即使前路再难，他也决不后退」这类句子，模型照样会念。禁止的是说明本身，不是某个标点。
> - **禁止出现的内容**（无论有没有破折号）：观众看不见的心理分析、回忆内容、设定注解、作者评论；用「仿佛…」「心中涌起…」「他能感受到…」「那是…」「这在以前…」「即使…他也…」带出的讲解；抽象情绪后面再跟一句解释。
> - **需要交代的信息必须有发声主体**：此要求适用于选择用语言传达的信息；画面已清楚表达的事实不必再念一遍。需用语言补足时，让画面中的角色画内说出，或标明为内心独白（画外、不张嘴）。必须写清 `<Subject N> (Sx)` 或稳定的画外声音名称、画内或画外、使用 `<Audio N>`、语气，台词放进 `<d>[Chinese] …</d>`。没有主体的叙述不能当台词用。
> - **错误**（后半句会被念出来）：`2—4秒：王建国猛地睁开眼，瞳孔放大，惊喜与震惊交织。东西还在，它真的没有消失。他深呼吸，努力让自己冷静下来。`
> - **正确·只写画面**：`From 2 to 4 seconds, <Subject 1> opens his eyes sharply and studies his hands. He briefly closes his eyes, opens them again with a small smile, and steadies his breathing.`
> - **正确·信息改由角色发出（内心独白）**（已定义秦墨为 Subject 1、发声者 S1，并绑定 Audio 1）：`From 2 to 4 seconds, <Subject 1> opens his eyes sharply and looks at his hands. <Subject 1> (S1) speaks in a low, disbelieving off-screen voiceover, using the timbre of <Audio 1>: <d>[Chinese] 还在, 真的还在.</d> <Subject 1> keeps his lips closed.`
> - **正确·信息改由角色发出（画内说）**（同上绑定）：`From 1 to 3 seconds, <Subject 1> clenches his fist. <Subject 1> (S1) speaks on screen in a hushed voice, using the timbre of <Audio 1>: <d>[Chinese] 成了, 真的成了.</d>`
> - **写完自检**：把未包在 `<d>` 里的句子大声念一遍。若听起来像小说作者在讲解，而不是导演在说「谁做什么」，必须删掉或改成有主体的台词。

> **视频提示词对白合写规则（必须遵守）**：
> - **同一时间段的说话动作与对白合写一段**：直接包含 `<Subject N> (Sx)`、动作、画内或画外、使用 `<Audio N>` 的音色、必要语气及完整台词；正文用英文，台词保留中文。
> - **禁止**先写「嘴在说话／开口训斥」等动作，再另起一段「某某画内对白（起止秒…）」重复同一时间段。
> - **正确示例**（先定义角色A为 Subject 1、角色B为 Subject 2，Audio 1 绑定 Subject 1 的发声者 S1）：`From 0 to 3.5 seconds, <Subject 1> points angrily at <Subject 2>. <Subject 1> (S1) speaks on screen in an irritated voice, using the timbre of <Audio 1>: <d>[Chinese] 你又迟到了!</d> <Subject 2> lowers their head and nods.`
> - **错误示例**：时间线只写「嘴在说话」，文末再单列 `王建国画内对白（0.5—3.5秒…）：<d>…</d>`。
> - 人物对话、画内对白、同场画外对白及人物内心独白，都写进对应时间段；每句人物台词在本镜视频提示词中只出现一次。内心独白须标明为内心发声，不写成开口说话。
> - 用户确认使用旁白时，**旁白**可在同一围栏内单独成段（写明发声区间、音色、语气、内容），也可合入时间段；人物内心独白与画外说话不能改标为旁白后单列。用户确认不使用旁白时，视频提示词中不写旁白段落，也不引用旁白音色。
> - 章首声音安排表仍保留，与提示词中的台词一致；发声时间只在视频提示词中记录。

> **时间分段规则**：
> - 按本镜动作与台词节奏自行划分秒数，**不要**每镜固定套用 `From 0 to 0.5 seconds, the frame holds still.`。
> - 需要短暂起势时可写英文提示词（如 `From 0 to 0.5 seconds, hold the opening pose.`），不需要则动作从 0 秒直接开始。
> - 分段只服务于可见动作的起势、发展与结果；不为凑时长硬加空白停顿。

### 格式要点汇总

1. 角色绑定表固定四列，分隔行固定为 `|---|---|---|---|`，不得多列或少列
2. 角色出场关系只在每镜 `角色：` 字段维护，不在角色表重复登记
3. **声音安排表只放有台词的镜**，无台词不要写占位行
4. 路径写在行内代码或 Markdown 链接内，空项用 `—`
5. 带空格的路径使用 `[名称](<相对路径>)` 格式
6. 不得凭空编造已存在的素材文件名
7. 首帧标签固定为 `**首帧图片提示词**`
8. 视频标签固定为 `**视频提示词｜duration=N，resolution=WxH**`（注意 `｜` 是全角竖线）
9. 标签后紧跟一个 `text` 代码围栏，围栏内为完整提示词
10. `出图文件名：` 和 `视频文件名：` 独占一段，附件说明另起段落
11. 默认文件名：`四位集号 首帧_S编号.png`、`四位集号 S编号.mp4`、`四位集号 素材_名称.png`
12. 素材映射编号：`ref_image_0` → `<Picture 1>`，`ref_audio_0` → `<Audio 1>`；编号连续递增
13. 动作时间线用英文 `From X to Y seconds, ...` 分段描述，**按节奏自定**，不强制前 0.5 秒静态；**人物对白合入对应时间段**，不另起「画内对白」段
14. 台词用 `<d>[Chinese] 内容.</d>` 包裹，按句型以 `.`, `?`, `!` 紧贴 `</d>` 收尾，嵌在该秒数动作句中；可见发声者使用已定义的 `<Subject N> (Sx)`，无可见主体的声音使用稳定名称与 `(Sx)`，逐句引用对应 `<Audio N>`
15. **视频时间线只写可拍画面与有发声主体的台词**；禁止小说式说明、心理讲解、无主体叙述（删破折号留下原句同样禁止）
16. **视频提示词正文不用 `—` 或 `——` 串动作或代替正常标点**；改用自然英文完整句，台词仅在确需表现突然中断时偶尔使用
17. 角色图由角色表管理，素材表不重复列入正式角色图；**群像进素材表**
18. 每镜 `角色：` 字段必填，所列 ID 必须在角色表中存在
19. **GPT附件每个 `图片N` 只对应一个文件**；多角色用分号分隔并连续编号，提示词按角色点名对应编号
20. 群像只能整体引用，不可单独指认成员；需独立识别的人物各用个人图和 Subject，不能与包含同一人的群像混用
21. 视频提示词整个 text 围栏禁止项目角色、素材、旁白与镜号等内部编号；围栏外保留查表关系，围栏内只用本条请求的引用与发声者标签

## 交付前的 Markdown 自检（大纲 / 全剧人物与对白 / 每一集）

> 写入或改写**任意** `.md` 后都要检查；不只针对分集。

- **标准 Markdown**：文件可被 GFM 正确渲染；表格每行真换行，分隔行合法，没有 `||` 粘行。

## 每集生成后的自检清单

> **在输出每集内容之前，必须逐条检查以下项目。** 叙事由创作 agent 审核，客户端只能检查部分格式与引用一致性，不能代替观众理解检查。

- **单集任务与容量**：连续故事底稿成立；本集围绕一个核心任务，重复信息已合并，支线没有挤掉必要的因果、反应和阅读时间。
- **脱离说明仍能理解**：遮住大纲、梗概、镜头标题与故事走向，仅凭画面和台词能解释主要选择；每条必要信息都有具体镜号与视听依据。
- **时间参照一致**：日期、事件间隔、期限与倒计时指向同一套时间基准；观众能辨认必要的时间线切换。
- **行动与结果有依据**：换场承接当前目标；资源、权限等前提已建立；结尾有实际变化，钩子由变化产生。
- **全剧对白先行**：已先完成全剧人物登记与所有分集对白，再写第0001集；对白稿、各集声音安排及视频实际台词一致。
- **对白自然度与容量**：正文与拆分后的台词逐字一致，未因时长压缩台词或按字数补词；每次发言和整镜均容得下停顿、动作与余量。超时已移动分界或增加S单元，并同步相关引用，真正的硬性规格冲突已记录。
- **首帧承接明确**：承接镜的首帧图片提示词仅为“上一镜尾帧”，前后状态相容；本镜出图文件名与视频首帧映射一致，供用户手动上传尾帧，没有新增字段或承接表。
- **镜头时长合理**：按动作、对白和阅读时间分配，符合接口限制；不为凑固定镜数或等长时长加入重复动作。

- **路径包在反引号内**：角色图、音色文件、素材文件路径都必须写成 `` `路径` ``，不要写成裸文本。
- **角色表严格四列**：表头、分隔行和每条数据行都是四个单元格；出场关系只在每镜 `角色：` 字段维护。
- **台词表角色一致**：声音安排表中的角色 ID 和角色名称必须与角色绑定表一致。
- **台词表只列有台词的镜**：无对白的分镜不要出现在声音安排表中。
- **旁白选择一致**：若用户确认不使用旁白，角色表无 `N0001` 旁白，声音安排表无旁白台词，视频素材映射无旁白音色，视频提示词无旁白段落。
- **每镜有 `角色：` 字段**：每个分镜必须有且只有一行 `角色：` 字段。
- **每镜有三个区**：标题必须是精确的 `### 故事走向`、`### 首帧生成`、`### 视频生成`，**标题后不要加冒号**。
- **角色图用三视图模板**：角色参考图提示词必须使用三视图模板（左全身正面 / 中面部特写 / 右侧面全身）；场景、道具与群像不要套用三视图。
- **提示词标题可匹配**：`## 本集新增素材生成提示词` 下的三级标题中的名称，必须与角色表的名称或素材表的名称一致。
- **GPT附件一图一号**：每个 `图片N＝…（\`文件\`）` 只绑一个文件；多角色写成 `图片2＝…；图片3＝…`，禁止同一括号内用顿号并列多个路径。首帧提示词按「角色名外貌与服饰沿用图片N」逐条写，禁止「图片N中的两个角色」。
- **首帧已显式写入画面风格**：独立生图的每个首帧图片提示词在画幅比后直接写出用户确认的完整核心风格词，与角色图、场景图和视频提示词一致；没有只靠附件暗示风格，没有写「风格同参考图」代替具体风格，也没有遗留方括号占位文字。尾帧承接镜的首帧提示词仅保留“上一镜尾帧”，不按生图风格要求补写。
- **群像只作整体**：背景群像只整体引用并对应一个 Subject，没有按姓名、位置、衣着提取成员，没有个人动作、对白或音色绑定；需要独立识别的人物各有个人图和 Subject，没有群像/个人身份重叠，也没有重复定义同一个 Subject。
- **视频提示词无项目编号**：逐条检查视频 text 围栏所有段落（含 Subject/Audio 定义与括号备注），未出现 C/A/N 加四位数字的 ID 或 S 加四位数字的项目镜号；保留合法引用标签、`[Shot N]` 和发声者 `(Sx)`。
- **组合素材按镜头拆用**：组合图只用于组成项共同出镜的镜头；单独使用其中一项时，只引用该项的独立图片，没有附带组合图或其他未用组成项。逐镜附件与上传映射只包含本镜实际可见且需要参考的素材。
- **相邻镜可承接**：切到另一主体时，必要时用远景保留上一镜关键人物与群像，避免画面突然只剩两人。
- **视频提示词已写入已确认的画面风格**：`detailed_description` 开头已将用户确认的风格翻成简短英文，并明确沿用 `<Picture 1>` 的风格与渲染；没有遗留方括号占位文字，也没有自行预设用户未确认的风格。
- **主体与发声者对应明确**：首帧 `<Picture 1>` 单独定义；仅用于外观参考的 Picture 不单独定义，而是在英文 Subject 定义中引用；视频正文用 Subject 标签，除台词和画面文字外使用英文；Subject 均能追溯到参考素材；Audio 定义与每句台词中的 Subject、(Sx) 对应一致；纯画外声音有稳定名称；本条请求内发声者编号不随切镜改变。Subject 未被写入上传映射表，所有 Picture/Audio 引用均能在该表找到，未添加不存在的素材。
- **台词边界正确**：每句实际台词只有一对 `<d>...</d>`，中文台词保留原词、使用基本英文标点，完整陈述、疑问、感叹分别以 `.`, `?`, `!` 紧贴 `</d>` 收尾；没有引用标签的伪结束标签或句尾 Audio；内心独白明确闭口，台词未在音效等段落重复。
- **对白合入时间段**：视频提示词里人物说话动作与台词写在同一英文时间段（含 `<Subject N> (Sx)`、画内/画外、`<Audio N>`、语气、`<d>[Chinese]…</d>`）；禁止时间线只写「嘴在说话」再另列「某某画内对白」段。旁白允许单独成段。
- **时间线无小说说明**：未包在 `<d>` 里的句子只描述可拍画面与音效，没有心理分析、回忆讲解、设定注解或作者评论；需要交代的信息已改成画内对白或标明的内心独白，且有发声主体。只删破折号、留下原句视为未通过。
- **正文未滥用破折号**：英文动作时间段没有用 `—` 或 `——` 串联动作、补充说明、转折或因果；正文使用自然标点和完整句，台词中的破折号只用于确实的突然中断且不反复出现。
- **时间分段按节奏**：不要每镜固定写 `From 0 to 0.5 seconds, the frame holds still.`；需要起势再写，不需要则动作从 0 秒开始。
- **复用素材文件名逐字相同**：本集引用已有角色图或场景/道具时，文件名必须与首现集（或已锁定的素材登记）完全一致，禁止改集号前缀。
- **本集首现素材有提示词**：本集第一次出现的角色图或素材，必须在 `## 本集新增素材生成提示词` 下有可匹配的 `### 标题` 和 `text` 围栏。

## 全剧验收（所有集写完后必须做）

> 逐集完成索引登记后，由主 agent 做全剧复查。打开客户端看故事板之前，先按下面核对；漏检会导致后续集改写已有场景的集号前缀，或首现集缺少生成提示词。

- **角色表结构**：每一集的角色表都使用四列；每镜角色关系只在 `角色：` 字段填写。
- **全剧叙事承接**：各集核心任务与实际结果相接，后集继承前集状态；资源、权限与关系变化先有依据，时间基准全剧一致。
- **观众理解检查**：逐集重做脱离说明的连读检查；重要动机、规则与时间关系不能只在大纲或故事走向中成立。
- **跨集文件名**：同一角色图、同一素材 ID，在所有集里的路径必须相同。
- **首现集有提示词**：各集角色表或素材表里出现的每个新文件名，其首现集必须有生成提示词；后续集只引用，不改名。
- **GPT 附件路径**：各镜 GPT 附件里的场景/角色文件名，与该集素材表、角色表一致。
- **全剧画面风格一致**：抽查素材图、独立生图的首帧及各镜视频提示词，均显式带入用户确认的核心风格词；尾帧承接的首帧提示词固定为“上一镜尾帧”，实际画面继承上一镜风格。
- **全剧旁白选择一致**：以大纲记录的旁白决定为准；选择不使用时，所有集均无旁白角色、旁白声音安排、旁白音色引用和旁白台词。

## 注意事项

- Markdown 是唯一的编辑源，所有剧本内容保存在 `.md` 文件中
- 不要手动编辑 `.drama-craft/` 目录下的文件
- 分镜 ID 在同一集内不可重复
- 角色 ID 跨集保持一致
- 伤势、武器、人物关系等状态需跨镜继承，不可突然恢复或消失
- 素材在首次使用集提供完整提示词，后续集引用同一文件；跨集不得改文件名
- 正式分镜一次只写一集；每集检查并更新 `assets.json` 后才能开始下一集，不并行写不同集
- 群像素材跨集复用同一文件名，只整体使用，禁止从中单独引用或指认任何成员；独立人物用自己的个人图
- 独立生图的首帧和所有视频提示词都显式带入用户确认的核心画面风格词；尾帧承接的首帧提示词只写“上一镜尾帧”
- 用户确认使用旁白时，每集最多两处，优先让角色对白自然承接信息；确认不使用时，全剧不添加旁白
- 视频提示词禁止小说式说明；必要信息先用可见证据表达，需用语言补足时由角色说出或使用有发声主体的内心独白，不重复讲解画面已表达的事实
- 检查每次场景切换的明确目的，确保结尾不仅有转折还有实际结果；相邻镜注意空间承接
"#
    )
}

#[derive(Debug, Serialize)]
pub struct Media {
    pub reference: String,
    pub path: Option<String>,
    pub exists: bool,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
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
        revision: resolved.as_ref().and_then(|path| media_revision(path)),
        path: resolved.map(|p| p.to_string_lossy().into_owned()),
        kind: kind.into(),
    })
}

fn normalize_image_ext(ext: &str) -> String {
    let lower = ext.to_lowercase();
    if lower == "jpeg" {
        "jpg".into()
    } else {
        lower
    }
}

/// Copy a local image into the episode document directory using the Markdown reference name.
pub fn place_document_media(
    root: &Path,
    document: &str,
    reference: &str,
    source: &str,
) -> Result<Media> {
    let doc = document_path(root, document, true)?;
    let value = reference
        .trim()
        .trim_start_matches('<')
        .trim_end_matches('>');
    let rel = Path::new(value);
    if value.is_empty()
        || rel.as_os_str().is_empty()
        || rel.is_absolute()
        || value.contains("://")
        || value.starts_with("\\\\")
        || value.starts_with("//")
        || rel.components().any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(AppError::new(
            "path",
            "素材路径必须是文档旁的项目内相对路径",
        ));
    }
    for part in rel.components() {
        let name = part.as_os_str().to_string_lossy();
        validate_name(&name)?;
        if ignored(&name) {
            return Err(AppError::new("path", "不能写入隐藏或应用管理目录"));
        }
    }
    let target_ext = rel
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let target_kind = normalize_image_ext(target_ext);
    if !matches!(target_kind.as_str(), "png" | "jpg" | "webp" | "gif" | "bmp") {
        return Err(AppError::new("media", "仅可写入图片素材"));
    }
    let source = fs::canonicalize(source)?;
    if !source.is_file() {
        return Err(AppError::new("media", "请选择图片文件"));
    }
    let source_ext = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if normalize_image_ext(source_ext) != target_kind {
        return Err(AppError::new(
            "media",
            format!("请选择 .{target_ext} 图片，以匹配文档中的文件名"),
        ));
    }
    let parent = doc
        .parent()
        .ok_or_else(|| AppError::new("path", "文档缺少父目录"))?;
    let destination = parent.join(rel);
    if let Some(folder) = destination.parent() {
        fs::create_dir_all(folder)?;
        let canonical_folder = fs::canonicalize(folder)?;
        if !canonical_folder.starts_with(root) {
            return Err(AppError::new("path", "路径超出项目目录"));
        }
    }
    let mut current = parent.to_path_buf();
    for part in rel.components() {
        current.push(part.as_os_str());
        if let Ok(meta) = fs::symlink_metadata(&current) {
            if meta.file_type().is_symlink() {
                return Err(AppError::new("path", "不写入链接文件或链接目录"));
            }
        }
    }
    let bytes = fs::read(&source)?;
    if fs::canonicalize(&destination).ok().as_ref() == Some(&source) {
        return resolve_media(root, document, reference);
    }
    replace_file(&destination, &bytes)?;
    resolve_media(root, document, reference)
}

fn media_revision(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let elapsed = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(format!("{}-{}", elapsed.as_millis(), meta.len()))
}

fn displaced_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    path.with_file_name(format!(".~dc-replacing-{}-{name}", Uuid::new_v4().simple()))
}

fn overwrite_in_place(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).truncate(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        options.share_mode(0x00000007);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// Replace `path` with `bytes` while keeping the original filename.
///
/// Windows cannot `MoveFileExW(REPLACE_EXISTING)` while WebView still has the
/// displayed image open. Displace the original first, then fall back to an
/// in-place truncate write so the Markdown name never changes.
pub(crate) fn replace_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if !path.exists() {
        return atomic_write(path, bytes, true);
    }
    let displaced = displaced_sibling(path);
    if fs::rename(path, &displaced).is_ok() {
        let written = atomic_write(path, bytes, true);
        if written.is_ok() {
            let _ = fs::remove_file(&displaced);
        } else {
            let _ = fs::rename(&displaced, path);
        }
        return written;
    }
    overwrite_in_place(path, bytes)
}

pub(crate) fn replace_file_from(path: &Path, source: &Path) -> Result<()> {
    if source == path {
        return Ok(());
    }
    if !source.is_file() {
        return Err(AppError::new("io", "裁切结果未生成"));
    }
    if !path.exists() {
        return persist_as(source, path);
    }
    let displaced = displaced_sibling(path);
    if fs::rename(path, &displaced).is_ok() {
        let written = persist_as(source, path);
        if written.is_ok() {
            let _ = fs::remove_file(&displaced);
        } else {
            let _ = fs::rename(&displaced, path);
        }
        return written;
    }
    overwrite_in_place_from(path, source)?;
    let _ = fs::remove_file(source);
    Ok(())
}

fn persist_as(source: &Path, dest: &Path) -> Result<()> {
    match fs::rename(source, dest) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(source, dest)?;
            fs::remove_file(source)?;
            Ok(())
        }
    }
}

fn overwrite_in_place_from(path: &Path, source: &Path) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).truncate(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0x00000007);
    }
    let mut dest = options.open(path)?;
    let mut src = fs::File::open(source)?;
    io::copy(&mut src, &mut dest)?;
    dest.sync_all()?;
    Ok(())
}
