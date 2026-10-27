# Current handoff

Updated: 2026-10-27 UTC. Read [AGENTS.md](AGENTS.md) for constraints, [README.md](README.md) for behavior and [architecture](docs/architecture.md) for module ownership.

## Runtime connectivity and turn lifecycle

Deployment Compose pins `name: llm-watch-video` and gives the bot a dual-stack `egress` bridge (`fd73:83c1:9b4b::/64`, Docker-managed IPv4/NAT). Current read-only inspection confirms `llm-watch-video-bot-1` is running with that network. The isolated Codex home has ChatGPT login mode, no API key, no `config.toml`, and no configured HTTP/HTTPS/ALL proxy variables. Model inference therefore uses the container's Codex ChatGPT-authenticated provider path directly; MCP webpage/media downloads are separate. No live Codex process was present when socket ownership was inspected, so no actual inference connection family was observed.

Explicit unauthenticated connectivity probes after the user's restart: host and container IPv4 HTTPS to QQ succeeded; IPv4 TCP connections to `chatgpt.com` and `api.openai.com` timed out. Unforced container HTTPS HEAD probes selected IPv6 for both OpenAI domains (HTTP 403/421). This proves transport only, not authenticated model readiness or a forced IPv6 policy. The host connection-tracking table held 40/65,536 entries when checked; current measurements do not establish the pre-restart cause. No proxy/network configuration changes, model requests or QQ submissions were made. Existing stops and data are preserved; cloudcli/cloudflared remain untouched.

Source removes the default whole-turn deadline, rejects same-scope overlapping adapter runs before preparation, and immediately routes sanitized Codex error categories through diagnostics and administrator notifications independently of Run feedback. Retriable errors leave the turn active; terminal notifications end it. Fixed stderr signatures are classified from a bounded buffer without retaining raw output. Per-request/tool/media/wait deadlines and cancellation remain. Offline lifecycle and feedback checks use synthetic sessions/processes and fake delivery only.

## Source cleanup (not deployed)

Private foreground handling no longer retains a group-inference branch; group discussion stays on the collected batch path and group commands still dispatch locally. Unified file tools enforce project-area access in their schemas/actions, so the unused project flag has been removed from tool-policy/approval APIs. MCP composition shares one message-record store across detail/audio/file/media tools and closes it after capability cleanup. README and AGENTS consolidate current behavior and development constraints; `.env.example` uses the Compose-relative project source mount rather than an obsolete host checkout path. Existing persistent formats/readability are retained. The user deploys these source changes. Changed-module syntax/import and documentation-link checks passed, together with offline conversation-event, content-codec, message-detail-image, MCP-codec, file, memory, group-behavior, send-limit, Codex-lifecycle, feedback-routing, media-stream and media-audio checks. All behavior checks used disposable state/fake model or QQ transports; no real encoding/ASR/model/QQ validation or deployment was performed for cleanup.

## Administrator files and media (source only)

Unified `save_file`/`read_file`/`list_files`/`delete_file` replace the old workspace/memory/project/saved-image tool wrappers. Sources are generated text, checked public URL, current QQ image/attachment, or browser asset. Selected workspace files persist without automatic expiry; old flat text files and old image assets remain accessible without bulk migration. Public/QQ downloads stream through their original address/domain gates. MP4 output defaults to bounded encoding, with QQ MP4 passthrough unless bitrate is explicit; explicit original/GIF/MP3 modes are supported. Browser screenshots/player frames require `turn_id` and are temporary until acknowledged turn cleanup; `save_file` is the persistence decision. Saved video/GIF works with `read_media(file_name)`; saved image/audio sends with `send_reply.media.file_name`. Administrator `/files` lists and confirmably deletes binary files and opens selected image/audio/video privately. No compaction policy or shared-summary UI change is included. Offline synthetic checks cover streamed public/QQ byte acquisition, type validation, overwrite/cancellation/concurrent publication, preserved legacy text, saved media reads/sends and private-source routing restrictions, tool schemas/policy/feedback, browser-asset/media shared lifecycle acknowledgement, and encoder arguments/limits. Existing media/audio/event, reply/routing, file-management, memory, UI and codec checks passed. No native ffmpeg encoding, browser launch, model/QQ call, deployment or restart was performed; live conversion/QQ display remain operator validation.

Chat-record management now offers scoped retained incoming-message lists, paged bodies and single-record TXT exports through the existing private/group entries. Private scope is the current administrator only; group reads require authorization and collection. No complete bot-reply transcript, QQ-history retrieval, media download or nested-body expansion is implied. Backend command/message-handler errors now also retain bounded diagnostic metadata without depending on LLM/tool events; tool-progress feedback remains LLM-signal-driven. Offline synthetic UI/export-access, existing file-management, content-codec, feedback and diagnostic checks passed; no real chat bodies, live sending or deployment were used.

Card destination extraction supports bounded nested/JSON-encoded delivered fields, including mini-app `meta.detail_1.qqdocurl`, with alternate-URL fallback, deduplication and explicit `NO_USABLE_LINK` when no safe destination is available. Preview URLs are not browsing destinations. Face tags still preserve only delivered IDs/names; no image URL is guessed. Offline content-codec integration checks cover capture/detail preservation and credential filtering. No real chat records, model/QQ calls or deployment were used to validate this change.

Private administrator Data management now exposes `/files` for scoped text/shared memory and `/media` for received attachment indexes/saved image bytes. Authorized groups link both from More settings. Text supports inline paging, full TXT export and confirmed deletion; media supports private image/audio/MP4 viewing and confirmed pointer/asset deletion. Source access/existence and administrator identity are checked again around uploads. No existing runtime records were inspected or deleted, and no QQ submission or deployment was performed.

Workspace/shared-memory file counts and saved-image count/aggregate-byte eviction are removed. Per-file bounds and existing seven-day media retention remain. Selected media now has bounded explicit workspace saving/encoding; multi-gigabyte ingestion is not supported. Local retention is not a guarantee of received QQ URL validity; official upload TTL applies to uploaded file references, not the event attachment URL field.

## Reply delivery update (source only)

- Foreground inference has no final-body/completion-message callback. Feedback completion stays in `ForegroundRequests`; `QQResponse` handles reply parts and operator commands only, without progress/final-model event compatibility.
- Chat output now uses `send_reply` exclusively. Special `intro` handling and final `reply`/`sendToGroup` output fields are removed; final JSON contains `pauseBrowsing` and nullable `sharedState`. Silence in batch/warmup tasks does not trigger saved-video compensation; dedicated authorized discovery publication remains.
- Group/routed text uses the shared Markdown transport rather than forcing plain text. Remote Markdown links/images remain unchanged for QQ clients to load, without backend downloading. Actual QQ rendering has not been validated.
- Inline local media references (`asset://ID`, `attachment://ID`, `attachment://audio/ID`, `/assets/ID`, `/attachments/ID`) split into ordered Markdown/media/Markdown messages through existing scoped media guards. No arbitrary host paths are accepted. Explicit media follows text separately. One part ID covers the full sequence; duplicate or partially failed calls never replay accepted submessages.
- Tool descriptions and the new reply guidance are English. The user deploys; no service restart or live send/model call was performed. Offline reply-part, routing, send-limit, event and codec checks cover this source change.

## Workspace and deployment

- Source: `/home/YUE___/llm-bot`.
- Deployment: `/home/YUE___/llm-bot/compose.yaml`; project/service: `llm-watch-video` / `bot`. Run `docker compose up -d --build bot` from this directory.
- Runtime volume: `llm-watch-video_runtime` → `/data`; business state: `/data/state`; isolated Codex home: `/data/codex`; Bilibili credentials: `/data/auth/bilibili.json`.
- Host models: `/home/YUE___/llm-bot/models` → `/models`, read-only.
- Deployment Compose is tracked with the source. Local `.env` and `models/` are ignored by Git and excluded from image build inputs. The configuration preserves the audio runtime, model mount, dual-stack network and existing named runtime volume.

The user deploys. Preserve runtime volumes, credentials, preferences and paused tasks; leave cloudcli/cloudflared alone. Keep existing non-root/read-only runtime and host Codex/Playwright/project mounts. Inspect current runtime metadata before making production claims.

## Explicit message waiting

`wait_reply(turn_id, timeout_seconds=30)` is implemented in source, with a maximum of 50 seconds per call and the existing whole-turn deadline unchanged. It returns newly supplied message events through the same intake/receipt path as `check_pending_events`. While waiting, any new collected group message is eligible without normal batch thresholds; authorization, stop, retry and reservation gates remain. It does not change sending/Markdown behavior or enable any feature. Deployment and live QQ validation remain with the user. Offline conversation-event checks cover timeout, arrival, existing pending input, IPC disconnect, stop and permission revocation. Send-limit, feedback-routing and MCP-codec checks and changed-file syntax checks passed. No deployment, model call or QQ send was performed.

## Asynchronous media update

`read_media` / `close_media` provide asynchronous received GIF/video reads through a shared, timestamped decoder. Pending queries publish current-turn progress/completion/error events and reuse their caches. Interrupt guards have no duration and permit event intake/replies while enabled. Turn closure awaits media cleanup; no media state crosses turns. QQ video now has an opt-in `read_media(track="audio",start,end)` speech branch sharing the media file/time axis/lifetime, with its own queue and the existing single ASR slot. Bilibili/website stream/audio integration is **ON HOLD**; validate QQ media before explicitly extending it. See README and architecture for contracts and budgets.

The user reports the visual asynchronous media flow is working. The newly added QQ-video speech side branch passed `scripts/check-media-audio.mjs` with synthetic PCM/ASR and temporary Unix sockets, including source/timeline reuse, independent queues, partial cache, permission checks, no-audio/configuration/busy/no-speech results and awaited slot/turn cleanup. Existing media/event/content-codec/message-image regressions, track schema/policy/composition and changed-file syntax checks also passed. Live video-speech validation remains for the user. This is user validation, not an agent-run live probe. Offline checks cover syntax, content-stream/codecs, MCP encoding, scoped message images, conversation events and media pending/cache/error/closure races. Media and conversation-event checks use real temporary Unix sockets; media process fixtures emit PNG/timestamp bytes without actual media decoding. No model/QQ call or service restart was performed for verification.


## Implemented

- One Run feedback switch per private/group source now controls both processing states and operation monitoring, always sent privately to administrators in operator-facing language. Reply-style settings, automatic final splitting, the 400-character local send guard, ordinary-message cooldown fields and injected cross-chat source banners are removed. Actual transport errors/authorization/idempotency still apply. Group recall skips unsupported detail blobs and continues reading separately retained originals.

- Unified recursive records: `{type:"record", components:[...]}` for captured messages, detail results and backend model-input assembly. Text/media/cards/mentions are components; nested records retain message relationships and record metadata. Cards stay structured, audio retains optional platform transcripts.

- Reusable typed `ContentStream` flows: explicit item codecs and lazy stream transforms. Acquisition, authorization, scheduling and delivery remain outside codecs. MCP encoding is centralized in `tools/register.mjs` and `mcp-codecs.mjs`.
- `get_message_detail(id, offset, limit)` reads one direct-child page; nested records require explicit subsequent reads. Cards expose delivered title links. `get_image_detail(image_ids)` reads received images. Old `get_detail` and `get_message_images` tools were removed.
- `get_audio_detail(id, method)` accepts an audio attachment ID and requires `qq` or `local`. `qq` returns already-delivered platform ASR without download; `local` uses scoped QQ download → SILK-WASM or ffmpeg PCM → Silero VAD → Qwen3-ASR-0.6B INT8 through sherpa-onnx. No automatic fallback or music understanding.
- Local audio: 8 MiB / 120 seconds, 100-second deadline, one job across MCP processes, repeated access/retention checks and bounded transcripts. Temporary audio and native processes are cleaned up after each call. Model weights remain installed for reuse. Bilibili/website stream and audio integration is ON HOLD.
- Diagnostic TXT starts with fixed, metadata-based guidance, configuration presence, current group stops and scope/task-correlated model/tool/send outcomes. Historical failures and raw events remain an appendix. Sending an error explanation does not mean transcription succeeded. Configuration presence does not prove model/runtime readiness.

## Local audio status

The user reports local speech recognition has been tested successfully. This is user validation, not an agent-run live probe. Models are already installed; no model download or live audio test is pending. The resumable `scripts/download-audio-models.sh` helper remains available for an explicitly requested installation.

Expected container paths, already defaulted in deployment Compose:

```text
WATCH_AUDIO_MODEL_DIR=/models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25
WATCH_AUDIO_VAD_MODEL=/models/silero_vad.onnx
```

Explicit environment values override these defaults. The Compose build enables `WATCH_AUDIO_RUNTIME=true`, installing pinned sherpa/SILK dependencies and ffmpeg; model weights are downloaded separately. See [audio decoder](docs/audio-decoder.md) for contracts and configuration.

After downloading, the user can deploy with:

```bash
docker compose -p llm-watch-video -f /home/YUE___/llm-bot/compose.yaml up -d --build bot
```

## Validation and remaining uncertainty

Syntax/import, tool-schema/policy, in-memory SQL and Compose configuration checks passed. Diagnostic-summary and administrator-UI checks passed with synthetic metadata/temporary state. No agent-run live ASR, SILK/ffmpeg decoding, model memory benchmark or deployment was performed. The user separately confirmed local recognition works; do not start live tests automatically.

Last known host resources: about 2 CPU threads / 3.8 GiB RAM; default container limit: 2 GiB. The user has confirmed working local recognition; detailed memory and speed measurements remain unverified. VAD bounds audio buffers, not model weights. Previous Unix-socket checks encountered `EPERM`; that historical restriction should be rechecked only if relevant.

Do not read real chat bodies, send messages, call models, launch browsers/login flows, clear records or restart services as routine verification. No maintenance action is pending. Scoped data, reply authorization, shared-memory privacy and stop/no-retry behavior must remain intact.

Keep changes committed; never commit credentials, model weights, dependencies or runtime records. Use the current Git history for review and rollback.
