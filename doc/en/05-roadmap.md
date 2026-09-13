# 05 Roadmap and P0 Checklist

[简体中文](../zh-CN/05-开发阶段与P0清单.md) · [Index](../README.md)

## P0: implemented delivery scope

| Subsystem | Delivery |
|---|---|
| Engineering | Tauri 2 + React/TypeScript/Vite + Rust, npm/Cargo lockfiles, Windows icon and build configuration |
| Projects | Chosen-parent creation, in-place opening, parent candidates, recents, portable JSON identity |
| Storyboard | Outline/overview/episode templates, default vertical cards, field edits/add/delete/move, source switching, shot navigation, explicit save and save-as |
| Compatibility | Existing layout, Chinese/space paths, UTF-8 BOM, CRLF, unknown Markdown content |
| Reliability | Hash conflict detection, atomic replacement, read-only errors, unsaved-exit guard, external refresh |
| Assets | Local reference discovery, existence checks, basic preview and system open |
| H3 video | Service URL and system credential configuration, Base64 reference requests, submit/query, streamed result download and current-version Markdown update |
| Generation history | Project-local SQLite job records, resume-on-open polling, failure status and local history selection |
| Documents | AGENTS.md, bilingual READMEs, paired documents 01–08 |

Code availability does not mean every environment has passed acceptance. See [07](07-development-acceptance.md) for reproducible commands and limits.

## Subsequent order: planned

1. **Live API verification and recovery hardening**: use a valid H3 account to verify image/audio Base64 transport, request/result shapes and voice behavior; add manual reconciliation for unknown submissions, polling backoff, download retry and serialized multi-job Markdown updates.
2. **Libraries and text production**: manually import characters, scenes, props and voices; default character voices with project and segment overrides; save temporary characters to the library. Generate outlines, scripts and shots in stages, applying results after user confirmation and retaining template versions.
3. **Export and backup**: FFmpeg concatenates selected clips in order with their original audio; check missing clips, format differences and output errors; collect external assets and provide complete backup/restore.

## Acceptance gates

Interface verification requires actual sample evidence; simulated success does not verify provider capabilities. Text generation must preserve manual edits. Video acceptance covers restart, submission timeout, download failure and old-version retention. Export checks order, audio and recoverable backups.

SQLite is created on demand when the first job is submitted, so projects that never use generation receive no empty database. Later edits affecting finished videos should mark impact rather than automatically triggering paid regeneration. License selection and dependency distribution licensing are separate public-release steps.
