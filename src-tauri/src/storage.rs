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
        "# 故事大纲\n\n## 故事背景\n\n> 在此填写世界观、时代、基本设定。\n\n## 人物与目标\n\n> 列出主要角色及其性格、动机、关系。包括外貌特征简述，便于后续生成角色参考图。\n>\n> 示例格式：\n> - **角色名**：种族/外貌特征，性格，动机，与其他角色的关系\n\n## 完整故事\n\n> 完整故事梗概（3–5 段），含主要转折点。从开头写到结尾，不留悬念。\n\n## 分集规划\n\n> 每集核心事件与转折。按剧情自然划分章节，不预先硬凑集数。\n>\n> 示例格式：\n>\n> | 集 | 名称 | 剧情任务 |\n> |---|---|---|\n> | 01 | 集名 | 本集核心事件 |\n\n## 旁白、对白与设计约束\n\n> 可选章节。用于记录：\n> - 旁白使用限制（如每集最多几处）\n> - 台词时长估算（每秒 4—5 字）\n> - 连续性注意事项（伤势、武器、人物关系的跨镜继承）\n> - 后续设计的约束和检查清单\n",
    )?;
    create_document(
        &root,
        "分镜总表.md",
        "# 分镜总表\n\n> 全剧分镜索引。按集展开，汇总每镜的时间线和剧情动作。\n> 在完成各集分镜剧本后统一填写，或由 AI 根据各集内容自动汇总。\n\n## 每集入口与时间线\n\n| 集 | 名称与提示词文件 | 镜号范围 | 镜数 | 秒数 | 剧情任务 |\n|---|---|---|---:|---:|---|\n\n## 分镜明细\n\n| 镜号 | 集 | 镜头名 | 秒数 | 集内起止 | 全片起止 | 本镜动作 | 声音／发声区间 |\n|---|---|---|---:|---|---|---|---|\n",
    )?;
    let voice_catalog = scan_voice_catalog(voice_source);
    let agents_content = agents_md(
        name,
        character_source.map(|p| p.to_string_lossy().into_owned()),
        &voice_source.to_string_lossy(),
        &voice_catalog,
    );
    create_document(&root, "AGENTS.md", &agents_content)?;
    Ok(root)
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
                && has_extension(
                    e.path(),
                    &["mp3", "wav", "flac", "ogg", "m4a"],
                )
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
        let mut table = String::from(
            "| 文件名 | 性别 | 年龄段 | 角色名 | 声音特征 |\n|---|---|---|---|---|\n",
        );
        for file in voice_catalog {
            let stem = file.rsplit('.').last().unwrap_or(file);
            let parts: Vec<&str> = file
                .rsplit('.')
                .nth(1)
                .unwrap_or(stem)
                .split('_')
                .collect();
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

1. **计划多少集？**（建议 8—20 集，每集 1—2 分钟）
2. **每集大约几个分镜？**（建议 10—18 镜，每镜 3—6 秒）
3. **画面风格偏好？**（写实、动漫、3D渲染、水墨、像素风等）
4. **横竖屏？**（默认 16:9 横屏 480p；也可选 9:16 竖屏）

如果用户不确定，给出推荐默认值：12 集 × 每集约 15 镜 × 每镜 5 秒 ≈ 每集 75 秒。

### 第三步：构思故事大纲

根据题材和集数，与用户共同完成 `剧本大纲.md`：

1. 先提出 2—3 个故事方向供用户选择或融合
2. 用户选定方向后，写出完整大纲，包含：
   - **故事背景**：世界观、时代、基本设定
   - **人物与目标**：主要角色（3—6 个）及其性格、动机、外貌特征、关系
   - **群像角色（如有）**：会跨镜复用的村民、看客、跟班、伙计等；须命名，后续做成群像素材图，不能只写在大纲里
   - **完整故事**：从开头到结尾的完整梗概（3—5 段），含主要转折
   - **分集规划**：每集一行，写明核心事件与转折
   - **旁白与对白约束**：台词时长估算、旁白限制、连续性注意事项
3. 将大纲写入 `剧本大纲.md`，请用户确认
4. **凡写入项目的 `.md` 文件**（大纲、分镜总表、各集分镜与提示词）都必须是标准 Markdown，见下方「标准 Markdown」节

### 第四步：逐集生成分镜剧本

用户确认大纲后，按集顺序生成每一集的完整分镜剧本：

1. 每集一个 `.md` 文件，文件名 `01 集名.md`、`02 集名.md`……
2. 每集必须包含：角色绑定表、素材表、新增素材提示词、声音安排表、所有分镜
3. 每个分镜必须包含：故事走向、首帧图片提示词、视频提示词
4. 文件必须符合「标准 Markdown」与「分集剧本格式（v1）」；表格、路径、标题写坏会导致客户端预览失败或报错
5. **建议一次生成 1—2 集**，与用户确认质量后再继续

生成时注意：
- 角色 ID 跨集保持一致（C001 始终是同一角色）
- 前几集要为所有角色、场景和**会复用的群像**提供素材生成提示词
- 素材不只是「场景 + 主角 + 道具」：跨镜出现的跟班、村民、看客等必须进素材表并挂参考图
- 相邻镜切换主体时注意画面承接：若上一镜角色A在场，下一镜切到角色B视角，可用远景把角色A及其随从仍留在画内，避免画面突然只剩两人、空间跳切过硬
- 每镜台词按每秒 4—5 字估算，不超时
- 伤势、道具、关系等状态跨镜继承，不可遗忘

### 第五步：生成分镜总表

所有集完成后，汇总全剧分镜到 `分镜总表.md`，包含：
- 每集入口与时间线
- 所有分镜的明细表（镜号、集、镜头名、秒数、起止时间、动作、声音）
- 素材总索引
- 总表内的 Markdown 表格同样必须真换行、分隔行合法，遵守「标准 Markdown」

### 第六步：交付确认

最后提醒用户：
1. 所有文件已生成，可在 DramaCraft 客户端打开本目录查看故事板
2. 在客户端中逐镜生成首帧图片（用提示词通过三方图片 API 生成，或手动上传）
3. 配置视频 API 后，点击生成即可逐镜产出视频
4. 如需修改某一集或某一镜，直接编辑对应的 `.md` 文件

---

## 目录结构

```
{project_name}/
├── .drama-craft/          # 项目元数据（勿手动编辑）
│   └── project.json
├── AGENTS.md              # 本文件 — 项目结构与创作引导
├── 剧本大纲.md            # 故事大纲、角色设计、分集规划
├── 分镜总表.md            # 全剧分镜索引（完成后汇总）
├── 01 集名.md             # 第01集分镜剧本
├── 02 集名.md             # 第02集分镜剧本
└── …                      # 更多集数
```

## 素材库

- 角色图目录：`{char_dir}`
- 声音样本目录：`{voice_directory}`

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
| 旁白 | 画外解说 | `男声_青年_旁白_清亮通透.MP3` | 旁白专用音色 |

为角色选择音色时：
1. **优先读取声音目录**：如果你有文件系统访问权限，直接读取 `{voice_directory}` 目录获取最新文件列表
2. **无法访问时用下方快照**：以下是创建项目时扫描到的音色文件（可能不是最新的）
3. **只按性别＋年龄段＋声音特征匹配**：忽略文件名中的样本标签，根据角色的性别、年龄和性格选择最贴合的音色
4. **音色文件路径格式**：在角色绑定表中，把声音目录和文件名拼成完整路径，用正斜杠 `/` 连接。例如：若声音目录为 `F:/声音库`，文件为 `男声_青年_旁白_清亮通透.MP3`，则写 `F:/声音库/男声_青年_旁白_清亮通透.MP3`
5. **同一音色可供多个角色使用**：如果没有完美匹配，选择最接近的；不同角色可以使用同一个音色文件

#### 可用音色列表（创建时快照）

{voice_table}

> 如果用户后续添加了新的音色文件，请优先扫描声音目录获取最新列表。

---

## 格式规范

> 以下是 DramaCraft 客户端解析剧本所需的格式规范。
> 生成内容时**必须严格遵守**，否则客户端无法正确识别分镜和素材。

### 标准 Markdown（项目内全部 `.md` 通用）

**适用范围**：`剧本大纲.md`、`分镜总表.md`、`01 集名.md` / `02 集名.md` 等每一集分镜与提示词文件，以及本项目中后续新增的任意 `.md`。  
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
| C001 | 程寒 | 32岁 |
| C002 | 苏晚晴 | 29岁 |
```

错误示例（禁止）：把多行写成 `| C001 | … || C002 | … |`，或分隔行写成 `|::---|`。

### 分集剧本格式（v1）

每集为独立 `.md` 文件，文件名建议 `01 集名.md`、`02 集名.md`。

#### 文件头

**首行必须**是（独占一行，不可省略）：

```
<!-- drama-craft:episode:v1 -->
```

紧接一级标题 `# 第01集 集名`，再接一段 `本集内容：本集梗概文字`。
可选补充本集镜数和总时长，例如：`本集13镜，合计68秒（01:08）；每镜独立请求，16:9横屏。`

#### 角色绑定（必须）

`## 角色绑定`，表格列及顺序**不可更改**：

```
| 角色ID | 名称 | 角色图 | 音色文件 | 使用镜号 |
```

- 角色 ID 用 `C001`、`C002`……旁白用 `N001`
- 同一作品**跨集保持 ID、名称及已确定的声音一致**
- 角色图写相对路径或角色库绝对路径；旁白可以没有角色图，写 `—`
- **音色文件必须从声音目录已有文件中选择**（参见上方「可用音色列表」），根据角色的性别、年龄和性格匹配最贴合的音色；文件名中的样本标签不是剧本角色名，禁止编造不存在的文件名
- **所有路径必须包在反引号内**（行内代码），例如 `` `01 素材_秦墨.png` ``、`` `F:/声音库/男声_青年_旁白_清亮通透.MP3` ``；不要写成裸文本。音色路径格式：声音目录 `/` 文件名，用正斜杠连接
- 使用镜号**逐项列出**：`S001、S002、S003`，**不用范围缩写**
- **使用镜号必须与分镜完全一致**：角色绑定表中某角色的使用镜号，必须与下方所有分镜 `角色：` 字段中包含该角色 ID 的列表完全一致。例如 C001 出现在 S001、S003、S005 的 `角色：` 中，则角色绑定表 C001 的使用镜号必须写 `S001、S003、S005`——不多不少

完整示意行：

```
| C001 | 秦墨 | `01 素材_秦墨.png` | `F:/声音库/男声_青年_程寒_年轻利落.mp3` | S001、S002 |
| N001 | 旁白 | — | `F:/声音库/男声_青年_旁白_清亮通透.MP3` | S001 |
```

#### 素材表（必须）

`## 本集使用素材`，表格列及顺序**不可更改**：

```
| 素材ID | 名称 | 类型 | 文件 | 使用镜号 |
```

- 素材 ID 用 `A001`、`A002`……
- 类型写**场景、道具、状态变体或群像**
- **群像**：跨镜复用的村民、看客、跟班、伙计等；做成一张群像参考图（可多人同框），文件如 `` `01 素材_内门跟班.png` ``，再在各镜 GPT 附件中引用。禁止把会复用的群演只写成文字指望跨镜脸一致
- 角色参考图由角色表管理，不重复作为独立素材；群像不是正式角色，进素材表，不要塞进角色绑定表（除非需要配音）
- **路径必须写在行内代码或 Markdown 链接内**，例如 `` `01 素材_外门庭院.png` ``；空项用 `—`；不要写成裸文本
- 不得凭空编造已存在的素材文件名

#### 新增素材生成提示词（推荐）

在素材表之后、声音安排之前，为本集**首次出现**的场景、道具、群像和角色参考图提供完整生成提示词。

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

**群像提示词**：用于村民、看客、跟班等可复用群众；**不要**套用三视图。做成一张「多人同框、纯白背景」的群像参考图，每人写清可区分外形；后续各镜只写「XX外貌与服饰沿用图片N」，不要每镜重写外貌。

```text
16:9横向单幅画面。[已确定的画面风格]。
纯白色背景，群像站位，角色居中，展示完整全身。
[群像名]：共N人。甲：脸型/发型/服饰……；乙：……；丙：……。
站姿自然，神情符合身份。禁止任何文字、字幕、水印、场景背景和多余角色。
```

```markdown
## 本集新增素材生成提示词

### 王宫大殿

生成后保存为：`01 素材_王宫大殿.png`。

\```text
16:9横向单幅无人物场景母版。[已确定的画面风格]。详细的场景描述……
\```

### 内门跟班

生成后保存为：`01 素材_内门跟班.png`。

\```text
16:9横向单幅画面。[已确定的画面风格]。
纯白色背景，群像站位，角色居中，展示完整全身。
内门跟班：共两人。一人圆脸、浓眉，发髻较低，穿灰蓝色内门弟子服；另一人瘦长脸、细眼，发髻更高，穿灰白色内门弟子服。
站姿自然，神情讥讽顺从。禁止任何文字、字幕、水印、场景背景和多余角色。
\```

### 林逸

生成后保存为：`01 素材_林逸.png`。

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
| 镜号 | 角色ID | 发声方式 | 台词 | 发声区间 |
```

- **只列有台词的镜**：无对白的分镜不要放进声音安排表，不要写 `| S002 | — | — | — | — |` 这样的占位行
- 发声方式写**画内、画外或旁白**
- 角色 ID 必须在本集角色表存在
- 同一镜有多人说话时，每人一行（镜号可重复）
- 没有台词的集仍保留空表头（只有列头，没有数据行）
- 该表与视频提示词中的台词应一致

#### 分镜结构

每镜以 `## S001 镜头名` 开头，S 编号在本集内唯一。

**`角色：` 字段为必填**，列出本镜出场或发声的角色 ID，用顿号分隔；没有角色写 `角色：—`。

每镜依次包含 `### 故事走向`、`### 首帧生成`、`### 视频生成`。  
**标题必须写全称且不要加冒号**：写成 `### 故事走向`，**禁止** `### 故事走向：`；`### 首帧生成` / `### 视频生成` 同理。

```markdown
## S001 镜头名

角色：C001、N001

### 故事走向

描述本镜动作、剧情变化或结果（纯文本段落）。

### 首帧生成

出图文件名：`01 首帧_S001.png`。

GPT附件：**图片1＝场景母版（`01 素材_场景.png`）；图片2＝角色A参考图（`角色A图路径`）；图片3＝角色B参考图（`角色B图路径`）；图片4＝内门跟班群像（`01 素材_内门跟班.png`）**。

**首帧图片提示词**

\```text
16:9横向单幅画面。场景布局与光线沿用图片1。角色A外貌与服饰沿用图片2。角色B外貌与服饰沿用图片3。内门跟班外貌与服饰沿用图片4。
不复制参考图的白底、拼版或站姿。
中景或远景：写清景别与人物站位。跨镜复用的群像必须引用群像素材图；仅一次性背景人可用文字外形带过。相邻镜切换时，可把上一镜关键人物留在远景，避免画面突然只剩两人。
只画动作开始前的静态一刻；只输出单幅画面，无字幕、格线或水印。
\```

### 视频生成

视频文件名：`01 S001.mp4`。

| API参数 | 提示词标签 | 上传素材 |
|---|---|---|
| `ref_image_0` | `<Picture 1>` | `01 首帧_S001.png` |
| `ref_image_1` | `<Picture 2>` | `角色A图路径` |
| `ref_image_2` | `<Picture 3>` | `角色B图路径` |
| `ref_image_3` | `<Picture 4>` | `01 素材_内门跟班.png` |
| `ref_audio_0` | `<Audio 1>` | `音色文件路径` |

**视频提示词｜duration=5，resolution=480p横**

\```text
<Picture 1>：本镜完整首帧，场景、光线、构图以此为准。
<Picture 2>：角色A外貌参考。
<Picture 3>：角色B外貌参考。
<Picture 4>：内门跟班群像外貌参考。
<Audio 1>：角色音色样本，只借音色说本镜台词，不复述样本原对白。

保持首帧景别和拍摄角度，摄影机位置与焦距不变。

0—3.5秒：角色A手指指着角色B，表情愤怒；角色A使用<Audio 1>的音色在画内说（暴躁训斥）：<d>[Chinese] 你又迟到了！</d>角色B低头点头，不反驳；身后跟班仍立在远景，不抢戏。
3.5—5秒：角色A说完转身走开；角色B缓缓抬头。

音效：环境音描述。
无配乐、字幕或水印。
\```

配音校验：N个汉字；语速按4字/秒，停顿预留0.3秒，估计需X秒；
发声窗口M—N秒，共Y秒。对白完整保留，收尾至少0.5秒，不倍速赶词。
```

> **GPT附件硬性规则（与崩拳等既有漫剧一致）**：
> - **每个 `图片N` 只绑定一个文件**。写成 `图片2＝苏铭参考图（\`01 素材_苏铭.png\`）；图片3＝周元霸参考图（\`01 素材_周元霸.png\`）`。
> - **禁止**把多个角色/素材塞进同一个 `图片N`，例如 `图片2＝角色参考图（\`苏铭.png\`、\`周元霸.png\`）` 或「图片2中的两个角色」。
> - 首帧提示词按角色逐条写清编号：`苏铭外貌与服饰沿用图片2。周元霸外貌与服饰沿用图片3。`，不要写笼统的「角色外貌沿用图片2」。
> - **群像优先做成素材**：会跨镜复用的村民、看客、跟班、伙计等，必须进素材表并生成群像参考图，再在 GPT 附件中引用（如「内门跟班外貌与服饰沿用图片4」）。不要只靠文字描述指望跨镜脸一致。参考崩拳做法：`白石村寨村民`、`兽族看客` 先出群像图，再多镜复用。
> - **仅一次性背景人**：从不复用的路人可用一句外形带过；一旦预判会再出场，立刻升级为群像素材。
> - **相邻镜画面承接**：切到另一主体时，若同一场景未切走，可用远景把上一镜关键人物（含群像）留在画内，避免画面突然只剩两人、空间跳切过硬。
> - 单角色镜可省略图片3；多角色/多道具/群像则继续 `图片4`、`图片5`… 编号连续。
> - 视频映射表同样一格一行上传素材，与 GPT附件编号独立编号（视频的 `<Picture 1>` 通常是本镜首帧，不继承首帧 GPT 的图片序号）。

> **视频提示词对白合写规则（必须遵守）**：
> - **同一时间段的说话动作与对白合写一段**：直接包含正式角色名称、动作、画内或画外、使用 `<Audio N>` 的音色、必要语气及完整台词。
> - **禁止**先写「嘴在说话／开口训斥」等动作，再另起一段「某某画内对白（起止秒…）」重复同一时间段。
> - **正确示例**：`0—3.5秒：王建国手指指着赵铁，表情愤怒，使用<Audio 1>的音色在画内说（暴躁训斥）：<d>[Chinese] 赵铁！你又迟到了！这个月奖金全扣！</d>赵铁低头点头，不反驳。`
> - **错误示例**：时间线只写「嘴在说话」，文末再单列 `王建国画内对白（0.5—3.5秒…）：<d>…</d>`。
> - 人物对话、画内对白、同场画外对白及人物内心独白，都写进对应时间段；每句人物台词在本镜视频提示词中只出现一次。内心独白须标明为内心发声，不写成开口说话。
> - **旁白**可在同一围栏内单独成段（写明发声区间、音色、语气、内容），也可合入时间段；人物内心独白与画外说话不能改标为旁白后单列。
> - 章首声音安排表仍保留，与提示词中的台词和发声区间一致。

> **时间分段规则**：
> - 按本镜动作与台词节奏自行划分秒数，**不要**每镜固定套用 `0—0.5秒：静态保持`。
> - 需要短暂起势时可写（如「0—0.5秒：保持首帧起势」），不需要则动作从 0 秒直接开始。
> - 分段只服务于可见动作的起势、发展与结果；不为凑时长硬加空白停顿。

### 格式要点汇总

1. 使用镜号**逐项列出**（`S001、S002`），不用范围缩写
2. **角色绑定表的使用镜号必须与分镜的 `角色：` 字段双向一致**——遗漏或多写都会报错
3. **声音安排表只放有台词的镜**，无台词不要写占位行
4. 路径写在行内代码或 Markdown 链接内，空项用 `—`
5. 带空格的路径使用 `[名称](<相对路径>)` 格式
6. 不得凭空编造已存在的素材文件名
7. 首帧标签固定为 `**首帧图片提示词**`
8. 视频标签固定为 `**视频提示词｜duration=N，resolution=WxH**`（注意 `｜` 是全角竖线）
9. 标签后紧跟一个 `text` 代码围栏，围栏内为完整提示词
10. `出图文件名：` 和 `视频文件名：` 独占一段，附件说明另起段落
11. 默认文件名：`集号 首帧_S编号.png`、`集号 S编号.mp4`、`集号 素材_名称.png`
12. 素材映射编号：`ref_image_0` → `<Picture 1>`，`ref_audio_0` → `<Audio 1>`；编号连续递增
13. 动作时间线用 `起始—结束秒` 分段描述，**按节奏自定**，不强制前 0.5 秒静态；**人物对白合入对应时间段**，不另起「画内对白」段
14. 台词用 `<d>[Chinese] 内容</d>` 包裹，嵌在该秒数动作句中
15. 角色图由角色表管理，素材表不重复列入正式角色图；**群像进素材表**
16. 每镜 `角色：` 字段必填，与角色表使用镜号一致
17. **GPT附件每个 `图片N` 只对应一个文件**；多角色用分号分隔并连续编号，提示词按角色点名对应编号
18. 跨镜复用的跟班/村民/看客必须有群像参考图；相邻镜注意画面承接，必要时远景保留上一镜人物

## 交付前的 Markdown 自检（大纲 / 总表 / 每一集）

> 写入或改写**任意** `.md` 后都要检查；不只针对分集。

- [ ] **标准 Markdown**：文件可被 GFM 正确渲染；表格每行真换行，分隔行合法，没有 `||` 粘行。

## 每集生成后的自检清单

> **在输出每集内容之前，必须逐条检查以下项目。** 客户端解析器会严格校验这些一致性。

- [ ] **路径包在反引号内**：角色图、音色文件、素材文件路径都必须写成 `` `路径` ``，不要写成裸文本。
- [ ] **使用镜号双向一致**：遍历角色表每一行的使用镜号，确认该角色的 ID 出现在对应分镜的 `角色：` 字段中；同时遍历每个分镜的 `角色：` 字段，确认其中的每个角色 ID 都出现在角色表对应行的使用镜号中。不一致会导致客户端报错。
- [ ] **台词表角色存在**：声音安排表中的每个角色 ID 必须在角色表中定义。
- [ ] **台词表只列有台词的镜**：无对白的分镜不要出现在声音安排表中。
- [ ] **每镜有 `角色：` 字段**：每个分镜必须有且只有一行 `角色：` 字段。
- [ ] **每镜有三个区**：标题必须是精确的 `### 故事走向`、`### 首帧生成`、`### 视频生成`，**标题后不要加冒号**。
- [ ] **角色图用三视图模板**：角色参考图提示词必须使用三视图模板（左全身正面 / 中面部特写 / 右侧面全身）；场景、道具与群像不要套用三视图。
- [ ] **提示词标题可匹配**：`## 本集新增素材生成提示词` 下的三级标题中的名称，必须与角色表的名称或素材表的名称一致。
- [ ] **GPT附件一图一号**：每个 `图片N＝…（\`文件\`）` 只绑一个文件；多角色写成 `图片2＝…；图片3＝…`，禁止同一括号内用顿号并列多个路径。首帧提示词按「角色名外貌与服饰沿用图片N」逐条写，禁止「图片N中的两个角色」。
- [ ] **群像有素材图**：会跨镜出现的跟班、村民、看客等已进素材表并挂群像参考图；各镜 GPT 附件引用该图，不只写空名。
- [ ] **相邻镜可承接**：切到另一主体时，必要时用远景保留上一镜关键人物与群像，避免画面突然只剩两人。
- [ ] **对白合入时间段**：视频提示词里人物说话动作与台词写在同一 `起始—结束秒` 段落（含角色名、画内/画外、`<Audio N>`、语气、`<d>[Chinese]…</d>`）；禁止时间线只写「嘴在说话」再另列「某某画内对白」段。旁白允许单独成段。
- [ ] **时间分段按节奏**：不要每镜固定写 `0—0.5秒：静态保持`；需要起势再写，不需要则动作从 0 秒开始。

## 注意事项

- Markdown 是唯一的编辑源，所有剧本内容保存在 `.md` 文件中
- 不要手动编辑 `.drama-craft/` 目录下的文件
- 分镜 ID 在同一集内不可重复
- 角色 ID 跨集保持一致
- 伤势、武器、人物关系等状态需跨镜继承，不可突然恢复或消失
- 素材在首次使用集提供完整提示词，后续集引用同一文件
- 群像素材跨集复用同一文件名，保持跟班/村民/看客外形一致
- 旁白限制使用，每集最多两处，优先让角色对白自然承接信息
- 检查每次场景切换的明确目的，确保结尾不仅有转折还有实际结果；相邻镜注意空间承接
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
    if !matches!(
        target_kind.as_str(),
        "png" | "jpg" | "webp" | "gif" | "bmp"
    ) {
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
    atomic_write(&destination, &bytes, false)?;
    resolve_media(root, document, reference)
}
