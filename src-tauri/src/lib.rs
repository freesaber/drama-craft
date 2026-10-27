pub mod audio;
pub mod batch;
pub mod ffmpeg;
pub mod frame_versions;
pub mod generation;
pub mod naming;
pub mod settings;
pub mod storage;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recent {
    name: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    recent: Vec<Recent>,
    #[serde(default)]
    new_project_directories: Option<NewProjectDirectories>,
    #[serde(default)]
    preview_visible: Option<bool>,
    #[serde(default)]
    generation_base_url: String,
    #[serde(default)]
    generation_configuration: settings::Configuration,
    #[serde(default)]
    generation_authorizations: HashMap<String, String>,
    #[serde(default)]
    audio_configuration: audio::Configuration,
    #[serde(default)]
    audio_authorizations: HashMap<String, String>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewProjectDirectories {
    parent: String,
    character_directory: Option<String>,
    voice_directory: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicPreferences {
    recent: Vec<Recent>,
    new_project_directories: Option<NewProjectDirectories>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview_visible: Option<bool>,
}
fn public_preferences(prefs: &Preferences) -> PublicPreferences {
    PublicPreferences {
        recent: prefs.recent.clone(),
        new_project_directories: prefs.new_project_directories.clone(),
        preview_visible: prefs.preview_visible,
    }
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
fn upsert_recent(
    recent: &mut Vec<Recent>,
    name: String,
    path: String,
    created_at: String,
    updated_at: String,
) {
    if let Some(item) = recent.iter_mut().find(|item| item.path == path) {
        item.name = name;
        item.updated_at = Some(updated_at);
        if item.created_at.is_none() {
            item.created_at = Some(created_at);
        }
        return;
    }
    recent.push(Recent {
        name,
        path,
        created_at: Some(created_at),
        updated_at: Some(updated_at),
    });
}
fn touch_recent(app: &tauri::AppHandle, root: &Path, name: Option<&str>) -> Result<()> {
    let mut prefs = read_prefs(app)?;
    let path = root.to_string_lossy().into_owned();
    let name = name
        .map(str::to_owned)
        .or_else(|| {
            prefs
                .recent
                .iter()
                .find(|item| item.path == path)
                .map(|item| item.name.clone())
        })
        .unwrap_or_else(|| {
            root.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let fallback_created_at = prefs
        .recent
        .iter()
        .find(|item| item.path == path)
        .and_then(|item| item.created_at.clone().or_else(|| item.updated_at.clone()))
        .or_else(|| {
            fs::metadata(root)
                .and_then(|metadata| metadata.created())
                .ok()
                .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
        })
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    upsert_recent(
        &mut prefs.recent,
        name,
        path,
        fallback_created_at,
        chrono::Utc::now().to_rfc3339(),
    );
    storage::atomic_write(
        &prefs_path(app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )
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
    let save_recent = || -> Result<()> { touch_recent(&app, &root, Some(&metadata.name)) };
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
        &PathBuf::from(&parent),
        &name,
        character_directory.as_deref().map(std::path::Path::new),
        std::path::Path::new(&voice_directory),
    )?;
    let opened = open_project(
        app.clone(),
        state,
        root.to_string_lossy().into_owned(),
        None,
        None,
    )?;
    let mut prefs = read_prefs(&app)?;
    prefs.new_project_directories = Some(NewProjectDirectories {
        parent,
        character_directory,
        voice_directory,
    });
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )?;
    Ok(opened)
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
fn read_asset_index(state: State<Sessions>, handle: String) -> Result<Option<String>> {
    with_root(&state, &handle, storage::read_asset_index)
}
#[tauri::command]
fn save_document(
    app: tauri::AppHandle,
    state: State<Sessions>,
    handle: String,
    path: String,
    text: String,
    expected_hash: String,
) -> Result<storage::Snapshot> {
    let root = root_for(&state, &handle)?;
    let snapshot = storage::save_document(&root, &path, &text, &expected_hash)?;
    let _ = touch_recent(&app, &root, None);
    Ok(snapshot)
}
#[tauri::command]
fn list_discarded_shots(
    state: State<Sessions>,
    handle: String,
    document: String,
) -> Result<Vec<String>> {
    with_root(&state, &handle, |root| {
        storage::list_discarded_shots(root, &document)
    })
}
#[tauri::command]
fn set_shot_discarded(
    state: State<Sessions>,
    handle: String,
    document: String,
    shot_id: String,
    discarded: bool,
) -> Result<Vec<String>> {
    with_root(&state, &handle, |root| {
        storage::set_shot_discarded(root, &document, &shot_id, discarded)
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
fn place_document_media(
    app: tauri::AppHandle,
    state: State<Sessions>,
    handle: String,
    document: String,
    reference: String,
    source: String,
) -> Result<storage::Media> {
    let media = with_root(&state, &handle, |root| {
        storage::place_document_media(root, &document, &reference, &source)
    })?;
    if let Some(path) = &media.path {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| AppError::new("media", e.to_string()))?;
    }
    Ok(media)
}
#[tauri::command]
fn replace_frame_image(
    app: tauri::AppHandle,
    state: State<Sessions>,
    handle: String,
    document: String,
    shot_id: String,
    reference: String,
    source: String,
) -> Result<storage::Media> {
    let media = with_root(&state, &handle, |root| {
        frame_versions::replace(root, &document, &shot_id, &reference, &source)
    })?;
    if let Some(path) = &media.path {
        app.asset_protocol_scope()
            .allow_file(path)
            .map_err(|e| AppError::new("media", e.to_string()))?;
    }
    Ok(media)
}
#[tauri::command]
fn frame_image_history(
    state: State<Sessions>,
    handle: String,
    document: String,
    shot_id: String,
    reference: String,
) -> Result<Vec<frame_versions::FrameVersion>> {
    with_root(&state, &handle, |root| {
        frame_versions::history(root, &document, &shot_id, &reference)
    })
}
#[tauri::command]
fn restore_frame_image(
    app: tauri::AppHandle,
    state: State<Sessions>,
    handle: String,
    document: String,
    shot_id: String,
    reference: String,
    version_id: String,
) -> Result<storage::Media> {
    let media = with_root(&state, &handle, |root| {
        frame_versions::restore(root, &document, &shot_id, &reference, &version_id)
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
fn get_preferences(app: tauri::AppHandle) -> Result<PublicPreferences> {
    Ok(public_preferences(&read_prefs(&app)?))
}
#[tauri::command]
fn remove_recent(app: tauri::AppHandle, path: String) -> Result<PublicPreferences> {
    let mut prefs = read_prefs(&app)?;
    prefs.recent.retain(|r| r.path != path);
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )?;
    Ok(public_preferences(&prefs))
}

#[tauri::command]
fn rename_recent(
    app: tauri::AppHandle,
    path: String,
    name: String,
    rename_folder: bool,
) -> Result<PublicPreferences> {
    let mut prefs = read_prefs(&app)?;
    let new_path = storage::rename_project(Path::new(&path), &name, rename_folder)?;
    let item = prefs
        .recent
        .iter_mut()
        .find(|item| item.path == path)
        .ok_or_else(|| AppError::new("project", "项目不在最近项目列表中"))?;
    item.name = name;
    item.path = new_path.to_string_lossy().into_owned();
    item.updated_at = Some(chrono::Utc::now().to_rfc3339());
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )?;
    Ok(public_preferences(&prefs))
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
    let path = fs::canonicalize(path)?;
    Ok(storage::regular_path(&path))
}
#[tauri::command]
fn open_directory(app: tauri::AppHandle, path: String) -> Result<()> {
    let path = storage::canonical_directory(&PathBuf::from(path))?;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| AppError::new("path", e.to_string()))
}
#[cfg(target_os = "windows")]
fn terminal_directory(path: &Path) -> PathBuf {
    PathBuf::from(storage::regular_path(path))
}
#[tauri::command]
fn open_in_terminal(path: String) -> Result<()> {
    let path = storage::canonical_directory(&PathBuf::from(path))?;
    #[cfg(target_os = "windows")]
    {
        let directory = terminal_directory(&path);
        std::process::Command::new("cmd")
            .current_dir(directory)
            .args(["/c", "start", "", "powershell", "-NoExit"])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn terminal_directory_uses_a_regular_windows_path() {
        assert_eq!(
            terminal_directory(Path::new(r"\\?\F:\漫剧测试\test")),
            PathBuf::from(r"F:\漫剧测试\test")
        );
    }

    #[test]
    fn project_activity_does_not_change_creation_order() {
        let mut items = (0..12)
            .map(|index| Recent {
                name: format!("项目{index}"),
                path: format!(r"F:\项目\{index}"),
                created_at: None,
                updated_at: None,
            })
            .collect::<Vec<_>>();

        upsert_recent(
            &mut items,
            "项目5".into(),
            r"F:\项目\5".into(),
            "2026-09-15T08:00:00Z".into(),
            "2026-09-15T09:00:00Z".into(),
        );

        assert_eq!(items.len(), 12);
        assert_eq!(items[0].name, "项目0");
        assert_eq!(items[5].name, "项目5");
        assert_eq!(items[5].updated_at.as_deref(), Some("2026-09-15T09:00:00Z"));

        upsert_recent(
            &mut items,
            "项目12".into(),
            r"F:\项目\12".into(),
            "2026-09-15T10:00:00Z".into(),
            "2026-09-15T10:00:00Z".into(),
        );
        assert_eq!(items.len(), 13);
        assert_eq!(items[12].name, "项目12");
    }

    #[test]
    fn legacy_project_list_without_timestamps_still_deserializes() {
        let prefs: Preferences =
            serde_json::from_str(r#"{"recent":[{"name":"旧项目","path":"F:\\\\旧项目"}]}"#)
                .unwrap();
        assert_eq!(prefs.recent.len(), 1);
        assert_eq!(prefs.recent[0].updated_at, None);
        assert_eq!(prefs.new_project_directories, None);
    }

    #[test]
    fn new_project_directories_survive_preferences_round_trip() {
        let mut prefs = Preferences::default();
        prefs.new_project_directories = Some(NewProjectDirectories {
            parent: r"C:\synthetic\projects".into(),
            character_directory: Some(r"C:\synthetic\characters".into()),
            voice_directory: r"C:\synthetic\voices".into(),
        });
        for characters in [Some(r"C:\synthetic\characters".to_string()), None] {
            prefs
                .new_project_directories
                .as_mut()
                .unwrap()
                .character_directory = characters;
            let restored: Preferences =
                serde_json::from_slice(&serde_json::to_vec(&prefs).unwrap()).unwrap();
            assert_eq!(
                restored.new_project_directories,
                prefs.new_project_directories
            );
            let public = serde_json::to_value(public_preferences(&restored)).unwrap();
            assert_eq!(
                public["newProjectDirectories"]["parent"],
                r"C:\synthetic\projects"
            );
            assert_eq!(
                public["newProjectDirectories"]["voiceDirectory"],
                r"C:\synthetic\voices"
            );
            assert_eq!(
                public["newProjectDirectories"]["characterDirectory"],
                serde_json::to_value(
                    &prefs
                        .new_project_directories
                        .as_ref()
                        .unwrap()
                        .character_directory
                )
                .unwrap()
            );
        }
    }

    #[test]
    fn token_is_kept_in_private_app_preferences_and_removed_with_profile() {
        let config = settings::Configuration {
            profiles: vec![settings::ApiProfile {
                id: "legacy".into(),
                name: "默认 API".into(),
                platform_type: "autodl".into(),
                submit_url: "https://example.test/submit".into(),
                query_url: "https://example.test/result/{task_id}".into(),
                resolutions: r#"["480p横(864*480)"]"#.into(),
                default_seed: String::new(),
                has_authorization: false,
            }],
            active_profile_id: "legacy".into(),
            default_resolution: "480p横(864*480)".into(),
        };
        let mut prefs = Preferences::default();
        update_authorizations(
            &mut prefs,
            &config,
            HashMap::from([("legacy".into(), " Token local-test ".into())]),
        )
        .unwrap();

        assert_eq!(authorization(&prefs, "legacy"), "Token local-test");
        let public_json = serde_json::to_string(&public_preferences(&prefs)).unwrap();
        assert!(!public_json.contains("local-test"));

        let empty_config = settings::Configuration {
            profiles: Vec::new(),
            active_profile_id: String::new(),
            default_resolution: "480p横(864*480)".into(),
        };
        update_authorizations(&mut prefs, &empty_config, HashMap::new()).unwrap();
        assert_eq!(authorization(&prefs, "legacy"), "");
    }
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
fn authorization(prefs: &Preferences, id: &str) -> String {
    prefs
        .generation_authorizations
        .get(id)
        .cloned()
        .unwrap_or_default()
}
fn audio_authorization(prefs: &Preferences, id: &str) -> String {
    prefs
        .audio_authorizations
        .get(id)
        .cloned()
        .unwrap_or_default()
}
fn audio_configuration_from_preferences(prefs: &Preferences) -> audio::Configuration {
    let mut config = prefs.audio_configuration.clone();
    for profile in &mut config.profiles {
        profile.has_authorization = !audio_authorization(prefs, &profile.id).is_empty();
    }
    config
}
fn audio_settings(
    app: &tauri::AppHandle,
    profile_id: Option<&str>,
) -> Result<audio::AudioSettings> {
    let prefs = read_prefs(app)?;
    let config = audio_configuration_from_preferences(&prefs);
    let id = profile_id.unwrap_or(&config.active_profile_id);
    let profile = config
        .profiles
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new("config", "请先在音频 API 设置中配置服务和密钥"))?;
    Ok(audio::AudioSettings {
        profile_id: profile.id.clone(),
        submit_url: profile.submit_url.clone(),
        query_url: profile.query_url.clone(),
        authorization: audio_authorization(&prefs, &profile.id),
    })
}
#[tauri::command]
fn get_audio_settings(app: tauri::AppHandle) -> Result<audio::Configuration> {
    Ok(audio_configuration_from_preferences(&read_prefs(&app)?))
}
#[tauri::command]
fn get_audio_authorization(app: tauri::AppHandle, profile_id: String) -> Result<String> {
    let prefs = read_prefs(&app)?;
    if !prefs
        .audio_configuration
        .profiles
        .iter()
        .any(|item| item.id == profile_id)
    {
        return Err(AppError::new("config", "密钥没有对应的音频 API 配置"));
    }
    Ok(audio_authorization(&prefs, &profile_id))
}
#[tauri::command]
fn set_audio_settings(
    app: tauri::AppHandle,
    configuration: audio::Configuration,
    authorizations: HashMap<String, String>,
) -> Result<audio::Configuration> {
    let mut config = configuration.normalize()?;
    let mut prefs = read_prefs(&app)?;
    for (id, value) in authorizations {
        if !config.profiles.iter().any(|item| item.id == id) {
            return Err(AppError::new("config", "密钥没有对应的音频 API 配置"));
        }
        if value.trim().is_empty() {
            prefs.audio_authorizations.remove(&id);
        } else {
            reqwest::header::HeaderValue::from_str(value.trim())
                .map_err(|_| AppError::new("config", "Authorization 内容无效"))?;
            prefs
                .audio_authorizations
                .insert(id, value.trim().to_owned());
        }
    }
    prefs
        .audio_authorizations
        .retain(|id, _| config.profiles.iter().any(|item| &item.id == id));
    for profile in &mut config.profiles {
        profile.has_authorization = !audio_authorization(&prefs, &profile.id).is_empty();
    }
    prefs.audio_configuration = config.clone();
    storage::atomic_write(
        &prefs_path(&app)?,
        &serde_json::to_vec_pretty(&prefs)?,
        false,
    )?;
    Ok(config)
}
fn configuration_from_preferences(prefs: &Preferences) -> settings::Configuration {
    let mut config = prefs.generation_configuration.clone();
    if config.default_resolution.is_empty() {
        config.default_resolution = "480p横".into();
    }
    if config.profiles.is_empty() && !prefs.generation_base_url.is_empty() {
        config.active_profile_id = "legacy".into();
        config.profiles.push(settings::ApiProfile {
            id: "legacy".into(),
            name: "默认 API".into(),
            platform_type: "autodl".into(),
            submit_url: prefs.generation_base_url.clone(),
            query_url: String::new(),
            resolutions: String::new(),
            default_seed: String::new(),
            has_authorization: false,
        });
    }
    for profile in &mut config.profiles {
        profile.has_authorization = !authorization(prefs, &profile.id).is_empty();
    }
    config
}
fn configuration(app: &tauri::AppHandle) -> Result<settings::Configuration> {
    Ok(configuration_from_preferences(&read_prefs(app)?))
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
    let prefs = read_prefs(app)?;
    let resolutions: Vec<String> = serde_json::from_str(profile.resolutions.trim())
        .ok()
        .and_then(|value: serde_json::Value| {
            value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|text| text.trim().to_owned()))
                    .filter(|text| !text.is_empty())
                    .collect()
            })
        })
        .unwrap_or_default();
    Ok(generation::GenerationSettings {
        profile_id: profile.id.clone(),
        submit_url: profile.submit_url.clone(),
        query_url: profile.query_url.clone(),
        resolutions,
        authorization: authorization(&prefs, &profile.id),
    })
}
#[tauri::command]
fn get_generation_settings(app: tauri::AppHandle) -> Result<settings::Configuration> {
    configuration(&app)
}

#[tauri::command]
fn get_generation_authorization(app: tauri::AppHandle, profile_id: String) -> Result<String> {
    let prefs = read_prefs(&app)?;
    let config = configuration_from_preferences(&prefs);
    if !config
        .profiles
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        return Err(AppError::new("config", "密钥没有对应的 API 配置"));
    }
    Ok(authorization(&prefs, &profile_id))
}

fn update_authorizations(
    prefs: &mut Preferences,
    config: &settings::Configuration,
    authorizations: HashMap<String, String>,
) -> Result<()> {
    for (id, value) in &authorizations {
        if !config.profiles.iter().any(|profile| &profile.id == id) {
            return Err(AppError::new("config", "密钥没有对应的 API 配置"));
        }
        reqwest::header::HeaderValue::from_str(value.trim())
            .map_err(|_| AppError::new("config", "Authorization 内容无效"))?;
    }
    for (id, value) in authorizations {
        if value.trim().is_empty() {
            prefs.generation_authorizations.remove(&id);
        } else {
            prefs
                .generation_authorizations
                .insert(id, value.trim().to_owned());
        }
    }
    prefs
        .generation_authorizations
        .retain(|id, _| config.profiles.iter().any(|profile| &profile.id == id));
    Ok(())
}

#[tauri::command]
fn set_generation_settings(
    app: tauri::AppHandle,
    configuration: settings::Configuration,
    authorizations: HashMap<String, String>,
) -> Result<settings::Configuration> {
    let mut config = configuration.normalize()?;
    let mut prefs = read_prefs(&app)?;
    update_authorizations(&mut prefs, &config, authorizations)?;
    for profile in &mut config.profiles {
        profile.has_authorization = !authorization(&prefs, &profile.id).is_empty();
    }
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
    if let Some((_, submit_url)) = binding {
        if settings.submit_url != submit_url {
            return Err(AppError::new(
                "config",
                "任务的提交任务地址已变更，请恢复该配置的原提交地址后查询",
            ));
        }
    }
    generation::poll(&root, &settings, &task_id).await
}
#[tauri::command]
async fn poll_audio(
    app: tauri::AppHandle,
    state: State<'_, Sessions>,
    handle: String,
    task_id: String,
) -> Result<audio::AudioRecord> {
    let root = root_for(&state, &handle)?;
    let binding = audio::task_provider(&root, &task_id)?;
    let settings = audio_settings(&app, binding.as_ref().map(|(id, _)| id.as_str()))?;
    if let Some((_, submit_url)) = binding {
        if settings.submit_url != submit_url {
            return Err(AppError::new(
                "config",
                "任务的音频提交地址已变更，请恢复原地址后查询",
            ));
        }
    }
    audio::poll(&root, &settings, &task_id).await
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
fn delete_generation(
    state: State<Sessions>,
    handle: String,
    document: String,
    shot_id: String,
    task_id: String,
) -> Result<()> {
    with_root(&state, &handle, |root| {
        generation::delete(root, &document, &shot_id, &task_id)
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
#[tauri::command]
fn trim_media(
    state: State<Sessions>,
    handle: String,
    document: String,
    reference: String,
    start: f64,
    end: f64,
) -> Result<storage::Media> {
    with_root(&state, &handle, |root| {
        ffmpeg::trim_video(root, &document, &reference, start, end)
    })
}
#[tauri::command]
fn export_video_frame(
    state: State<Sessions>,
    handle: String,
    document: String,
    reference: String,
    time: f64,
    destination: String,
) -> Result<()> {
    with_root(&state, &handle, |root| {
        ffmpeg::export_frame(root, &document, &reference, time, &destination)
    })
}
#[tauri::command]
fn export_video_tail_frame(
    state: State<Sessions>,
    handle: String,
    document: String,
    reference: String,
    end: f64,
    destination: String,
) -> Result<()> {
    with_root(&state, &handle, |root| {
        ffmpeg::export_tail_frame(root, &document, &reference, end, &destination)
    })
}
#[tauri::command]
fn merge_episode(
    state: State<Sessions>,
    handle: String,
    input: batch::MergeEpisodeInput,
) -> Result<batch::BatchJob> {
    with_root(&state, &handle, |root| batch::merge_episode(root, input))
}
#[tauri::command]
fn create_batch_job(
    state: State<Sessions>,
    handle: String,
    input: batch::CreateBatchJobInput,
) -> Result<batch::BatchJob> {
    with_root(&state, &handle, |root| batch::create_job(root, input))
}
#[tauri::command]
fn list_batch_jobs(state: State<Sessions>, handle: String) -> Result<Vec<batch::BatchJob>> {
    with_root(&state, &handle, batch::list_jobs)
}
#[tauri::command]
fn get_batch_job(
    state: State<Sessions>,
    handle: String,
    job_id: String,
) -> Result<batch::BatchJob> {
    with_root(&state, &handle, |root| batch::get_job(root, &job_id))
}
#[tauri::command]
fn cancel_batch_job(
    state: State<Sessions>,
    handle: String,
    job_id: String,
) -> Result<batch::BatchJob> {
    with_root(&state, &handle, |root| batch::cancel_job(root, &job_id))
}
#[tauri::command]
fn cancel_batch_job_item(
    state: State<Sessions>,
    handle: String,
    item_id: String,
) -> Result<batch::BatchJob> {
    with_root(&state, &handle, |root| batch::cancel_item(root, &item_id))
}
#[tauri::command]
fn sync_batch_jobs(state: State<Sessions>, handle: String) -> Result<Vec<batch::BatchJob>> {
    with_root(&state, &handle, batch::sync_jobs)
}
#[tauri::command]
fn mark_batch_video_applied(
    state: State<Sessions>,
    handle: String,
    item_id: String,
    local_file: String,
) -> Result<()> {
    with_root(&state, &handle, |root| {
        batch::mark_video_applied(root, &item_id, &local_file)
    })
}
#[tauri::command]
async fn advance_batch_jobs(
    app: tauri::AppHandle,
    state: State<'_, Sessions>,
    handle: String,
) -> Result<batch::BatchAdvanceResult> {
    let root = root_for(&state, &handle)?;
    batch::advance(&root, &generation_settings(&app, None)?).await
}
#[tauri::command]
async fn advance_audio_jobs(
    app: tauri::AppHandle,
    state: State<'_, Sessions>,
    handle: String,
) -> Result<batch::BatchAdvanceResult> {
    let root = root_for(&state, &handle)?;
    batch::advance_audio(&root, &audio_settings(&app, None)?).await
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
            read_asset_index,
            save_document,
            list_discarded_shots,
            set_shot_discarded,
            resolve_media,
            place_document_media,
            replace_frame_image,
            frame_image_history,
            restore_frame_image,
            open_media,
            get_preferences,
            remove_recent,
            rename_recent,
            default_voice_directory,
            open_directory,
            open_in_terminal,
            set_preview_visible,
            get_generation_settings,
            get_generation_authorization,
            set_generation_settings,
            get_audio_settings,
            get_audio_authorization,
            set_audio_settings,
            submit_generation,
            poll_generation,
            poll_audio,
            generation_history,
            delete_generation,
            import_generation_media,
            trim_media,
            export_video_frame,
            export_video_tail_frame,
            merge_episode,
            create_batch_job,
            list_batch_jobs,
            get_batch_job,
            cancel_batch_job,
            cancel_batch_job_item,
            sync_batch_jobs,
            mark_batch_video_applied,
            advance_batch_jobs,
            advance_audio_jobs
        ])
        .run(tauri::generate_context!())
        .expect("Unable to start DramaCraft");
}
