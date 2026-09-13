# 07 Development and Acceptance

[简体中文](../zh-CN/07-开发指南与验收.md) · [Index](../README.md)

## Environment and launch

Windows 10/11, Node.js 22, npm, Rust stable MSVC, Visual Studio Desktop development with C++, and WebView2. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Development uses port 1420 and fails if occupied instead of silently switching ports.

```powershell
npm ci
npm run tauri dev
```

`npm run dev` previews only the browser UI without local file features. `npm run tauri build -- --no-bundle` produces `src-tauri/target/release/drama-craft.exe`; omit `--no-bundle` for NSIS packaging. Icons come from an original geometric drawing script, not private assets.

## Automated checks

```powershell
npm run check
npm test
npm run build
npm run docs:check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Markdown tests cover actual headings versus code fences, duplicate shot IDs, table/inline-code/reference assets, Chinese absolute paths, remote exclusion and natural sorting. Rust temporary-directory tests cover BOM/CRLF saves, external conflicts, deleted-file saves, path escapes, Windows names, read-only flags, relocated identity, corrupt metadata, missing media and non-UTF-8.

Generation tests use a temporary local HTTP service and make no billable requests. They verify submit/query paths, the Authorization header, local-image data URLs, streamed result download and SQLite history. This proves client protocol behavior only; it does not show that the live provider accepts Base64 or that voice conditioning works.

Storyboard regressions additionally cover standalone/titleless IDs, non-shot ranges, duplicate/missing/unrecognized fields, whole-document reference definitions, local patches, stale drafts, CRLF, fence growth, successive story edits, ID allocation, complete-block movement and deletion boundaries.

## Read-only real-workspace check

Set `DRAMACRAFT_COMPAT_DIR` to a local work's directory, then run the ignored compatibility test:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml external_workspace_readonly_check -- --ignored
```

This calls scan/read directly without project initialization and compares every file's before/after hash. The expected sample has 12 episodes; shot-recognition targets are 184 shots overall and 13 in episode one. Never check personal paths into the repository or copy real manuscripts/media into public fixtures.

## Desktop interaction acceptance

Use temporary original projects to check creation, reopening, new episodes defaulting to storyboards, card field edits, add/move/delete and cancellation, source synchronization, Ctrl+S, shot jumps, lazy media loading, external conflicts, save-as and unsaved-exit protection. Never run write tests against actual works. Inspect default and 1024×680 minimum window sizes; decoder failure should still allow system opening.

After building the executable, run the actual WebView2 desktop regression without using real works:

```powershell
$env:DRAMACRAFT_TEST_EXE = (Resolve-Path 'src-tauri/target/release/drama-craft.exe').Path
npm run test:desktop
```

Screenshots stay in ignored `test-results/`. The test restores recent-project preferences and removes its temporary project. Without the executable variable, the script uses a debug build.

Local Windows validation on 2026-09-12: 24 frontend tests, nine Rust storage tests, type checking, frontend and Windows executable builds, Rust check/format check, bilingual documentation checks, and the real WebView2 desktop regression passed. Desktop checks include character-by-character input, an original silent WebM, invalid-image feedback, deletion conflicts and read-only save-as. The two real-workspace compatibility tests were not enabled. H3 uploads, cloud generation and voice behavior were not validated; installers and other operating systems were not revalidated.

Incremental validation on 2026-09-13: all 34 frontend tests passed with read-only compatibility checks enabled. Nine Rust storage tests and the separately enabled real-workspace read-only test passed, as did type checking, builds, Rust check/format check and documentation checks. The real sample yielded 12 episodes, 184 shots and their first-frame/video references; five video files existed. Every inspected file retained its hash. An existing local MP4 passed path resolution and media probing identified H.264/AAC; real-work videos were not individually played in the desktop UI. Filename parsing now accepts trailing save instructions.

The WebView2 regression additionally verified a character image and candidate voice in the same character card, shot-to-character associations, and episode storyboards without rendered source Markdown tables. Displaying voice status does not establish audition or voice quality. New episodes use v1; existing episodes use compatibility parsing. The client does not execute a work directory's AGENTS.md.

H3 increment on 2026-09-13: submit/query endpoints, Windows credential configuration, local-reference data URLs, polling, streamed downloads, SQLite history and Markdown version selection were implemented. Type checking, frontend build, Rust checks, the mock-service regression and a real WebView2 temporary-project regression passed. Desktop coverage includes the API settings form, the new two-column layout, and no horizontal overflow at 1440×960 or 1024×680. No valid account was used to verify live upload, billing, result download or voice behavior.

## Delivery boundaries

There is currently no text model, persistent background polling, job cancellation, asset library, complete backup or video concatenation/export. Only a known remote `task_id` can resume when its shot is reopened. A lost submission response is neither repeated nor automatically reconciled. Preview depends on system codecs, mixed line endings normalize on save, and atomic replacement is not cross-process compare-and-swap. Automatic refresh does not overwrite in-progress editing.

Before public release, select a license, review dependency distribution licensing and consider installer signing. Keep both languages synchronized. Build success is not evidence of unexecuted UI or cloud acceptance.
