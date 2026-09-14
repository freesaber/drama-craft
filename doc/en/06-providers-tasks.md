# 06 Providers and Generation Tasks

[简体中文](../zh-CN/06-模型接入与生成任务设计.md) · [Index](../README.md)

This document separates the implemented H3 client path from provider behavior that still needs validation with a real account.

## Implemented: H3 provider boundary

Video API settings support multiple named profiles, each with a Base URL and complete Authorization header value. Select the active profile from a dropdown and save it for subsequent submissions. The token is stored in Windows Credential Manager rather than the project or SQLite. Rust performs network requests inside the client without a separate backend. Text models and other video protocols still need separate adapters.

The implementation follows this requirements baseline. No billable request has been made with a valid account, so provider details still need live verification.

| Item | Current implementation |
|---|---|
| Submit | `/api/v1/comfyui/comfyui_workflow/minimax_h3_zm_u24` |
| Query | `/api/v1/comfyui/comfyui_workflow/result/{task_id}` |
| Authentication | Complete user-entered `Authorization` value; no automatic Bearer or Token prefix |
| Prompt | prompt, 1–10000 characters |
| Duration | duration, integer 1–15 seconds |
| Resolution | 480p/768p landscape, portrait and 1:1; verify actual enum |
| Images | ref_image_0 through ref_image_8; one to nine |
| Audio | ref_audio_0 through ref_audio_2; up to three |
| Seed | seed, defaults to 683072603085674; editable or clear to omit |

`ref_image_0` maps to `<Picture 1>` and `ref_audio_0` to `<Audio 1>`. Rebuild mappings per request, numbering images and audio independently. GPT first-frame attachment numbering is separate from H3 parameters. Actual label and speaker adherence requires sample validation.

## Implemented: local assets, jobs and versions

Local JPG/PNG/WebP images and MP3/WAV/FLAC/MP4 audio are sent as Base64 data URLs in JSON; HTTP(S) references remain URLs. The UI derives image inputs from the first frame, cast and shot assets, and derives audio from cast voices, capped at nine images and three audio inputs. Thumbnails open a larger preview. A user can import a local replacement beside the episode document for the current request.

Duration (1–15 seconds) and all six resolutions use dropdowns. Nonstandard legacy values remain visible without automatic rewriting. Cards hide story, cast and per-shot dialogue panels while preserving Markdown content; reference images and audio appear below the video.

After submission returns a `task_id`, the app immediately writes it to `.drama-craft/generations.sqlite3`. New jobs also record their profile ID and service URL without credentials. Switching the default profile does not change their polling account. Changing that profile’s URL pauses polling until the original URL is restored. Older jobs without a binding use the current profile. Legacy single-profile settings appear as Default API and retain their existing credential. The app polls known jobs every three seconds and resumes when that shot is opened again. A successful result streams to a temporary file beside the episode and atomically becomes `01 S001_YYYYMMDD-HHMMSS.mp4`. The app then updates the Markdown video filename from the current draft with the original content-hash precondition. External conflicts preserve both the draft and downloaded result. SQLite stores parameters, status, remote URL and local version indexes; Markdown stores the selected video. Any retained local version can be selected again.

## Unverified: live service and voice

The supplied request example uses MIME-prefixed Base64 data URLs. Local mock tests verify image/audio encoding and request headers; a real account must still verify provider acceptance. If it only accepts public URLs, use an official provider upload endpoint instead of introducing undeclared object storage. Also verify status enums, result URL authentication and expiry, and exact resolution values.

Distinguish voice samples from prerecorded dialogue. Verify speaking new lines, mapping voices across multiple characters and whether off-screen voices are incorrectly assigned in single-character close-ups. Authoring experience can inform templates but cannot guarantee model behavior.

## Planned: recovery hardening

The current version records a job after receiving the remote `task_id`. A later revision must create a local request identity before the network submission and expose manual reconciliation when the server may have accepted a request whose response never reached the client.

Lifecycle: queued → submitting → accepted/running → generated → downloading → saved. A submission timeout becomes “outcome unknown” and must never automatically repeat a billable request. Unknown submissions without task_id require manual reconciliation; recovery cannot be assumed. Polling and downloads can retry with backoff; download failures do not regenerate videos.

Polling network errors continue retrying; download failure never regenerates the video. Exponential backoff, explicit download retry, cancellation, tray execution, shutdown warnings, serialized Markdown updates for concurrent completions, and expired results after sleep remain planned.

Authorization is stored in Windows Credential Manager and excluded from logs and project backups. Live H3 upload, billing and voice behavior remain unverified; compilation and a mock service test are not substitutes for that record.
