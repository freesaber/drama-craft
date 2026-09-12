# 04 Markdown Compatibility

[简体中文](../zh-CN/04-markdown-compatibility.md) · [Index](../README.md)

## Implemented: preserve source

Any UTF-8 `.md` document is editable. Frontmatter is not required, and bodies are not converted into a separate database model. The outline and shot overview sort first, then naturally numbered episodes, then other documents. Nested documents retain relative paths, shown in full on hover.

Shot navigation extracts level-two Markdown headings such as `## S001 Shot title`. IDs accept either case and variable digit counts. Duplicate IDs produce diagnostics while retaining both locations. Similar text inside fenced code is not a heading. Unknown paragraphs, tables and code blocks can be saved without interpreting them.

```markdown
# 第01集 渡口

本集内容：船工等待归来的旅人。

## S001 点灯

### 首帧生成

出图文件名：`01 首帧_S001.png`。

### 视频生成

视频文件名：`01 S001.mp4`。

| API参数 | 提示词标签 | 上传素材 |
|---|---|---|
| `ref_image_0` | `<Picture 1>` | `01 首帧_S001.png` |

**视频提示词｜duration=5，resolution=768p横**
```

This example illustrates text organization only; it does not claim assets exist or provider parameters were verified. New episode templates include character/voice and asset tables plus separate first-frame and video prompt fences.

## Local assets

Discovery supports Markdown images, links, reference links and inline-code filenames, including those within tables. Bare prose filenames are not guessed; fenced code bodies are not scanned for assets. Images: PNG/JPG/JPEG/WebP/GIF/BMP. Audio: MP3/WAV/FLAC/OGG/M4A. Video: MP4/WebM/MOV. Actual playback depends on WebView2 codec support.

Relative references resolve from the document's directory. Space-containing links can use `[Reference](<assets/角色 一.png>)`. Windows absolute paths remain unchanged, for example `Z:/example-assets/character.png`. Missing files are reported without fabricating files or changing references. If embedded playback fails, the user can open the file in its system application.

Remote URLs, UNC shares and executable files are not loaded as P0 assets. Links and images in the document preview remain inert; the Assets panel loads actual media.

## Shot overview and future structured editing

The shot overview is an independent Markdown document. P0 never rewrites it from episodes automatically; creators or external editors maintain repeated information. Future form editing must update precisely located source regions while preserving unknown content. Forms and Markdown must not become competing content authorities.

## Existing-folder compatibility

Tests cover multiple episode documents, separate first-frame/video sections per shot, Chinese filenames with spaces, videos beside documents and external library references. A parent AGENTS.md does not prevent candidate detection and never supplies executable client instructions.
