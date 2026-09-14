# 04 Markdown Compatibility

[简体中文](../zh-CN/04-Markdown格式与兼容约定.md) · [Index](../README.md)

## Implemented: preserve source

New episodes use [08 Episode Data Format v1](08-episode-format.md). The permissive forms below are legacy compatibility rules, not presentation requirements. Episode views render parsed data, bind character images to voices, and retain unknown source behind the source-mode entry point.

Any UTF-8 `.md` document is editable. Frontmatter is not required, and bodies are not converted into a separate database model. The outline and shot overview sort first, then naturally numbered episodes, then other documents. Nested documents retain relative paths, shown in full on hover.

Storyboards and navigation extract `S001 Shot title` from root-level Markdown headings or standalone paragraphs. Heading markup and titles are optional; the ID is required. IDs accept either case and variable digit counts. Duplicate IDs retain separate cards with diagnostics. Bare markers must occupy an entire paragraph; code, tables, blockquotes and continuous prose are ignored. Heading cards end at the next same/higher heading or shot; bare cards end at the next shot or level-one/two heading. Non-shot content retains its independent source order.

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

Remote URLs, UNC shares and executable files are not loaded as P0 assets. Document links and images remain inert; cards and asset sections load actual media on demand. Each card extracts references from its own range while resolving reference links against whole-document definitions. Shared definitions can be edited in Markdown source; changing one affects all usages.

## Implemented: storyboard editing and source-range patches

Each card displays its first-frame image prompt directly below the generation area, with one label and an editable text area. There is no disclosure or tab bar. Reference images and audio are shown under the video preview; this prompt area does not repeat them. Output filenames and other reference paths remain editable in Markdown source.

The shot overview is an independent Markdown document. P0 never rewrites it from episodes automatically; creators or external editors maintain repeated information. Card editing patches precisely located source regions in the shared draft; untouched regions remain unchanged.

Fields recognize the existing Chinese labels `出图文件名`, `视频文件名`, `首帧图片提示词`, `视频提示词`, and `duration`/`resolution` within the video label. A prompt label must immediately precede one complete fenced code block. Story progression uses `### 故事走向` (deeper headings for deeper shot markers), added only when first edited. Missing prompts and filenames are likewise inserted on explicit editing. Prompt edits enlarge fences when needed. Parameters are local text, not verified provider specifications.

Duplicate fields, unfamiliar prompt sections, complex story formatting and references that cannot be safely patched retain their source and offer a source-location action. Missing sections under level-six shot headings require source editing. Missing assets have explicit placeholders; no files are fabricated.

New IDs use the maximum existing number plus one, padded to at least three digits. Confirmed deletion removes only the complete card range from the draft. Moving swaps adjacent cards without crossing independent information or renumbering IDs. All changes require explicit saving; stale draft patches are rejected.

## Existing-folder compatibility

Tests cover multiple episode documents, separate first-frame/video sections per shot, Chinese filenames with spaces, videos beside documents and external library references. A parent AGENTS.md does not prevent candidate detection and never supplies executable client instructions.
