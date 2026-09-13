# 01 Product Scope

[简体中文](../zh-CN/01-产品定位与范围.md) · [Index](../README.md)

## Audience and outcome

A Windows workbench for individual creators producing short dramas with Markdown and local assets. The work's folder is its workspace. Scripts and prompts remain readable, editable and versionable without the client.

## Implemented: P0

Project creation and direct opening, recent projects, candidate works under a parent directory, document creation/editing/saving/save-as, default vertical storyboards, explicit source mode, shot navigation, local media previews, external-change detection and conflict protection. Opening or scanning does not rewrite existing documents.

Each S-numbered card represents one video unit, potentially containing multiple cuts. The left side shows only the current video; the right edits story progression, video prompt, duration, resolution, seed and thumbnail assets. Cards can also be added, deleted and moved. Documents without shots open in reading view. Common information and unknown content are retained, and both views share one Markdown draft.

The H3 generation path supports service and system-credential configuration, submit/poll, result download, SQLite history and version selection. A mock service covers the client implementation; live uploads, billing, result shapes and voice behavior still require a valid-account test.

New projects follow outline → episode documents → shots. Media may remain beside documents; subdirectories and external media paths are also supported. Existing content need not conform to a fixed form schema.

## Planned

The full workflow is story import → outline → episode scripts → shots and generation segments → asset binding → video generation and selection → simple concatenation. Complete scripts may skip outlining. Later libraries will support characters, scenes, props and voices. Users will not need Codex or another authoring agent installed.

A project has episodes; each current S-numbered storyboard card represents one video request unit and may contain multiple cuts. This release does not introduce a separate internal-cut structure. Future regeneration operates on that unit, preserving historical parameters and videos.

## Boundaries

Windows first, without a self-hosted server or OSS. Video requests go only to the user-configured service. Later export preserves original audio and offers simple concatenation, not multitrack timelines, complex transitions or subtitle editing. First-frame images still come from external tools or local imports.

## Success criteria

Create projects in chosen directories, adopt existing folders without rearranging them, support Chinese paths, avoid silent overwrites after external edits, and round-trip unknown Markdown content. See [07](07-development-acceptance.md) for tests.
