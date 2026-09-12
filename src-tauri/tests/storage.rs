use drama_craft_lib::storage::*;
use std::{fs, path::Path};
use tempfile::TempDir;
fn workspace() -> TempDir {
    tempfile::tempdir().unwrap()
}
fn root(temp: &TempDir) -> std::path::PathBuf {
    fs::canonicalize(temp.path()).unwrap()
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
    let project = create_project(&root, "中文 项目").unwrap();
    assert!(create_project(&root, "中文 项目").is_err());
    assert!(project.join("剧本大纲.md").exists());
}
#[test]
fn project_is_portable_and_scan_is_read_only() {
    let temp = workspace();
    let root = root(&temp);
    let project = create_project(&root, "原创示例").unwrap();
    let (before, _) = load_project(&project).unwrap();
    fs::create_dir(project.join("assets")).unwrap();
    create_document(&project, "assets/补充.md", "unknown sections\n").unwrap();
    let metadata = fs::read(project.join(".drama-craft/project.json")).unwrap();
    assert!(!String::from_utf8_lossy(&metadata).contains(&root.to_string_lossy().to_string()));
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
    let child = create_project(&root, "01 示例").unwrap();
    assert_eq!(candidates(&root).unwrap().len(), 1);
    fs::write(child.join(".drama-craft/project.json"), "invalid").unwrap();
    assert!(load_project(&child).is_err());
    assert_eq!(
        fs::read_to_string(child.join(".drama-craft/project.json")).unwrap(),
        "invalid"
    );
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
    let result = scan(&root).unwrap();
    assert_eq!(
        result
            .documents
            .iter()
            .filter(|d| d.name.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .count(),
        12
    );
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
