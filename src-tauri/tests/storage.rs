use drama_craft_lib::storage::*;
use std::{fs, path::Path};
use tempfile::TempDir;
fn workspace() -> TempDir {
    tempfile::tempdir().unwrap()
}
fn root(temp: &TempDir) -> std::path::PathBuf {
    fs::canonicalize(temp.path()).unwrap()
}
fn voice_library(parent: &Path) -> std::path::PathBuf {
    let path = parent.join("测试声音库");
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("旁白.wav"), b"synthetic-audio").unwrap();
    path
}
fn visible_png_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || !name.to_ascii_lowercase().ends_with(".png") {
                None
            } else {
                Some(name)
            }
        })
        .collect();
    names.sort();
    names
}
fn regular_path(path: &Path) -> String {
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

#[test]
fn scan_lists_only_visible_root_markdown_documents() {
    let temp = workspace();
    let root = root(&temp);
    let expected = ["0001 示例.md", "AGENTS.md", "剧本大纲.MD"];
    for name in expected {
        fs::write(root.join(name), "# 原创示例\n").unwrap();
    }
    fs::write(root.join(".临时.md"), "hidden draft").unwrap();
    fs::write(root.join("素材.png"), b"synthetic-image").unwrap();
    for directory in [
        "output/revisions/修订前",
        "章节",
        ".drama-craft",
        "node_modules",
        "target",
        "dist",
        "目录.md",
    ] {
        fs::create_dir_all(root.join(directory)).unwrap();
        fs::write(root.join(directory).join("0001 示例.md"), "backup").unwrap();
    }

    let result = scan(&root).unwrap();
    assert!(result.warnings.is_empty());
    assert_eq!(
        result
            .documents
            .iter()
            .map(|document| (document.path.as_str(), document.name.as_str()))
            .collect::<Vec<_>>(),
        expected.map(|name| (name, name))
    );
    assert_eq!(
        fs::read_to_string(root.join("output/revisions/修订前/0001 示例.md")).unwrap(),
        "backup"
    );
}

#[test]
fn preserves_custom_content_bom_crlf_and_rejects_conflicts() {
    let temp = workspace();
    let root = root(&temp);
    let file = root.join("01 中文 空格.md");
    let original = "\u{feff}# 一集\r\n\r\n自定义段落\r\n\r\n```text\r\n<Picture 1>\r\n```\r\n";
    fs::write(&file, original).unwrap();
    let snapshot = read_document(&root, "01 中文 空格.md").unwrap();
    let next = save_document(
        &root,
        "01 中文 空格.md",
        &snapshot.text.replace("一集", "第一集"),
        &snapshot.hash,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        original.replace("一集", "第一集")
    );
    fs::write(&file, "external editor").unwrap();
    assert_eq!(
        save_document(&root, "01 中文 空格.md", "ours", &next.hash)
            .unwrap_err()
            .code,
        "conflict"
    );
    assert_eq!(fs::read_to_string(file).unwrap(), "external editor");
}
#[test]
fn deleted_documents_are_not_recreated_by_save() {
    let temp = workspace();
    let root = root(&temp);
    let snapshot = create_document(&root, "剧本.md", "old").unwrap();
    fs::remove_file(root.join("剧本.md")).unwrap();
    assert_eq!(
        save_document(&root, "剧本.md", "new", &snapshot.hash)
            .unwrap_err()
            .code,
        "conflict"
    );
    assert!(!root.join("剧本.md").exists());
}
#[test]
fn rejects_traversal_reserved_names_and_overwrites() {
    let temp = workspace();
    let root = root(&temp);
    for path in [
        "../outside.md",
        "a/../../outside.md",
        ".drama-craft/x.md",
        "CON.md",
        "a:stream.md",
        "image.png",
    ] {
        assert!(
            create_document(&root, path, "bad").is_err(),
            "accepted {path}"
        );
    }
    create_document(&root, "existing.md", "keep").unwrap();
    assert!(create_document(&root, "existing.md", "replace").is_err());
    assert_eq!(
        fs::read_to_string(root.join("existing.md")).unwrap(),
        "keep"
    );
    let voices = voice_library(&root);
    let project = create_project(&root, "中文 项目", None, &voices).unwrap();
    assert!(create_project(&root, "中文 项目", None, &voices).is_err());
    assert!(project.join("剧本大纲.md").exists());
    assert_eq!(
        read_asset_index(&project).unwrap().as_deref(),
        Some("{\n  \"schemaVersion\": 1,\n  \"assets\": []\n}\n")
    );
    assert!(!project.join("分镜总表.md").exists());
    let dialogue = fs::read_to_string(project.join("全剧人物与对白.md")).unwrap();
    assert!(dialogue.contains("## 全剧人物登记"));
    assert!(dialogue.contains(
        "| 镜号 | 预计时长（秒） | 角色ID | 角色名称 | 发声方式 | 中文台词 | 必要动作或反应 |"
    ));
    assert!(dialogue.contains("每镜预计时长为 1—15 秒"));
    assert!(!dialogue.contains("| 场次 |"));
    assert!(!dialogue.contains("<!-- drama-craft:episode:v1 -->"));
    let outline = fs::read_to_string(project.join("剧本大纲.md")).unwrap();
    assert!(outline.contains("旁白决定：待与用户确认（使用 / 不使用）"));
    let agents = fs::read_to_string(project.join("AGENTS.md")).unwrap();
    assert!(!agents.contains("分镜总表"));
    assert!(
        agents.find("### 第四步：先完成全剧人物与对白").unwrap()
            < agents.find("### 第五步：逐集生成分镜剧本").unwrap()
    );
    assert!(!agents.contains("N ≥ ceil(2 × D)"));
    assert!(agents.contains("不规定每镜最低字数"));
    assert!(!agents.contains("```text\n上一镜尾帧\n```"));
    assert!(!agents.contains("首帧来源："));
    assert!(agents.contains("## 每镜独立首帧"));
    assert!(agents.contains("角色多形象（状态变体）提前设计"));
    assert!(agents.contains("分步生图与 `临时素材：`"));
    assert!(dialogue.contains("## 逐集对白正文"));
    assert!(!dialogue.contains("精简重写台词"));
    assert!(agents.contains("S 镜号是一条 1—15 秒的独立视频生成请求"));
    assert!(agents.contains("不能把一整场对话直接标成一个 S 镜号"));
    assert!(agents.contains("有效字数必须从已写出的台词逐行重算"));
    assert!(agents.contains("是否使用旁白？"));
    assert!(agents.contains("旁白选择同样是全剧约束"));
    assert!(agents.contains("全剧不创建旁白角色"));
    assert!(agents.contains("声音安排表无旁白台词"));
    assert!(!agents.contains("| N001 | 旁白 |"));
    assert!(agents.contains("视频提示词画面与发声规则"));
    assert!(agents.contains("视频提示词画面风格写法"));
    assert!(agents.contains("画面风格不是模板预设值"));
    assert!(agents.contains("画面风格为[填入已确认的核心画面风格词]。"));
    assert!(agents.contains("全程沿用 <Picture 1> 的画风与渲染。"));
    assert!(!agents.contains("禁止转成 3D、写实或其他未确认风格"));
    assert!(agents.contains("删掉破折号不够"));
    assert!(agents.contains("不要用破折号串联动作或代替正常标点"));
    assert!(agents.contains("正文未滥用破折号"));
    assert!(agents.contains("需要交代的信息必须有发声主体"));
    assert!(agents.contains("时间线无小说说明"));
    assert!(agents.contains("严格逐集完成正式分镜"));
    assert!(agents.contains("写第 N 集前先读取"));
    assert!(agents.contains("每集写完立即更新索引"));
    assert!(!agents.contains("一次生成**全部剩余集**"));
    assert!(agents.contains("C0001"));
    assert!(agents.contains("A0001"));
    assert!(agents.contains("N0001"));
    assert!(agents.contains("S0001"));
    assert!(agents.contains("全剧验收（所有集写完后必须做）"));
    assert!(agents.contains("跨集同一素材 ID / 同一名称，文件名必须逐字相同"));
    assert!(agents.contains("| 角色ID | 名称 | 角色图 | 音色文件 |\n|---|---|---|---|"));
    assert!(agents.contains("角色表固定为四列"));
    assert!(agents.contains("角色出场关系只在每镜 `角色：` 字段填写"));
    assert!(agents.contains("不重复登记镜号"));
    assert!(agents.contains("文件名建议 `0001 集名.md`、`0002 集名.md`"));
    assert!(agents.contains("`0001 首帧_S0001.png`"));
    assert!(agents.contains("`0001 S0001.mp4`"));
    assert!(agents.contains("视频提示词已写入已确认的画面风格"));
    assert!(agents.contains("首帧提示词画面风格写法（硬性规则）"));
    assert!(agents.contains(
        "每个首帧图片提示词（含分步生图各步骤）在画幅比后直接写出用户确认的完整核心风格词"
    ));
    assert!(agents.contains("附件负责锁定场景、外貌和服饰，不替代文字风格锚点"));
    assert!(agents.contains("16:9横向单幅画面。3D写实，PBR材质，电影级光照。"));
    assert!(agents.contains("首帧已显式写入画面风格"));
    assert!(agents.contains("H3 Ref2VA 主体与音色引用"));
    assert!(agents.contains("<Subject 1> 是 <Picture 2> 中的年轻学徒"));
    assert!(agents.contains("<Subject 1> (S1) 使用 <Audio 1> 的音色，在画内恼火地说："));
    assert!(agents.contains("没有可见主体的系统声或旁白"));
}

#[test]
fn asset_index_is_optional_for_old_projects_and_rejects_links() {
    let temp = workspace();
    let root = root(&temp);
    assert!(read_asset_index(&root).unwrap().is_none());
    fs::write(
        root.join("assets.json"),
        "{\"schemaVersion\":1,\"assets\":[]}",
    )
    .unwrap();
    assert!(read_asset_index(&root).unwrap().is_some());
    #[cfg(windows)]
    {
        let other = root.join("other.json");
        fs::write(&other, "{}").unwrap();
        fs::remove_file(root.join("assets.json")).unwrap();
        if std::os::windows::fs::symlink_file(&other, root.join("assets.json")).is_ok() {
            assert_eq!(read_asset_index(&root).unwrap_err().code, "path");
        }
    }
}
#[test]
fn project_identity_moves_while_external_library_configuration_is_preserved() {
    let temp = workspace();
    let root = root(&temp);
    let library_temp = workspace();
    let voices = voice_library(library_temp.path());
    let project = create_project(&root, "原创示例", None, &voices).unwrap();
    let (before, _) = load_project(&project).unwrap();
    fs::create_dir(project.join("assets")).unwrap();
    create_document(&project, "assets/补充.md", "unknown sections\n").unwrap();
    let metadata = fs::read(project.join(".drama-craft/project.json")).unwrap();
    assert!(String::from_utf8_lossy(&metadata).contains("测试声音库"));
    assert_eq!(scan(&project).unwrap().documents.len(), 3);
    assert_eq!(
        metadata,
        fs::read(project.join(".drama-craft/project.json")).unwrap()
    );
    let moved = root.join("已移动");
    fs::rename(project, &moved).unwrap();
    assert_eq!(load_project(&moved).unwrap().0.id, before.id);
    assert_eq!(
        read_document(&moved, "assets/补充.md").unwrap().text,
        "unknown sections\n"
    );
}
#[test]
fn new_project_metadata_uses_regular_library_paths() {
    let temp = workspace();
    let root = root(&temp);
    let library_temp = workspace();
    let voices = voice_library(library_temp.path());
    let project = create_project(&root, "路径示例", None, &voices).unwrap();
    let (metadata, _) = load_project(&project).unwrap();
    let canonical_voices = fs::canonicalize(&voices).unwrap();
    assert_eq!(metadata.libraries.voices, regular_path(&canonical_voices));
    #[cfg(windows)]
    {
        assert!(!metadata.libraries.voices.starts_with(r"\\?\"));
        let json = fs::read_to_string(project.join(".drama-craft/project.json")).unwrap();
        assert!(!json.contains(r"\\\\?\\"));
    }
}
#[test]
fn reads_assets_from_document_parent_and_external_paths() {
    let temp = workspace();
    let root = root(&temp);
    fs::create_dir(root.join("章节")).unwrap();
    create_document(&root, "章节/01 示例.md", "# 示例").unwrap();
    fs::write(root.join("章节/参考 图.png"), b"fixture").unwrap();
    let media = resolve_media(&root, "章节/01 示例.md", "参考 图.png").unwrap();
    assert!(media.exists);
    assert_eq!(media.kind, "image");
    let external = workspace();
    let asset = external.path().join("声音 样本.MP3");
    fs::write(&asset, b"fixture").unwrap();
    assert!(
        resolve_media(&root, "章节/01 示例.md", &asset.to_string_lossy())
            .unwrap()
            .exists
    );
    assert!(
        !resolve_media(&root, "章节/01 示例.md", "missing.mp4")
            .unwrap()
            .exists
    );
    assert!(resolve_media(&root, "章节/01 示例.md", "https://example.com/a.png").is_err());
    assert!(resolve_media(&root, "章节/01 示例.md", "app.exe").is_err());
}
#[test]
fn places_episode_images_with_markdown_filenames() {
    let temp = workspace();
    let root = root(&temp);
    create_document(&root, "01 示例.md", "# 示例").unwrap();
    let source_dir = temp.path().join("imports");
    fs::create_dir_all(&source_dir).unwrap();
    let source = source_dir.join("generated.png");
    fs::write(&source, b"generated-image").unwrap();
    let placed = place_document_media(
        &root,
        "01 示例.md",
        "01 素材_旅人.png",
        &source.to_string_lossy(),
    )
    .unwrap();
    assert!(placed.exists);
    assert_eq!(
        fs::read(root.join("01 素材_旅人.png")).unwrap(),
        b"generated-image"
    );
    fs::write(&source, b"replaced-image").unwrap();
    place_document_media(
        &root,
        "01 示例.md",
        "01 素材_旅人.png",
        &source.to_string_lossy(),
    )
    .unwrap();
    assert_eq!(
        fs::read(root.join("01 素材_旅人.png")).unwrap(),
        b"replaced-image"
    );
    assert_eq!(
        visible_png_names(&root),
        vec!["01 素材_旅人.png".to_string()]
    );
    let jpg = source_dir.join("generated.jpg");
    fs::write(&jpg, b"jpg").unwrap();
    assert_eq!(
        place_document_media(
            &root,
            "01 示例.md",
            "01 素材_旅人.png",
            &jpg.to_string_lossy()
        )
        .err()
        .unwrap()
        .code,
        "media"
    );
    assert!(place_document_media(
        &root,
        "01 示例.md",
        "F:/outside/a.png",
        &source.to_string_lossy()
    )
    .is_err());
}
#[test]
fn replaces_open_first_frame_without_renaming() {
    let temp = workspace();
    let root = root(&temp);
    create_document(&root, "01 示例.md", "# 示例").unwrap();
    let dest = root.join("01 首帧_S007.png");
    fs::write(&dest, b"old-frame").unwrap();
    let source_dir = temp.path().join("imports");
    fs::create_dir_all(&source_dir).unwrap();
    let source = source_dir.join("latest.png");
    fs::write(&source, b"new-frame").unwrap();
    let _held = fs::File::open(&dest).unwrap();
    place_document_media(
        &root,
        "01 示例.md",
        "01 首帧_S007.png",
        &source.to_string_lossy(),
    )
    .expect("replacing a displayed first-frame image should succeed");
    assert_eq!(fs::read(&dest).unwrap(), b"new-frame");
    assert_eq!(
        dest.file_name().unwrap().to_string_lossy(),
        "01 首帧_S007.png"
    );
    assert!(!root.join("latest.png").exists());
    assert_eq!(
        visible_png_names(&root),
        vec!["01 首帧_S007.png".to_string()]
    );
}
#[test]
fn readonly_files_are_not_replaced() {
    let temp = workspace();
    let root = root(&temp);
    let first = create_document(&root, "只读.md", "original").unwrap();
    let file = root.join("只读.md");
    let original_permissions = fs::metadata(&file).unwrap().permissions();
    let mut readonly = original_permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&file, readonly).unwrap();
    assert!(read_document(&root, "只读.md").unwrap().readonly);
    let result = save_document(&root, "只读.md", "changed", &first.hash);
    fs::set_permissions(&file, original_permissions).unwrap();
    assert_eq!(result.unwrap_err().code, "readonly");
    assert_eq!(fs::read_to_string(file).unwrap(), "original");
}
#[test]
fn metadata_validation_and_parent_candidates() {
    let temp = workspace();
    let root = root(&temp);
    fs::write(root.join("AGENTS.md"), "data only").unwrap();
    assert!(!direct_markdown(&root).unwrap());
    let voices = voice_library(&root);
    let child = create_project(&root, "01 示例", None, &voices).unwrap();
    assert_eq!(candidates(&root).unwrap().len(), 1);
    fs::write(child.join(".drama-craft/project.json"), "invalid").unwrap();
    assert!(load_project(&child).is_err());
    assert_eq!(
        fs::read_to_string(child.join(".drama-craft/project.json")).unwrap(),
        "invalid"
    );
}
#[test]
fn legacy_project_requires_voice_setup_without_copying_or_editing_documents() {
    let temp = workspace();
    let root = root(&temp);
    let project = root.join("旧项目");
    fs::create_dir(&project).unwrap();
    let voices = voice_library(&root);
    let characters = root.join("测试角色库");
    fs::create_dir(&characters).unwrap();
    fs::write(characters.join("角色表.txt"), "原创角色").unwrap();
    let voice_ref = voices.to_string_lossy().replace('\\', "/");
    let character_ref = characters.to_string_lossy().replace('\\', "/");
    fs::write(
        project.join("01 独立角色.md"),
        format!("# 第一集\n\n`{voice_ref}/旁白.wav`\n`{character_ref}/角色表.txt`\n"),
    )
    .unwrap();
    assert_eq!(load_project(&project).unwrap_err().code, "project_setup");
    assert_eq!(
        configure_project(&project, None, Path::new(""))
            .unwrap_err()
            .code,
        "library"
    );
    assert!(!project.join(".drama-craft/project.json").exists());

    let metadata = configure_project(&project, Some(&characters), &voices).unwrap();
    assert_eq!(
        metadata.libraries.characters.as_deref(),
        Some(regular_path(&characters).as_str())
    );
    assert_eq!(metadata.libraries.voices, regular_path(&voices));
    assert!(!project.join(".drama-craft/libraries").exists());
    let json = fs::read_to_string(project.join(".drama-craft/project.json")).unwrap();
    assert!(json.contains("测试角色库"));
    assert!(json.contains("测试声音库"));
    let document = fs::read_to_string(project.join("01 独立角色.md")).unwrap();
    assert!(document.contains(&voice_ref));
    assert!(document.contains(&character_ref));
    assert_eq!(load_project(&project).unwrap().0.id, metadata.id);
}
#[test]
fn non_utf8_is_reported_without_changes() {
    let temp = workspace();
    let root = root(&temp);
    let bytes = [0xff, 0xfe, 0x61, 0];
    fs::write(root.join("legacy.md"), bytes).unwrap();
    assert_eq!(
        read_document(&root, "legacy.md").unwrap_err().code,
        "encoding"
    );
    assert_eq!(fs::read(root.join("legacy.md")).unwrap(), bytes);
}
#[cfg(windows)]
#[test]
fn rejects_windows_junction_escape() {
    use std::process::Command;
    let temp = workspace();
    let root = root(&temp);
    let outside = workspace();
    let link = root.join("linked");
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(create_document(&root, "linked/outside.md", "bad").is_err());
    assert!(!outside.path().join("outside.md").exists());
    fs::remove_dir(link).unwrap();
}

// Explicitly opt in with a local path; no private workspace names are checked in.
#[test]
#[ignore]
fn external_workspace_readonly_check() {
    let value = std::env::var("DRAMACRAFT_COMPAT_DIR").expect("Set DRAMACRAFT_COMPAT_DIR");
    let root = fs::canonicalize(Path::new(&value)).unwrap();
    let before: Vec<_> = walkdir::WalkDir::new(&root)
        .into_iter()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.path().to_path_buf(),
                if entry.file_type().is_file() {
                    Some(hash(&fs::read(entry.path()).unwrap()))
                } else {
                    None
                },
            )
        })
        .collect();
    let (metadata, warning) = load_project(&root).unwrap();
    assert!(warning.is_none());
    assert!(!metadata.libraries.voices.is_empty());
    let result = scan(&root).unwrap();
    assert_eq!(
        result
            .documents
            .iter()
            .filter(|d| d.name.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .count(),
        12
    );
    let first_episode = result
        .documents
        .iter()
        .find(|document| document.name.starts_with("01 "))
        .unwrap();
    let existing_video = resolve_media(&root, &first_episode.path, "01 S001.mp4").unwrap();
    assert!(existing_video.exists);
    assert_eq!(existing_video.kind, "video");
    assert!(existing_video.path.is_some());
    for document in result.documents {
        read_document(&root, &document.path).unwrap();
    }
    let after: Vec<_> = walkdir::WalkDir::new(&root)
        .into_iter()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.path().to_path_buf(),
                if entry.file_type().is_file() {
                    Some(hash(&fs::read(entry.path()).unwrap()))
                } else {
                    None
                },
            )
        })
        .collect();
    assert_eq!(before, after);
}

#[test]
fn shot_discard_flags_do_not_rewrite_markdown() {
    let temp = workspace();
    let root = root(&temp);
    create_document(&root, "01 示例.md", "# S0001 测试\n").unwrap();
    let before = fs::read(root.join("01 示例.md")).unwrap();
    assert!(list_discarded_shots(&root, "01 示例.md")
        .unwrap()
        .is_empty());
    assert_eq!(
        set_shot_discarded(&root, "01 示例.md", "S0002", true).unwrap(),
        vec!["S0002".to_string()]
    );
    assert_eq!(
        list_discarded_shots(&root, "01 示例.md").unwrap(),
        vec!["S0002".to_string()]
    );
    assert_eq!(
        set_shot_discarded(&root, "01 示例.md", "S0002", false).unwrap(),
        Vec::<String>::new()
    );
    assert!(list_discarded_shots(&root, "01 示例.md")
        .unwrap()
        .is_empty());
    assert_eq!(fs::read(root.join("01 示例.md")).unwrap(), before);
    assert!(set_shot_discarded(&root, "../outside.md", "S001", true).is_err());
    assert!(set_shot_discarded(&root, "01 示例.md", "../S001", true).is_err());
}
