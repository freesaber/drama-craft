# 03 Workspace and Storage

[简体中文](../zh-CN/03-workspace-storage.md) · [Index](../README.md)

## Implemented: files first

```text
Original work/
  .drama-craft/project.json
  剧本大纲.md
  分镜总表.md
  01 第一集.md
  01 首帧_S001.png
  01 S001.mp4
  assets/                 # Optional; nested references are supported
```

Creation makes a same-named folder under the chosen parent and fails if it exists. Partial files from a failed creation are not automatically removed. Opening an existing project only attempts to add metadata; it never moves, renames or rewrites existing documents. Scans exclude hidden directories, node_modules, target, dist and symbolic links.

`project.json` contains `id`, `name`, `formatVersion: 1` and `layout: "preserve"`. It contains no root path, so reopening after relocation preserves the project ID. Unsupported versions and invalid JSON produce errors without replacement. If a read-only directory prevents initialization, a temporary identity and warning allow readable documents to remain accessible.

Recent projects and preview preferences live in `preferences.json` in Tauri's application data directory. This machine-local file may contain absolute paths and does not travel with a project. Copying metadata makes a copy with the same identity; P0 has no clone-as-new-project operation.

## Save semantics

Reads hash raw bytes with SHA-256 and expose LF-normalized editor text. Saves require the original hash and reject changed or deleted disk content. Existing UTF-8 BOM and CRLF style are preserved; new files use UTF-8 LF without BOM. Mixed line endings normalize to CRLF on save if the original contains CRLF.

Replacement uses a same-directory temporary file, writes and syncs it, then atomically replaces the target. Creation uses no-clobber persistence. This protects normal editor conflicts and partial writes; it is not a cross-process filesystem compare-and-swap and does not promise full directory durability after power failure. Read-only attributes are checked before replacement.

External changes are checked on manual refresh or window focus. Clean editors reload new content; dirty editors retain text and display a conflict. P0 has no background filesystem watcher or autosave.

## SQLite's role: planned

| Data | Authority | Rebuildable? |
|---|---|---|
| Scripts, prompts, notes | Markdown | Must preserve |
| Assets and videos | Local files | Must preserve |
| Project settings | Project JSON | Preserve identity |
| Generation tasks and selected versions | Future project SQLite | Not disposable cache |
| Search index | Scans, later optionally SQLite | Rebuildable from files |

P0 does not include SQLite. The video phase will add a project database for submission state, remote task IDs, version relationships, download state and selections, included in backups. Historical tasks reference immutable prompt and asset snapshots, independent of later edits. A global library database will be separate from project task databases and implemented in the library phase.

Copying a folder only carries project-local files. External absolute-path assets are not collected automatically. Complete backups, collecting external assets during export and remote-task recovery are future capabilities.
