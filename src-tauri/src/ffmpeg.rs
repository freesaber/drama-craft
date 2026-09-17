use crate::storage::{self, AppError, Result};
use serde_json::Value;
use std::{
    env, fs,
    path::{Component, Path, PathBuf},
    process::Command,
    time::Duration,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MIN_SPAN: f64 = 0.1;

pub fn validate_trim(start: f64, end: f64, duration: f64) -> Result<(f64, f64)> {
    if !start.is_finite() || !end.is_finite() || !duration.is_finite() {
        return Err(AppError::new("input", "裁切时间无效"));
    }
    if duration < MIN_SPAN {
        return Err(AppError::new("input", "视频太短，无法裁切"));
    }
    let start = start.clamp(0.0, duration);
    let end = end.clamp(0.0, duration);
    if end - start < MIN_SPAN {
        return Err(AppError::new(
            "input",
            "保留片段至少需要 0.1 秒，请调整入点或出点",
        ));
    }
    Ok((start, end))
}

pub fn probe_duration(path: &Path) -> Result<f64> {
    let output = run(
        &ffprobe_binary()?,
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            path_arg(path)?,
        ],
    )?;
    parse_duration(&output)
}

pub fn trim_video(
    root: &Path,
    document: &str,
    reference: &str,
    start: f64,
    end: f64,
) -> Result<storage::Media> {
    let path = writable_project_video(root, document, reference)?;
    let duration = probe_duration(&path)?;
    let (start, end) = validate_trim(start, end, duration)?;
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("path", "视频缺少父目录"))?;
    let temp = parent.join(format!(
        ".~dc-trim-{}-{}.mp4",
        path.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("video"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or(Duration::from_secs(0))
            .as_millis()
    ));
    let start_arg = format_seconds(start);
    let end_arg = format_seconds(end);
    let result = run(
        &ffmpeg_binary()?,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            path_arg(&path)?,
            "-ss",
            &start_arg,
            "-to",
            &end_arg,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            path_arg(&temp)?,
        ],
    );
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if !temp.is_file() {
        return Err(AppError::new("ffmpeg", "裁切未写出文件"));
    }
    storage::replace_file_from(&path, &temp)?;
    let _ = fs::remove_file(&temp);
    storage::resolve_media(root, document, reference)
}

fn writable_project_video(root: &Path, document: &str, reference: &str) -> Result<PathBuf> {
    let doc = storage::document_path(root, document, true)?;
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
            "只能裁切文档旁的项目内视频，不会改写 Markdown",
        ));
    }
    for part in rel.components() {
        let name = part.as_os_str().to_string_lossy();
        storage::validate_name(&name)?;
    }
    let extension = rel
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "mp4" {
        return Err(AppError::new("media", "目前仅支持裁切 MP4"));
    }
    let destination = doc
        .parent()
        .ok_or_else(|| AppError::new("path", "文档缺少父目录"))?
        .join(rel);
    let canonical = fs::canonicalize(&destination)
        .map_err(|_| AppError::new("media", format!("视频不存在：{value}")))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(AppError::new("path", "路径超出项目目录"));
    }
    if fs::symlink_metadata(&destination)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(AppError::new("path", "不写入链接文件"));
    }
    Ok(canonical)
}

fn ffmpeg_binary() -> Result<PathBuf> {
    tool_binary("ffmpeg")
}

fn ffprobe_binary() -> Result<PathBuf> {
    tool_binary("ffprobe")
}

fn tool_binary(name: &str) -> Result<PathBuf> {
    let env_key = format!("DRAMACRAFT_{}", name.to_ascii_uppercase());
    if let Ok(value) = env::var(&env_key) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Ok(path);
        }
    }
    for dir in search_dirs() {
        for candidate in sidecar_names(name) {
            let path = dir.join(candidate);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err(AppError::new(
        "ffmpeg",
        "未找到打包的 FFmpeg，请先运行 npm run ffmpeg:download",
    ))
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            if dir.file_name().is_some_and(|name| name == "deps") {
                if let Some(parent) = dir.parent() {
                    dirs.push(parent.to_path_buf());
                }
            }
        }
    }
    #[cfg(debug_assertions)]
    {
        dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    }
    dirs
}

fn sidecar_names(name: &str) -> Vec<String> {
    vec![
        format!("{name}.exe"),
        name.to_string(),
        format!("{name}-x86_64-pc-windows-msvc.exe"),
        format!("{name}-aarch64-pc-windows-msvc.exe"),
    ]
}

fn path_arg(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| AppError::new("path", "路径不是有效 UTF-8"))
}

fn format_seconds(value: f64) -> String {
    format!("{value:.3}")
}

fn parse_duration(json: &str) -> Result<f64> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| AppError::new("ffmpeg", "无法读取视频时长"))?;
    let parsed = match value.pointer("/format/duration") {
        Some(Value::String(text)) => text.parse::<f64>().ok(),
        Some(Value::Number(number)) => number.as_f64(),
        _ => None,
    };
    parsed
        .filter(|item| item.is_finite() && *item > 0.0)
        .ok_or_else(|| AppError::new("ffmpeg", "无法读取视频时长"))
}

fn run(binary: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new(binary);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|e| AppError::new("ffmpeg", format!("无法启动 FFmpeg：{e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        return Err(AppError::new(
            "ffmpeg",
            if stderr.is_empty() {
                format!("FFmpeg 失败（状态 {}）", output.status)
            } else {
                format!("FFmpeg 失败：{stderr}")
            },
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_inverted_or_tiny_ranges() {
        assert_eq!(validate_trim(2.0, 1.0, 5.0).unwrap_err().code, "input");
        assert_eq!(validate_trim(0.0, 0.05, 5.0).unwrap_err().code, "input");
        let (start, end) = validate_trim(-1.0, 5.2, 5.0).unwrap();
        assert_eq!(start, 0.0);
        assert!((end - 5.0).abs() < 1e-9);
    }

    fn generate_clip(path: &Path, seconds: u8) -> bool {
        let Ok(ffmpeg) = ffmpeg_binary() else {
            return false;
        };
        let duration = seconds.to_string();
        run(
            &ffmpeg,
            &[
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color=c=black:s=320x240:d={duration}"),
                "-f",
                "lavfi",
                "-i",
                &format!("sine=f=440:d={duration}"),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-c:a",
                "aac",
                "-shortest",
                path_arg(path).unwrap(),
            ],
        )
        .is_ok()
    }

    #[test]
    fn overwrites_mp4_keeps_name_and_leaves_markdown_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let markdown = root.join("01 中文.md");
        let video = root.join("S001_测试.mp4");
        let original_md = "# 一集\n\n视频文件名：S001_测试.mp4\n";
        fs::write(&markdown, original_md).unwrap();
        if !generate_clip(&video, 3) {
            panic!("未找到打包的 FFmpeg，请先运行 npm run ffmpeg:download");
        }
        let before = fs::metadata(&video).unwrap().len();
        trim_video(&root, "01 中文.md", "S001_测试.mp4", 0.4, 1.6).unwrap();
        let after = fs::metadata(&video).unwrap().len();
        assert!(video.is_file());
        assert_ne!(before, after);
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with(".mp4")
            })
            .collect();
        assert_eq!(leftovers.len(), 1);
        assert_eq!(fs::read_to_string(markdown).unwrap(), original_md);
        let duration = probe_duration(&video).unwrap();
        assert!(duration > 0.9 && duration < 1.5, "{duration}");
    }

    #[test]
    fn rejects_path_escape_and_non_mp4() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        fs::write(root.join("01.md"), "# t\n").unwrap();
        assert_eq!(
            trim_video(&root, "01.md", "../out.mp4", 0.0, 1.0)
                .unwrap_err()
                .code,
            "path"
        );
        fs::write(root.join("note.txt"), "nope").unwrap();
        assert_eq!(
            trim_video(&root, "01.md", "note.txt", 0.0, 1.0)
                .unwrap_err()
                .code,
            "media"
        );
    }

    #[test]
    fn parse_duration_reads_json_string() {
        let duration = parse_duration(r#"{"format":{"duration":"4.800"}}"#).unwrap();
        assert!((duration - 4.8).abs() < 1e-9);
    }
}
