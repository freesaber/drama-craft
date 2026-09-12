# 05 Roadmap and P0 Checklist

[简体中文](../zh-CN/05-roadmap.md) · [Index](../README.md)

## P0: implemented delivery scope

| Subsystem | Delivery |
|---|---|
| Engineering | Tauri 2 + React/TypeScript/Vite + Rust, npm/Cargo lockfiles, Windows icon and build configuration |
| Projects | Chosen-parent creation, in-place opening, parent candidates, recents, portable JSON identity |
| Text | Outline/overview/episode templates, source editor and preview, shot navigation, explicit save and save-as |
| Compatibility | Existing layout, Chinese/space paths, UTF-8 BOM, CRLF, unknown Markdown content |
| Reliability | Hash conflict detection, atomic replacement, read-only errors, unsaved-exit guard, external refresh |
| Assets | Local reference discovery, existence checks, basic preview and system open |
| Documents | AGENTS.md, bilingual READMEs, paired documents 01–07 |

Code availability does not mean every environment has passed acceptance. See [07](07-development-acceptance.md) for reproducible commands and limits.

## Subsequent order: planned

1. **Model configuration and verification**: OpenAI-compatible text configuration; independent H3 endpoint, workflow and Token settings; verify image/audio transport, request/result shapes and voice behavior. Credentials belong in OS credential storage, not project files.
2. **Libraries and text production**: manually import characters, scenes, props and voices; default character voices with project and segment overrides; save temporary characters to the library. Generate outlines, scripts and shots in stages, applying results after user confirmation and retaining template versions.
3. **Video loop and SQLite**: project task database and migrations, request snapshots, polling, downloads, restart recovery, version selection and failure handling. Never automatically resubmit an ambiguous request; submit serially by default.
4. **Export and backup**: FFmpeg concatenates selected clips in order with their original audio; check missing clips, format differences and output errors; collect external assets and provide complete backup/restore.

## Acceptance gates

Interface verification requires actual sample evidence; simulated success does not verify provider capabilities. Text generation must preserve manual edits. Video acceptance covers restart, submission timeout, download failure and old-version retention. Export checks order, audio and recoverable backups.

P0 does not build empty databases or pretend generation buttons. Later edits affecting finished videos should mark impact rather than automatically triggering paid regeneration. License selection and dependency distribution licensing are separate public-release steps.
