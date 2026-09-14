# DramaCraft

[简体中文](README.md) · [Development documents](doc/README.md)

A local Tauri workbench for short-drama production. Scripts, prompts and media stay in your project folder. Continue editing Markdown with your preferred external editor; no separately deployed backend is required.

## Current release: P0 storyboard workbench

- Choose a working directory when creating a project, or open an existing folder without renaming or reorganizing files.
- Episodes open as vertical storyboards, split at Markdown headings or standalone `S001 Shot title` lines. Switch to Markdown source explicitly when needed.
- New episodes follow [Episode Data Format v1](doc/en/08-episode-format.md), parsed into episode, character, asset and dialogue data. Character images and voices share one bound card; legacy documents use a compatibility adapter.
- Edit first-frame/video prompts, parameters and asset paths in cards; story progression and dialogue remain in Markdown and episode information; add, delete and move cards without renumbering existing IDs.
- Discover local media links and inline-code filenames, check file availability, and preview images, audio and video.
- Detect external changes, protect against conflicting saves, save copies and guard unsaved exit.
- The left side shows the current video with reference images and audio below it; prompts, parameters and generation controls are on the right. Local images can replace request inputs.
- Use Video API settings to manage multiple named service URL and Authorization profiles and select the active profile. Then the app submits, polls and downloads results. Markdown selects the current video while SQLite retains task and version history.
- Markdown remains the content source of truth. JSON stores project identity; `.drama-craft/generations.sqlite3` stores only generation jobs and version indexes.

**Not implemented yet:** text-model generation, global character/voice libraries, FFmpeg concatenation, automatic backups or project packaging. H3 request code is connected, but Base64 transport, billable requests, voice behavior and provider responses still require validation with a real account. See [provider design](doc/en/06-providers-tasks.md) and the [roadmap](doc/en/05-roadmap.md).

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
3. Open an episode and edit its storyboard cards. Switch to source using the toolbar; both views share one draft. Documents without shots open in reading view.
4. Open Video API and enter the service URL plus the complete Authorization header value. The token is stored in Windows Credential Manager.
5. Review the prompt, parameters and references on the right of a shot, then choose Generate Video. The completed file downloads and becomes the current version.
6. Use Generation History to select an older local result. Markdown updates through the normal hash conflict check.
7. Save other edits with `Ctrl+S`. Return to the window or use Refresh to detect external changes; conflicts preserve editor text.

Generated files use names such as `S001_YYYYMMDD-HHMMSS.mp4` beside the episode document. Known jobs resume polling when their shot is opened again; a timed-out submission is not automatically repeated. Duplicate or unfamiliar field structures offer a source-location action instead of converting or dropping custom content. See [Markdown compatibility](doc/en/04-markdown-compatibility.md).

Markdown must be UTF-8 (optional BOM). New files use LF; existing CRLF documents retain CRLF. Media can live beside documents or in subdirectories. Existing absolute paths remain unchanged and may need manual correction after moving to another computer.

## Open-source preparation

The engineering structure and bilingual documentation are in place. A license will be selected before public release; no open-source license is granted yet. This repository excludes private scripts, voice samples, character images and generated videos. Tests use small original fixtures. Future publication does not automatically license third-party or private assets.
