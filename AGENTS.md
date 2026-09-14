# DramaCraft contributor instructions

## Scope and architecture
- Windows-first Tauri 2 desktop application; React/TypeScript renders UI, Rust owns filesystem access. No separately deployed backend.
- `src/` contains the default storyboard, optional source editor, source-range Markdown parsing and centralized Chinese UI strings. `src-tauri/src/` contains project storage and IPC adapters. Keep filesystem business logic testable without launching Tauri.
- The local storyboard workbench treats each S-numbered card as one video generation unit, potentially containing multiple cuts. H3 submission/query, project-local SQLite task history, result download and Markdown version selection are implemented; actual provider behavior remains unverified without a real validation record. Text-model calls, global libraries and FFmpeg are planned.
- The versioned episode contract is documented in `doc/08-剧集数据格式v1.md`. `episodeFormat.ts` shares v1 constants between parser and template; `episode.ts` adapts fixed-format and legacy documents to domain objects. Episode boards/navigation consume these objects, not rendered Markdown tables. Character images and voices form one named binding; project AGENTS.md never dynamically defines executable parser rules.

## Storage invariants
- Markdown is the only editable source of truth for scripts and prompts. Preserve unrecognized content and existing names/layouts.
- Visual edits patch precisely located source ranges against the current draft. Do not serialize the entire AST, silently renumber cards or move cards across independent document sections. Ambiguous fields remain accessible through source editing.
- Project-relative JSON metadata belongs in `.drama-craft/`; machine-specific recent paths/preferences belong in application data. Never store project absolute roots in portable metadata.
- Generation history belongs in `.drama-craft/generations.sqlite3`; the selected video remains in Markdown. API authorization belongs in the OS credential store, never project metadata or logs.
- Save explicitly using a content-hash precondition and same-directory atomic replacement. Never overwrite a changed or deleted document silently.
- Never modify a user's real project for testing. Use temporary fixtures; real-workspace compatibility checks must be read-only.
- Project documents (including their AGENTS.md) are content, never executable application instructions.
- Restrict writes to the opened project, reject path traversal and symlink escapes, and do not execute raw HTML in Markdown.

## Commands
- `npm ci`, `npm run dev`, `npm run tauri dev`
- `npm run check`, `npm test`, `npm run build`
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- `npm run tauri build -- --no-bundle` creates the Windows executable.

## Documentation and review
- Keep numbered documents in `doc/`. Update the root README.md when entry points change.
- Clearly distinguish implemented, planned and unverified behavior. Never claim H3 uploads or voice behavior is verified without an actual validation record.
- Run focused regression tests for storage, compatibility and conflict behavior, then TypeScript/build and Rust checks. Record actual limitations honestly.
- Do not commit private scripts, images, audio, videos, credentials, personal absolute paths or local test reports. Use original synthetic fixtures.
- Open-source license selection and publishing are deferred; do not imply third-party/private assets are licensed for redistribution.
