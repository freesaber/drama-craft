# 01 Product Scope

[简体中文](../zh-CN/01-product-scope.md) · [Index](../README.md)

## Audience and outcome

A Windows workbench for individual creators producing short dramas with Markdown and local assets. The work's folder is its workspace. Scripts and prompts remain readable, editable and versionable without the client.

## Implemented: P0

Project creation and direct opening, recent projects, candidate works under a parent directory, document creation/editing/saving/save-as, Markdown preview, shot-heading navigation, local media previews, external-change detection and conflict protection. Opening or scanning does not rewrite existing documents.

New projects follow outline → episode documents → shots. Media may remain beside documents; subdirectories and external media paths are also supported. Existing content need not conform to a fixed form schema.

## Planned

The full workflow is story import → outline → episode scripts → shots and generation segments → asset binding → video generation and selection → simple concatenation. Complete scripts may skip outlining. Libraries will support characters, scenes, props and voices, with manually imported images first. Users will not need Codex or another authoring agent installed.

A project has episodes; a shot describes one camera shot; a generation segment corresponds to one video request and may contain one or more shots. Regeneration operates on a segment, preserving historical parameters and videos.

## Boundaries

Windows first, without a self-hosted server or OSS. P0 makes no paid model calls. Later export preserves original audio and offers simple concatenation, not multitrack timelines, complex transitions or subtitle editing. External tools can create first-frame images; P0 stores prompts and reads assets.

## Success criteria

Create projects in chosen directories, adopt existing folders without rearranging them, support Chinese paths, avoid silent overwrites after external edits, and round-trip unknown Markdown content. See [07](07-development-acceptance.md) for tests.
