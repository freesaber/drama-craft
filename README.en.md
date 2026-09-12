# DramaCraft

[简体中文](README.md) · [Development documents](doc/README.md)

A local Tauri workbench for short-drama production. Scripts, prompts and media stay in your project folder. Continue editing Markdown with your preferred external editor; no separately deployed backend is required.

## Current release: P0 text workbench

- Choose a working directory when creating a project, or open an existing folder without renaming or reorganizing files.
- Edit, preview and explicitly save Markdown; navigate episode files and `## S001 Shot title` headings.
- Discover local media links and inline-code filenames, check file availability, and preview images, audio and video.
- Detect external changes, protect against conflicting saves, save copies and guard unsaved exit.
- Markdown is the source of truth; JSON stores project metadata. P0 does not use SQLite.

**Not implemented yet:** language-model generation, H3 video requests, global character/voice libraries, FFmpeg concatenation, automatic backups or project packaging. See the [roadmap](doc/en/05-roadmap.md).

## Development

Requires Node.js 22, npm, Rust stable MSVC, Visual Studio Desktop development with C++ and WebView2. See the [development guide](doc/en/07-development-acceptance.md).

```powershell
npm ci
npm run tauri dev
```

For frontend preview only: `npm run dev`. A regular browser cannot access local projects; use the Tauri desktop client for filesystem features.

```powershell
npm test
npm run build
npm run docs:check
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --no-bundle
```

The final command produces the Windows executable; `npm run tauri build` produces an NSIS installer. Dependency lockfiles are version controlled.

## Workflow

1. Choose Create Project, select a parent directory, and enter a name. The client creates a same-named folder with an outline and shot overview.
2. Alternatively open an existing work's folder. Selecting its parent can display candidate projects.
3. Save with `Ctrl+S`. Return to the window or use Refresh to detect external changes.
4. A conflicting save preserves editor text. Save it as another document, or explicitly discard it and reload the disk version.

Markdown must be UTF-8 (optional BOM). New files use LF; existing CRLF documents retain CRLF. Media can live beside documents or in subdirectories. Existing absolute paths remain unchanged and may need manual correction after moving to another computer.

## Open-source preparation

The engineering structure and bilingual documentation are in place. A license will be selected before public release; no open-source license is granted yet. This repository excludes private scripts, voice samples, character images and generated videos. Tests use small original fixtures. Future publication does not automatically license third-party or private assets.
