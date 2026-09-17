use crate::storage::{self, AppError, Result};
use chrono::Local;
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
    let path = resolve_project_video(root, document, reference)?;
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
            "-pix_fmt",
            "yuv420p",
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

pub fn merge_output_name(document: &Path, timestamp: &str) -> String {
    let name = document
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let number: String = name
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    if number.is_empty() {
        format!("merge_{timestamp}.mp4")
    } else {
        format!("{number:0>2} merge_{timestamp}.mp4")
    }
}

pub fn concat_videos(root: &Path, document: &str, references: &[String]) -> Result<String> {
    if references.is_empty() {
        return Err(AppError::new("input", "请至少选择一个分镜视频"));
    }
    let mut sources = Vec::with_capacity(references.len());
    for reference in references {
        sources.push(resolve_project_video(root, document, reference)?);
    }
    let doc = storage::document_path(root, document, true)?;
    let parent = doc
        .parent()
        .ok_or_else(|| AppError::new("path", "文档缺少父目录"))?;
    let timestamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut filename = merge_output_name(&doc, &timestamp);
    if parent.join(&filename).exists() {
        filename = merge_output_name(
            &doc,
            &format!("{}-{}", timestamp, Local::now().format("%3f")),
        );
    }
    let destination = parent.join(&filename);
    storage::validate_name(&filename)?;
    let mut clips = Vec::with_capacity(sources.len());
    for path in &sources {
        clips.push(probe_clip(path)?);
    }
    let width = even_dim(clips.iter().map(|clip| clip.width).max().unwrap_or(0));
    let height = even_dim(clips.iter().map(|clip| clip.height).max().unwrap_or(0));
    if width < 2 || height < 2 {
        return Err(AppError::new("media", "无法读取视频尺寸"));
    }
    let fps = clips
        .first()
        .map(|clip| clip.fps.clone())
        .unwrap_or_else(|| "24".into());
    let temp = parent.join(format!(".~dc-merge-{timestamp}.mp4"));
    if let Err(error) = run_concat_filter(&sources, &clips, width, height, &fps, &temp) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if !temp.is_file() {
        return Err(AppError::new("ffmpeg", "合并未写出文件"));
    }
    storage::replace_file_from(&destination, &temp)?;
    let _ = fs::remove_file(&temp);
    Ok(filename)
}

#[derive(Clone, Debug)]
struct ClipInfo {
    width: i64,
    height: i64,
    fps: String,
    has_audio: bool,
    duration: f64,
}

fn probe_clip(path: &Path) -> Result<ClipInfo> {
    let output = run(
        &ffprobe_binary()?,
        &[
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path_arg(path)?,
        ],
    )?;
    parse_clip(&output)
}

fn parse_clip(json: &str) -> Result<ClipInfo> {
    let value: Value =
        serde_json::from_str(json).map_err(|_| AppError::new("ffmpeg", "无法读取视频信息"))?;
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::new("ffmpeg", "无法读取视频信息"))?;
    let video = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        .ok_or_else(|| AppError::new("media", "文件没有视频轨"))?;
    let width = video.get("width").and_then(Value::as_i64).unwrap_or(0);
    let height = video.get("height").and_then(Value::as_i64).unwrap_or(0);
    let fps = sanitize_fps(
        video
            .get("avg_frame_rate")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let has_audio = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let duration = parse_duration(json).unwrap_or(0.1);
    if width < 2 || height < 2 {
        return Err(AppError::new("media", "无法读取视频尺寸"));
    }
    Ok(ClipInfo {
        width,
        height,
        fps,
        has_audio,
        duration,
    })
}

fn sanitize_fps(value: &str) -> String {
    if !value.is_empty() && value != "0/0" && value.chars().all(|c| c.is_ascii_digit() || c == '/')
    {
        value.to_string()
    } else {
        "24".into()
    }
}

fn even_dim(value: i64) -> i64 {
    let value = value.max(2);
    value - (value % 2)
}

fn build_concat_filter(clips: &[ClipInfo], width: i64, height: i64, fps: &str) -> String {
    let n = clips.len();
    let mut parts = Vec::with_capacity(n * 2 + 1);
    let mut concat_in = String::new();
    for (index, clip) in clips.iter().enumerate() {
        parts.push(format!(
            "[{index}:v]fps={fps},scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p,setsar=1,setpts=PTS-STARTPTS[v{index}]"
        ));
        if clip.has_audio {
            parts.push(format!(
                "[{index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{index}]"
            ));
        } else {
            parts.push(format!(
                "anullsrc=r=48000:cl=stereo,atrim=duration={},asetpts=PTS-STARTPTS[a{index}]",
                format_seconds(clip.duration.max(0.1))
            ));
        }
        concat_in.push_str(&format!("[v{index}][a{index}]"));
    }
    parts.push(format!("{concat_in}concat=n={n}:v=1:a=1[vout][aout]"));
    parts.join(";")
}

fn run_concat_filter(
    sources: &[PathBuf],
    clips: &[ClipInfo],
    width: i64,
    height: i64,
    fps: &str,
    output: &Path,
) -> Result<String> {
    let mut args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
    ];
    for path in sources {
        args.push("-i".into());
        args.push(path_arg(path)?.to_string());
    }
    args.extend([
        "-filter_complex".into(),
        build_concat_filter(clips, width, height, fps),
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        "[aout]".into(),
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "slow".into(),
        "-crf".into(),
        "18".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-profile:v".into(),
        "high".into(),
        "-colorspace".into(),
        "bt709".into(),
        "-color_primaries".into(),
        "bt709".into(),
        "-color_trc".into(),
        "bt709".into(),
        "-c:a".into(),
        "aac".into(),
        "-ar".into(),
        "48000".into(),
        "-ac".into(),
        "2".into(),
        "-b:a".into(),
        "192k".into(),
        "-movflags".into(),
        "+faststart".into(),
        path_arg(output)?.to_string(),
    ]);
    run_strings(&ffmpeg_binary()?, &args)
}

fn run_strings(binary: &Path, args: &[String]) -> Result<String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(binary, &refs)
}

fn resolve_project_video(root: &Path, document: &str, reference: &str) -> Result<PathBuf> {
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
            "只能处理文档旁的项目内视频，不会改写 Markdown",
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
        return Err(AppError::new("media", "目前仅支持处理 MP4"));
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
pub(crate) fn write_test_clip(path: &Path, seconds: u8) -> bool {
    write_test_clip_with(path, seconds, "yuv420p", None)
}

#[cfg(test)]
fn write_test_clip_with(path: &Path, seconds: u8, pix_fmt: &str, profile: Option<&str>) -> bool {
    let Ok(ffmpeg) = ffmpeg_binary() else {
        return false;
    };
    let duration = seconds.to_string();
    let video = format!("color=c=black:s=320x240:d={duration}");
    let audio = format!("sine=f=440:d={duration}");
    let mut args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        video,
        "-f".into(),
        "lavfi".into(),
        "-i".into(),
        audio,
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-pix_fmt".into(),
        pix_fmt.to_string(),
    ];
    if let Some(profile) = profile {
        args.push("-profile:v".into());
        args.push(profile.to_string());
    }
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-shortest".into(),
        path_arg(path).unwrap().to_string(),
    ]);
    run_strings(&ffmpeg, &args).is_ok()
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

    #[test]
    fn overwrites_mp4_keeps_name_and_leaves_markdown_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let markdown = root.join("01 中文.md");
        let video = root.join("S001_测试.mp4");
        let original_md = "# 一集\n\n视频文件名：S001_测试.mp4\n";
        fs::write(&markdown, original_md).unwrap();
        if !write_test_clip(&video, 3) {
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

    #[test]
    fn concat_filter_normalizes_mixed_audio_and_pixel_format() {
        let clips = [
            ClipInfo {
                width: 864,
                height: 480,
                fps: "24/1".into(),
                has_audio: true,
                duration: 6.5,
            },
            ClipInfo {
                width: 864,
                height: 480,
                fps: "24/1".into(),
                has_audio: false,
                duration: 5.0,
            },
        ];
        let filter = build_concat_filter(&clips, 864, 480, "24/1");
        assert!(filter.contains("format=yuv420p"));
        assert!(filter.contains("anullsrc"));
        assert!(filter.contains("concat=n=2:v=1:a=1[vout][aout]"));
        assert!(!filter.contains("-c copy"));
    }

    #[test]
    fn parse_clip_reads_10bit_and_audio() {
        let clip = parse_clip(
            r#"{
              "streams":[
                {"codec_type":"video","width":864,"height":480,"avg_frame_rate":"24/1","pix_fmt":"yuv420p10le"},
                {"codec_type":"audio","codec_name":"aac"}
              ],
              "format":{"duration":"6.583"}
            }"#,
        )
        .unwrap();
        assert_eq!(clip.width, 864);
        assert_eq!(clip.height, 480);
        assert_eq!(clip.fps, "24/1");
        assert!(clip.has_audio);
        assert!((clip.duration - 6.583).abs() < 1e-9);
    }

    #[test]
    fn merge_output_uses_episode_number() {
        assert_eq!(
            merge_output_name(Path::new("01 重生归来.md"), "20260917-123045"),
            "01 merge_20260917-123045.mp4"
        );
        assert_eq!(
            merge_output_name(Path::new("大纲.md"), "20260917-123045"),
            "merge_20260917-123045.mp4"
        );
    }

    #[test]
    fn concatenates_selected_clips_without_touching_markdown() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let markdown = root.join("01 中文.md");
        let original_md = "# 一集\n";
        fs::write(&markdown, original_md).unwrap();
        let first = root.join("S001.mp4");
        let second = root.join("S002.mp4");
        if !write_test_clip(&first, 1) || !write_test_clip(&second, 1) {
            panic!("未找到打包的 FFmpeg，请先运行 npm run ffmpeg:download");
        }
        let filename =
            concat_videos(&root, "01 中文.md", &["S001.mp4".into(), "S002.mp4".into()]).unwrap();
        assert!(filename.starts_with("01 merge_"));
        assert!(filename.ends_with(".mp4"));
        let output = root.join(&filename);
        assert!(output.is_file());
        assert_eq!(fs::read_to_string(markdown).unwrap(), original_md);
        let duration = probe_duration(&output).unwrap();
        assert!(duration > 1.5 && duration < 2.8, "{duration}");
        let info = probe_video_csv(&output, "stream=pix_fmt,profile");
        assert!(info.contains("yuv420p"), "{info}");
        assert!(!info.contains("10"), "{info}");
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.ends_with(".mp4") || name.contains("concat")
            })
            .collect();
        assert_eq!(leftovers.len(), 3, "{leftovers:?}");
    }

    #[test]
    fn concatenates_mixed_8bit_and_10bit_to_yuv420p() {
        let temp = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temp.path()).unwrap();
        let markdown = root.join("01 中文.md");
        fs::write(&markdown, "# 一集\n").unwrap();
        let first = root.join("S001.mp4");
        let second = root.join("S002.mp4");
        if !write_test_clip_with(&first, 1, "yuv420p10le", Some("high10")) {
            panic!("无法写出 10-bit 测试片，请确认打包的 FFmpeg 支持 libx264 10-bit");
        }
        if !write_test_clip(&second, 1) {
            panic!("未找到打包的 FFmpeg，请先运行 npm run ffmpeg:download");
        }
        let filename =
            concat_videos(&root, "01 中文.md", &["S001.mp4".into(), "S002.mp4".into()]).unwrap();
        let output = root.join(&filename);
        let info = probe_video_csv(&output, "stream=pix_fmt,profile");
        assert!(info.contains("yuv420p"), "{info}");
        assert!(!info.contains("yuv420p10"), "{info}");
        let duration = probe_duration(&output).unwrap();
        assert!(duration > 1.5 && duration < 2.8, "{duration}");
    }

    fn probe_video_csv(path: &Path, entries: &str) -> String {
        run(
            &ffprobe_binary().unwrap(),
            &[
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                entries,
                "-of",
                "csv=p=0",
                path_arg(path).unwrap(),
            ],
        )
        .unwrap()
    }
}
