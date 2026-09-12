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
#[tauri::command]
fn inspect_directory(path: String) -> Result<Vec<storage::Candidate>> {
    let root = storage::canonical_directory(&PathBuf::from(path))?;
    if root.join(".drama-craft/project.json").exists() || storage::direct_markdown(&root)? {
        return Ok(Vec::new());
    }
    storage::candidates(&root)
}
#[tauri::command]
fn open_project(app: tauri::AppHandle, state: State<Sessions>, path: String) -> Result<Opened> {
    let root = storage::canonical_directory(&PathBuf::from(path))?;
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
) -> Result<Opened> {
    let root = storage::create_project(&PathBuf::from(parent), &name)?;
    open_project(app, state, root.to_string_lossy().into_owned())
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
fn create_document(
    state: State<Sessions>,
    handle: String,
    path: String,
    text: String,
) -> Result<storage::Snapshot> {
    with_root(&state, &handle, |root| {
        storage::create_document(root, &path, &text)
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
fn set_preview_visible(app: tauri::AppHandle, visible: bool) -> Result<()> {
    let mut prefs = read_prefs(&app)?;
    prefs.preview_visible = Some(visible);
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )
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
            create_document,
            resolve_media,
            open_media,
            get_preferences,
            set_preview_visible
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start DramaCraft");
}
