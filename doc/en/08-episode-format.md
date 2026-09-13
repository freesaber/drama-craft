# 08 Episode Data Format v1

[简体中文](../zh-CN/08-剧集数据格式v1.md) · [Index](../README.md)

## Data contract

Markdown is the editable file container. Fixed fields are parsed into `EpisodeData`, `CharacterData`, `EpisodeAsset`, `DialogueData` and shot objects. Storyboards render those objects, not the episode's Markdown tables, headings or flat media inventories. Ordinary documents retain Markdown reading view.

AGENTS.md constrains authoring-agent output; it is not executable client configuration. The parser and new-document template share the v1 contract in code. Changing authoring instructions does not automatically teach the client a new schema.

## Required format

1. One UTF-8 `.md` per episode, starting with a standalone `<!-- drama-craft:episode:v1 -->`, followed by `# 第01集 Episode title`. Do not wrap the entire file in a code fence.
2. Put the summary in a separate paragraph beginning `本集内容：`. Character, asset and dialogue tables precede the first shot.
3. Use the exact character columns, in order: `角色ID | 名称 | 角色图 | 音色文件 | 音色状态 | 使用镜号`. Each row binds a character image and voice; do not split them into separate tables. Use `C001` for characters and `N001` for narrators, keeping IDs, names and established voices stable across episodes. Narrators may have no image.
4. Voice status is one of `候选未试听` (candidate, unauditioned), `用户指定未试听` (user-selected, unauditioned), `已试听确认` (auditioned and confirmed), `待补` (missing) or `无需音色` (not needed). File existence does not establish auditioning or model performance.
5. Asset columns are `素材ID | 名称 | 类型 | 文件 | 使用镜号`. Use stable `A001` IDs and scene, prop or state-variant types. Character images belong to character bindings and are not repeated as independent character assets.
6. Dialogue columns are `镜号 | 角色ID | 发声方式 | 台词 | 发声区间`. Delivery is on-screen, off-screen or narration. Character IDs must exist. Keep an empty header when there is no dialogue. Table dialogue and video prompts should agree; the client does not rewrite prompts automatically.
7. Put paths in inline code or Markdown links; use `—` for empty values. Space-containing links use `[Name](<relative path>)`. Relative paths resolve against the episode document directory; existing external absolute references remain readable. Never fabricate existing assets or rename generated files just to normalize formatting.
8. Enumerate shot IDs explicitly, such as `S001、S002、S003`, without range shorthand. Start each shot with `## S001 Shot title`; IDs are unique within an episode. An S-number identifies one video-generation unit, potentially containing multiple cuts.
9. Include a separate `角色：C001、N001` field per shot for all visible or speaking roles. Use `角色：—` for none. Membership must agree with the character table's shot usage.
10. Each shot contains `### 故事走向`, `### 首帧生成`, then `### 视频生成`. Story progression is plain text describing action, change or outcome, not a pasted model prompt.
11. Each `出图文件名：` and `视频文件名：` occupies its own paragraph with one inline-code filename. Put saving instructions and GPT attachment descriptions in separate paragraphs. Defaults are `01 首帧_S001.png` and `01 S001.mp4`; established user filenames take priority.
12. Prompt labels are exactly `**首帧图片提示词**` and `**视频提示词｜duration=5，resolution=768p横**`, each immediately followed by exactly one complete `text` code fence. Preserve prompt content; enlarge the outer fence if the prompt contains backticks.
13. Video inputs retain `API参数 | 提示词标签 | 上传素材`. For example, `ref_image_0` maps to `<Picture 1>` and `ref_audio_0` to `<Audio 1>`. This per-request upload mapping does not replace character/voice bindings. Provider limits and actual behavior still require verification.
14. New asset prompts may precede shots under `### Asset name` and a following `text` fence. Names must match the asset table. Unknown custom paragraphs remain in source and are accessed through source mode instead of being appended to the default storyboard.

## Complete minimal example

The original example below demonstrates syntax; its paths are placeholders, not claims that files exist. Field labels remain Chinese in both documentation languages because they form the same on-disk contract.

````markdown
<!-- drama-craft:episode:v1 -->

# 第01集 渡口灯火

本集内容：旅人点灯，让船夫看见靠岸的位置。

## 角色绑定

| 角色ID | 名称 | 角色图 | 音色文件 | 音色状态 | 使用镜号 |
|---|---|---|---|---|---|
| C001 | 旅人 | `角色/旅人.png` | `声音/旅人.wav` | 候选未试听 | S001 |

## 本集使用素材

| 素材ID | 名称 | 类型 | 文件 | 使用镜号 |
|---|---|---|---|---|
| A001 | 渡口 | 场景 | `01 素材_渡口.png` | S001 |

## 本集声音安排

| 镜号 | 角色ID | 发声方式 | 台词 | 发声区间 |
|---|---|---|---|---|
| S001 | C001 | 画内 | 灯还亮着。 | 1—3秒 |

## S001 点灯

角色：C001

### 故事走向

旅人举起灯，让岸边的位置显露出来。

### 首帧生成

出图文件名：`01 首帧_S001.png`。

GPT附件：图片1＝渡口母版；图片2＝旅人参考图。

**首帧图片提示词**

```text
场景沿用图片1，角色沿用图片2。旅人站在岸边，手中的灯尚未举起。
```

### 视频生成

视频文件名：`01 S001.mp4`。

| API参数 | 提示词标签 | 上传素材 |
|---|---|---|
| `ref_image_0` | `<Picture 1>` | `01 首帧_S001.png` |
| `ref_audio_0` | `<Audio 1>` | `声音/旅人.wav` |

**视频提示词｜duration=5，resolution=768p横**

```text
<Picture 1>：本镜完整首帧。
<Audio 1>：旅人音色样本，只借音色说新台词，不复述样本内容。
旅人缓缓举灯，灯光照亮岸沿，摄影机保持固定。
旅人画内对白（1—3秒，使用<Audio 1>的音色）：灯还亮着。
```
````

## Legacy documents and errors

Unversioned documents use a compatibility adapter. Separate legacy image and voice tables join by explicit speaker names; semicolon-delimited identity notes are retained, and filenames are never used to guess identity. Legacy filename paragraphs may include saving or attachment instructions; editing replaces only the filename span.

Opening a legacy document never converts it, and adding only a version marker does not make it compliant. Normalization requires a separate explicit operation preserving prompts, dialogue, paths and IDs. Template/field tests validate new-document structure. Duplicate roles, undefined roles/shots, wrong voice media types and missing binding tables produce diagnostics. Unsupported versions disable structured editing but retain source access. The client neither executes AGENTS.md nor searches by ID to silently bind undeclared files.
