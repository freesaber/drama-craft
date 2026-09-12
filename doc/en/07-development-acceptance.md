# 07 Development and Acceptance

[简体中文](../zh-CN/07-development-acceptance.md) · [Index](../README.md)

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

## Read-only real-workspace check

Set `DRAMACRAFT_COMPAT_DIR` to a local work's directory, then run the ignored compatibility test:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml external_workspace_readonly_check -- --ignored
```

This calls scan/read directly without project initialization and compares every file's before/after hash. The expected sample has 12 episodes; shot-recognition targets are 184 shots overall and 13 in episode one. Never check personal paths into the repository or copy real manuscripts/media into public fixtures.

## Desktop interaction acceptance

Use temporary original projects to check creation, reopening through recents, episode creation, Ctrl+S, shot jumps, media, external-change conflicts, save-as and unsaved-exit protection. Never run write tests against actual works. Inspect default and minimum window sizes; decoder failure should still allow system opening.

## Delivery boundaries

P0 has no autosave, background watcher, database, paid requests, asset collection, complete backup or video export. Preview depends on system codecs, mixed line endings normalize on save, and atomic replacement is not cross-process compare-and-swap. Automatic refresh does not overwrite in-progress editing.

Before public release, select a license, review dependency distribution licensing and consider installer signing. Keep both languages synchronized. Build success is not evidence of unexecuted UI or cloud acceptance.
