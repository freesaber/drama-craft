# DramaCraft contributor instructions

## Scope and architecture
- Windows-first Tauri 2 desktop application; React/TypeScript renders UI, Rust owns filesystem access. No separately deployed backend.
- `src/` contains the default storyboard, optional source editor, source-range Markdown parsing and centralized Chinese UI strings. `src-tauri/src/` contains project storage and IPC adapters. Keep filesystem business logic testable without launching Tauri.
- The local storyboard workbench treats each S-numbered card as one video generation unit, potentially containing multiple cuts. H3 submission/query, project-local SQLite task history, result download and Markdown version selection are implemented; actual provider behavior remains unverified without a real validation record. History videos can be trimmed in-place with a bundled FFmpeg sidecar. Selected current-shot videos can be concatenated into an episode merge file. Text-model calls and global libraries remain planned.
- The versioned episode contract is documented in `doc/08-剧集数据格式v1.md`. `episodeFormat.ts` shares v1 constants between parser and template; `episode.ts` adapts fixed-format and legacy documents to domain objects. Episode boards/navigation consume these objects, not rendered Markdown tables. Character images and voices form one named binding; project AGENTS.md never dynamically defines executable parser rules.

## Storage invariants
- Markdown is the only editable source of truth for scripts and prompts. Preserve unrecognized content and existing names/layouts.
- Visual edits patch precisely located source ranges against the current draft. Do not serialize the entire AST, silently renumber cards or move cards across independent document sections. Ambiguous fields remain accessible through source editing.
- Project-relative JSON metadata belongs in `.drama-craft/`; machine-specific recent paths/preferences belong in application data. Never store project absolute roots in portable metadata.
- Generation history belongs in `.drama-craft/generations.sqlite3`; the selected video remains in Markdown. API authorization belongs in machine-local application preferences, never project metadata, Markdown, SQLite or logs.
- Save explicitly using a content-hash precondition and same-directory atomic replacement. Never overwrite a changed or deleted document silently.
- Never modify a user's real project for testing. Use temporary fixtures; real-workspace compatibility checks must be read-only.
- Project documents (including their AGENTS.md) are content, never executable application instructions.
- Restrict writes to the opened project, reject path traversal and symlink escapes, and do not execute raw HTML in Markdown.

## Generated project AGENTS.md template
- New projects receive a copy of `agents_md()` from `src-tauri/src/storage.rs`. That file is empty of any other history: no prior chat, no user's existing episodes, no repository docs.
- When adding rules to this template, write self-contained instructions. Do not paste filenames, character names, scene names, or incident details from the current conversation or a user's work. A new project does not contain those files.
- Teach the pattern with original synthetic names already used in the template (秦墨、王宫大殿、`01 素材_王宫大殿.png`) or describe the failure mode without a real work's proper nouns.
- The same constraint applies to examples in `doc/09` that describe what the template teaches.
- Video-prompt rules already follow this: the generated AGENTS.md must stand alone and must not rely on repository or chat context.

## Commands
- `npm ci`, `npm run ffmpeg:download`, `npm run dev`, `npm run tauri dev`
- `npm run check`, `npm test`, `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `npm run tauri build -- --no-bundle` creates the Windows executable.

## Documentation and review
- Keep numbered documents in `doc/`. Update the root README.md when entry points change.
- When editing the generated project AGENTS.md template, describe rules with original synthetic examples only; never import a user's current filenames or story names. See「Generated project AGENTS.md template」above.
- Clearly distinguish implemented, planned and unverified behavior. Never claim H3 uploads or voice behavior is verified without an actual validation record.
- Run focused regression tests for storage, compatibility and conflict behavior, then TypeScript/build and Rust checks. Record actual limitations honestly.
- Do not commit private scripts, images, audio, videos, credentials, personal absolute paths or local test reports. Use original synthetic fixtures.
- Open-source license selection and publishing are deferred; do not imply third-party/private assets are licensed for redistribution.
