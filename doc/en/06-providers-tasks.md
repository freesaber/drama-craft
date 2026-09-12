# 06 Providers and Generation Tasks

[简体中文](../zh-CN/06-providers-tasks.md) · [Index](../README.md)

**Everything here is future design, not a claim that P0 generates content.**

## Planned: provider boundaries

Text generation will first support OpenAI-compatible endpoints with name, Base URL, model and API Key. H3 has separate endpoint, workflow, Token and concurrency settings. Switching addresses works only within a compatible protocol; other protocols need adapters. Rust performs requests inside the client without a separately deployed backend.

Verification starts with [AutoDL API documentation](https://autodl.art/docs/comfyui_api/) and the [H3 workflow](https://autodl.art/large-model/comfyui/minimax_h3_zm_u24). The following baseline came from the requirements and must be rechecked during implementation.

| Item | Requirements baseline, unverified |
|---|---|
| Submit | `/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24` |
| Query | `/api/v1/comfyui/comfyui_workflow/result/{task_id}` |
| Authentication | `Authorization: Token…`; do not assume Bearer |
| Prompt | prompt, 1–10000 characters |
| Duration | duration, integer 1–15 seconds |
| Resolution | 480p/768p landscape, portrait and 1:1; verify actual enum |
| Images | ref_image_0 through ref_image_8; one to nine |
| Audio | ref_audio_0 through ref_audio_2; up to three |
| Seed | seed, optional integer |

`ref_image_0` maps to `<Picture 1>` and `ref_audio_0` to `<Audio 1>`. Rebuild mappings per request, numbering images and audio independently. GPT first-frame attachment numbering is separate from H3 parameters. Actual label and speaker adherence requires sample validation.

## Unverified: asset transport and voice

First verify whether Base64 is accepted directly and whether the format is raw Base64, a data URL or a web upload conversion. If only public URLs work, check for an official provider upload endpoint. Do not silently introduce self-hosted OSS. Without a workable transport, mark local-asset generation blocked.

Distinguish voice samples from prerecorded dialogue. Verify speaking new lines, mapping voices across multiple characters and whether off-screen voices are incorrectly assigned in single-character close-ups. Authoring experience can inform templates but cannot guarantee model behavior.

## Planned: recovery

Persist a local task ID and immutable inputs before submission, including prompt, template version, provider parameters and asset copies or stable content identities. Persist the remote task_id immediately upon receipt.

Lifecycle: queued → submitting → accepted/running → generated → downloading → saved. A submission timeout becomes “outcome unknown” and must never automatically repeat a billable request. Unknown submissions without task_id require manual reconciliation; recovery cannot be assumed. Polling and downloads can retry with backoff; download failures do not regenerate videos.

Result URLs may expire, so download promptly to a temporary file and finalize it as a local version. Restart resumes known tasks. Retain old videos, prompts and asset snapshots, with explicit user version selection. Pause stops future submissions, not remote tasks. Tray operation, shutdown warnings and expired results after sleep belong to the video phase.

Store keys and Tokens in OS credential storage, redact logs and exclude secrets from backups. P0 stores no credentials and sends no model requests.
