pub mod generation;
pub mod settings;
pub mod storage;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use storage::{AppError, Result};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

#[derive(Default)]
struct Sessions(Mutex<HashMap<String, PathBuf>>);
#[derive(Serialize)]
struct Opened {
    handle: String,
    root: String,
    metadata: storage::ProjectMeta,
    warning: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Recent {
    name: String,
    path: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    recent: Vec<Recent>,
    #[serde(default)]
    preview_visible: Option<bool>,
    #[serde(default)]
    generation_base_url: String,
    #[serde(default)]
    generation_configuration: settings::Configuration,
}
fn prefs_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::new("config", e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("preferences.json"))
}
fn read_prefs(app: &tauri::AppHandle) -> Result<Preferences> {
    let path = prefs_path(app)?;
    if !path.exists() {
        return Ok(Preferences::default());
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn with_root<T>(
    state: &State<Sessions>,
    handle: &str,
    action: impl FnOnce(&std::path::Path) -> Result<T>,
) -> Result<T> {
    let sessions = state
        .0
        .lock()
        .map_err(|_| AppError::new("session", "项目会话不可用"))?;
    let root = sessions
        .get(handle)
        .ok_or_else(|| AppError::new("session", "请重新打开项目"))?;
    action(root)
}
fn root_for(state: &State<Sessions>, handle: &str) -> Result<PathBuf> {
    state
        .0
        .lock()
        .map_err(|_| AppError::new("session", "项目会话不可用"))?
        .get(handle)
        .cloned()
        .ok_or_else(|| AppError::new("session", "请重新打开项目"))
}
#[tauri::command]
fn inspect_directory(path: String) -> Result<Vec<storage::Candidate>> {
    let root = storage::canonical_directory(&PathBuf::from(path))?;
    if root.join(".drama-craft/project.json").exists() || storage::direct_markdown(&root)? {
        return Ok(Vec::new());
    }
    storage::candidates(&root)
}
#[tauri::command]
fn open_project(
    app: tauri::AppHandle,
    state: State<Sessions>,
    path: String,
    character_directory: Option<String>,
    voice_directory: Option<String>,
) -> Result<Opened> {
    let root = storage::canonical_directory(&PathBuf::from(path))?;
    if let Some(voices) = voice_directory.as_deref() {
        storage::configure_project(
            &root,
            character_directory.as_deref().map(std::path::Path::new),
            std::path::Path::new(voices),
        )?;
    }
    let (metadata, mut warning) = storage::load_project(&root)?;
    let handle = uuid::Uuid::new_v4().to_string();
    state
        .0
        .lock()
        .map_err(|_| AppError::new("session", "项目会话不可用"))?
        .insert(handle.clone(), root.clone());
    let save_recent = || -> Result<()> {
        let mut prefs = read_prefs(&app)?;
        let path = root.to_string_lossy().into_owned();
        prefs.recent.retain(|r| r.path != path);
        prefs.recent.insert(
            0,
            Recent {
                name: metadata.name.clone(),
                path,
            },
        );
        prefs.recent.truncate(12);
        storage::atomic_write(
            &prefs_path(&app)?,
            &serde_json::to_vec_pretty(&prefs)?,
            false,
        )
    };
    if let Err(e) = save_recent() {
        warning = Some(format!(
            "{} 最近项目保存失败：{}",
            warning.unwrap_or_default(),
            e.message
        ));
    }
    Ok(Opened {
        handle,
        root: root.to_string_lossy().into_owned(),
        metadata,
        warning,
    })
}
#[tauri::command]
fn close_project(state: State<Sessions>, handle: String) -> Result<()> {
    state
        .0
        .lock()
        .map_err(|_| AppError::new("session", "项目会话不可用"))?
        .remove(&handle);
    Ok(())
}
#[tauri::command]
fn create_project(
    app: tauri::AppHandle,
    state: State<Sessions>,
    parent: String,
    name: String,
    character_directory: Option<String>,
    voice_directory: String,
) -> Result<Opened> {
    let root = storage::create_project(
        &PathBuf::from(parent),
        &name,
        character_directory.as_deref().map(std::path::Path::new),
        std::path::Path::new(&voice_directory),
    )?;
    open_project(app, state, root.to_string_lossy().into_owned(), None, None)
}
#[tauri::command]
fn scan_project(state: State<Sessions>, handle: String) -> Result<storage::Scan> {
    with_root(&state, &handle, storage::scan)
}
#[tauri::command]
fn read_document(
    state: State<Sessions>,
    handle: String,
    path: String,
) -> Result<storage::Snapshot> {
    with_root(&state, &handle, |root| storage::read_document(root, &path))
}
#[tauri::command]
fn save_document(
    state: State<Sessions>,
    handle: String,
    path: String,
    text: String,
    expected_hash: String,
) -> Result<storage::Snapshot> {
    with_root(&state, &handle, |root| {
        storage::save_document(root, &path, &text, &expected_hash)
    })
}
#[tauri::command]
fn resolve_media(
    app: tauri::AppHandle,
    state: State<Sessions>,
    handle: String,
    document: String,
    reference: String,
) -> Result<storage::Media> {
    let media = with_root(&state, &handle, |root| {
        storage::resolve_media(root, &document, &reference)
    })?;
    if let Some(path) = &media.path {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| AppError::new("media", e.to_string()))?;
    }
    Ok(media)
}
#[tauri::command]
fn open_media(
    app: tauri::AppHandle,
    state: State<Sessions>,
    handle: String,
    document: String,
    reference: String,
) -> Result<()> {
    let media = with_root(&state, &handle, |root| {
        storage::resolve_media(root, &document, &reference)
    })?;
    let path = media
        .path
        .ok_or_else(|| AppError::new("media", "素材文件不存在"))?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| AppError::new("media", e.to_string()))
}
#[tauri::command]
fn get_preferences(app: tauri::AppHandle) -> Result<Preferences> {
    read_prefs(&app)
}
#[tauri::command]
fn remove_recent(app: tauri::AppHandle, path: String) -> Result<Preferences> {
    let mut prefs = read_prefs(&app)?;
    prefs.recent.retain(|r| r.path != path);
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )?;
    Ok(prefs)
}
#[tauri::command]
fn default_voice_directory(app: tauri::AppHandle) -> Result<String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::new("resource", e.to_string()))?
        .join("voices");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/voices");
    let path = if bundled.is_dir() {
        bundled
    } else if development.is_dir() {
        development
    } else {
        return Err(AppError::new(
            "resource",
            "内置声音资源目录缺失，请重新安装客户端",
        ));
    };
    let path = fs::canonicalize(path)?.to_string_lossy().into_owned();
    Ok(path.strip_prefix(r"\\?\").unwrap_or(&path).to_owned())
}
#[tauri::command]
fn open_directory(app: tauri::AppHandle, path: String) -> Result<()> {
    let path = storage::canonical_directory(&PathBuf::from(path))?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::new("path", e.to_string()))
}
#[tauri::command]
fn open_in_terminal(path: String) -> Result<()> {
    let path = storage::canonical_directory(&PathBuf::from(path))?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args([
                "/c",
                "start",
                "powershell",
                "-NoExit",
                "-Command",
                &format!("Set-Location '{}'", path.to_string_lossy()),
            ])
            .spawn()
            .map_err(|e| AppError::new("terminal", e.to_string()))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::new("terminal", e.to_string()))?;
    }
    Ok(())
}
#[tauri::command]
fn set_preview_visible(app: tauri::AppHandle, visible: bool) -> Result<()> {
    let mut prefs = read_prefs(&app)?;
    prefs.preview_visible = Some(visible);
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )
}
fn credential(id: &str) -> Result<keyring::Entry> {
    let account = if id == "legacy" {
        "video-api-authorization".to_owned()
    } else {
        format!("video-api-{id}")
    };
    keyring::Entry::new("DramaCraft", &account)
        .map_err(|_| AppError::new("credential", "无法访问系统凭据管理器"))
}
fn authorization(id: &str) -> Result<String> {
    match credential(id)?.get_password() {
        Ok(value) => Ok(value),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(_) => Err(AppError::new("credential", "无法读取 API 密钥")),
    }
}
fn configuration(app: &tauri::AppHandle) -> Result<settings::Configuration> {
    let prefs = read_prefs(app)?;
    let mut config = prefs.generation_configuration;
    if config.default_resolution.is_empty() {
        config.default_resolution = "480p横".into();
    }
    if config.profiles.is_empty() && !prefs.generation_base_url.is_empty() {
        config.active_profile_id = "legacy".into();
        config.profiles.push(settings::ApiProfile {
            id: "legacy".into(),
            name: "默认 API".into(),
            base_url: prefs.generation_base_url,
            has_authorization: false,
        });
    }
    for profile in &mut config.profiles {
        profile.has_authorization = !authorization(&profile.id)?.is_empty();
    }
    Ok(config)
}
fn generation_settings(
    app: &tauri::AppHandle,
    profile_id: Option<&str>,
) -> Result<generation::GenerationSettings> {
    let config = configuration(app)?;
    let id = profile_id.unwrap_or(&config.active_profile_id);
    let profile = config
        .profiles
        .iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| AppError::new("config", "请先在视频 API 设置中配置服务和密钥"))?;
    Ok(generation::GenerationSettings {
        profile_id: profile.id.clone(),
        base_url: profile.base_url.clone(),
        authorization: authorization(&profile.id)?,
    })
}
#[tauri::command]
fn get_generation_settings(app: tauri::AppHandle) -> Result<settings::Configuration> {
    configuration(&app)
}
#[tauri::command]
fn set_generation_settings(
    app: tauri::AppHandle,
    configuration: settings::Configuration,
    authorizations: HashMap<String, String>,
) -> Result<settings::Configuration> {
    let mut config = configuration.normalize()?;
    for (id, value) in &authorizations {
        if !config.profiles.iter().any(|profile| &profile.id == id) {
            return Err(AppError::new("config", "密钥没有对应的 API 配置"));
        }
        reqwest::header::HeaderValue::from_str(value.trim())
            .map_err(|_| AppError::new("config", "Authorization 内容无效"))?;
    }
    for (id, value) in authorizations {
        let entry = credential(&id)?;
        if value.trim().is_empty() {
            if let Err(e) = entry.delete_credential() {
                if !matches!(e, keyring::Error::NoEntry) {
                    return Err(AppError::new("credential", "无法清除 API 密钥"));
                }
            }
        } else {
            entry
                .set_password(value.trim())
                .map_err(|_| AppError::new("credential", "无法保存 API 密钥"))?;
        }
    }
    for profile in &mut config.profiles {
        profile.has_authorization = !authorization(&profile.id)?.is_empty();
    }
    let mut prefs = read_prefs(&app)?;
    prefs.generation_configuration = config.clone();
    prefs.generation_base_url.clear();
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )?;
    Ok(config)
}
#[tauri::command]
async fn submit_generation(
    app: tauri::AppHandle,
    state: State<'_, Sessions>,
    handle: String,
    input: generation::GenerationInput,
) -> Result<generation::GenerationRecord> {
    let root = root_for(&state, &handle)?;
    generation::submit(&root, &generation_settings(&app, None)?, input).await
}
#[tauri::command]
async fn poll_generation(
    app: tauri::AppHandle,
    state: State<'_, Sessions>,
    handle: String,
    task_id: String,
) -> Result<generation::GenerationRecord> {
    let root = root_for(&state, &handle)?;
    let binding = generation::task_provider(&root, &task_id)?;
    let settings = generation_settings(&app, binding.as_ref().map(|(id, _)| id.as_str()))?;
    if let Some((_, base_url)) = binding {
        if settings.base_url != base_url {
            return Err(AppError::new(
                "config",
                "任务的 API 服务地址已变更，请恢复该配置的原服务地址后查询",
            ));
        }
    }
    generation::poll(&root, &settings, &task_id).await
}
#[tauri::command]
fn generation_history(
    state: State<Sessions>,
    handle: String,
    document: String,
    shot_id: String,
) -> Result<Vec<generation::GenerationRecord>> {
    with_root(&state, &handle, |root| {
        generation::history(root, &document, &shot_id)
    })
}
#[tauri::command]
fn import_generation_media(
    state: State<Sessions>,
    handle: String,
    document: String,
    source: String,
    shot_id: String,
    slot: String,
) -> Result<String> {
    with_root(&state, &handle, |root| {
        generation::import_media(root, &document, &source, &shot_id, &slot)
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            inspect_directory,
            open_project,
            close_project,
            create_project,
            scan_project,
            read_document,
            save_document,
            resolve_media,
            open_media,
            get_preferences,
            remove_recent,
            default_voice_directory,
            open_directory,
            open_in_terminal,
            set_preview_visible,
            get_generation_settings,
            set_generation_settings,
            submit_generation,
            poll_generation,
            generation_history,
            import_generation_media
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start DramaCraft");
}
