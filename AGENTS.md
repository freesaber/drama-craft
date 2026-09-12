# DramaCraft contributor instructions

## Scope and architecture
- Windows-first Tauri 2 desktop application; React/TypeScript renders UI, Rust owns filesystem access. No separately deployed backend.
- `src/` contains the editor, Markdown navigation and centralized Chinese UI strings. `src-tauri/src/` contains project storage and IPC adapters. Keep filesystem business logic testable without launching Tauri.
- P0 is a local Markdown workbench. Model calls, SQLite, generated-video jobs, global libraries and FFmpeg are planned, not implemented.

## Storage invariants
- Markdown is the only editable source of truth for scripts and prompts. Preserve unrecognized content and existing names/layouts.
- Project-relative JSON metadata belongs in `.drama-craft/`; machine-specific recent paths/preferences belong in application data. Never store project absolute roots in portable metadata.
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
- Keep numbered documents in `doc/zh-CN/` and `doc/en/` paired and semantically synchronized. Update both READMEs when entry points change.
- Clearly distinguish implemented, planned and unverified behavior. Never claim H3 uploads or voice behavior is verified without an actual validation record.
- Run focused regression tests for storage, compatibility and conflict behavior, then TypeScript/build and Rust checks. Record actual limitations honestly.
- Do not commit private scripts, images, audio, videos, credentials, personal absolute paths or local test reports. Use original synthetic fixtures.
- Open-source license selection and publishing are deferred; do not imply third-party/private assets are licensed for redistribution.
