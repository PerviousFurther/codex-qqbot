# Current handoff

Updated: 2026-10-28 UTC. Read [AGENTS.md](AGENTS.md) for constraints, [README.md](README.md) for behavior and [architecture](docs/architecture.md) for module ownership.

## Shared conversation evidence and reply history (source only)

Shared context now includes recursive messages, images, audio/video/file attachments and confirmed bot replies, alongside the existing private opt-in switch (default off). `read_chat_context` returns graph/media references and bot direction/role. Existing message/image/audio/media/save tools accept `context_chat` and `turn_id`; the backend privately resolves the alias and rechecks source/target sharing, stops, collection, maintenance, retention and epochs around acquisition and cached output. Source scopes/administrator bindings do not become model output. Media sessions keep their original grant checks when addressed later only by `media_id`, under the existing aggregate per-turn budgets. Explicit attachment saves create independent current-workspace copies; they cannot open another workspace or project files. Sharing off prevents subsequent reads, but cannot retract already-supplied evidence or explicit copies. Separate model threads and role mood/public-focus state remain unchanged.

Substantive foreground/routed/group submissions tagged for history are recorded only after QQ acceptance, using the existing `MessageRecords` SQLite owner and a `reply_media` BLOB table for actual bot image/audio bytes. Seven-day retention applies, with separate incoming/outgoing bounds of 5,000 each per group/512 each per private chat. Text archives retain up to 12,000 characters with explicit truncation without changing sent text. Outgoing history does not displace incoming records. Capturing uses a pre-send cancellation epoch and rechecks maintenance/collection before the transaction, preventing late writes after scoped cleanup. Menus, diagnostics, progress/errors, login material, failed/uncertain sends and unrecorded pre-deployment bot replies are not archived or reconstructed. Archive failures notify independently and preserve transport acceptance without retry. Scoped record clearing removes reply BLOBs as well.

Offline fixtures passed for shared structured records, attachment-only messages, explicit file copies, delivered audio-reference reads, archived bot image pixels, cached GIF revocation, source/target policy and sharing revisions, accepted/rejected sends, independent archive failure, separate reply/original retention, late-write rejection, unchanged receipts and excluded background capabilities. Relevant message/media/audio/file/reply/routing/UI/feedback/adapter/codec/event/group/diagnostic checkpoints, affected imports, startup syntax and whitespace checks also passed. No runtime chats, live QQ/model/browser/media requests, deployment or restart are used. The user deploys with the existing commands below and validates QQ behavior.

## Outgoing private routing and fixed-menu cleanup (source only)

The private-input switch no longer hides known private recipients or blocks delivery to them. Source turns still recheck incoming access; outgoing delivery shares cancellation/maintenance/group checks without consulting that switch. Configured administrators remain offered without an ordinary contact record, while explicit recipient stops, current membership, epochs, source authorization and platform delivery limits still apply. The model chooses whether to send to an offered target without another user request or approval. Tool guidance now makes this explicit.

Removed the legacy video/watch-history shortcuts from the fixed private QQ menu; Help, Administrator settings and Stop tasks remain. Startup synchronization removes those owned legacy names while preserving unrelated custom entries and the original backup. Message keyboards and video commands remain supported. Offline routing and administrator UI checkpoints cover closed-input outgoing delivery, administrator availability, source rejection and legacy-menu removal. No live QQ calls, inference, menu writes or service restart were performed. The user deploys and validates the QQ client menu.

## Reply feedback correction (source only)

Removed the reply-preparation hint triggered by the model's final structured output. Final JSON may complete a silent turn, so it does not establish that a chat message is being prepared or sent. Actual `send_reply` tool feedback and processing completion remain. No fallback chat output was added. Offline feedback-routing, Codex-lifecycle and reply-routing checkpoints cover final-output silence and authorized cross-conversation delivery. Passive container source inspection confirmed the current deployment includes browser interactions and recipient routing; no live messages, model calls, chat-body inspection or restart were performed for this correction. The user deploys.

## Administrator webpage-domain approvals (source only)

Unknown webpage document/resource domains can now request private bot-administrator review. `WebAccessRequests` owns a separate `state/web-access.json` overlay (exact-host grants plus pending/denied metadata); the compiled v2fly/base snapshot remains unchanged. Only verified current administrators in private `/web-access` commands may allow/deny/revoke, with an entry in Browsing settings. Approval is global for already-authorized conversations and includes no descendant hosts. Approved hosts survive restart/scoped/offline chat cleanup. Both service and MCP startup configure the same state path, and subsequent acquisitions reload the overlay without restart. Adult denials, URL/public-address/DNS pinning and source access checks remain authoritative.

Requests are token-bound to live foreground or reply-capable discussion turns, capped at three distinct hosts per turn and deduplicated per host across turns. Pending requests expire in ten minutes; rejection suppresses requests for an hour. Stored metadata and private notices contain hostnames, never full URLs, source bodies or identities. The main service alone writes bounded state atomically; models can request but cannot grant access. Markdown and keyboards use the existing administrator notification/delivery path with source/cancellation/identity rechecks. Failed notifications do not retry or fall back; pending reviews remain in `/web-access`. Approval never retries a failed read/click/submission or resumes a stopped task. Native search and file downloads do not initiate approvals; all project acquisition can consume approved grants. `read_webpage` now requires current `turn_id`.

Offline approval checks use disposable state, local Unix IPC and fake administrator delivery: private/current-admin command gates, exact-only grants, independent-process reads, revoke/restart persistence, expiry/dedup/deny suppression, queue/write-failure preservation, token/cap/cancellation and text-before-keyboard identity rechecks passed. Existing web-access/domain/session, administrator-UI, feedback-routing, Codex-lifecycle, conversation-event, file and MCP-codec checkpoints passed. The explicitly authorized no-network disposable Chromium fixture also passed with actual blocked-resource callback/host propagation checks. No live QQ approval, website/model/login request, deployment or service restart was performed. The user deploys using the existing instructions below and validates approval delivery/buttons in QQ.

## Single-page browser interactions (source only)

Public single-page browsing now includes `click_webpage`, `type_webpage`, `press_webpage` and `back_webpage`. Tools use fixed Playwright mouse/keyboard/history APIs and return actual screenshots through the existing turn-owned image lifecycle. Existing source/turn/access checks, explicit close and acknowledged turn cleanup remain. Clicks, input handlers and Enter can cause external changes; submissions are not retried and cancellation does not undo accepted effects. No production settings, switches or Bilibili credentials are changed.

The checked downloader now has a backend-only browser request mode supporting GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS with 64 KiB request bodies, browser response status/headers and ephemeral response cookies. Ordinary webpage/file acquisition keeps its GET-only behavior. Frames and later navigations use the same allowlist/DNS-pinned public-address checks; cross-origin redirects strip Cookie/Authorization. POST-to-GET redirects are handled without resubmitting the original form, and final document bytes are served at the validated final URL via a replaced history entry. Intermediate redirect cookies and redirected resource cookies are not reconstructed; this is not complete login-flow compatibility. Extra tabs, workers, socket transports, media decoding, arbitrary code and inherited Bilibili authentication remain unavailable. The v2fly/curated snapshot is unchanged; administrator-approved exact hosts form the separate overlay described above.

Offline Chromium checks passed in a disposable non-root/read-only container with networking disabled and no production data mounts: click/type/key/back, embedded frames, ephemeral cookies, single-submit POST/303 and cross-domain document navigation, plus existing scroll/crop/cancellation/resource-limit and denied-domain checks. Web-access checkpoints cover browser request bounds, redirect method changes and cross-origin credential stripping. Changed-module syntax/import, offline web-access, web-session, MCP-codec, feedback-routing, Codex-lifecycle and file checks passed. No real website, verification challenge, login, model, QQ, deployment or restart was used. Deployment remains with the user using the existing instructions below; live interaction and login compatibility remain unvalidated.

## Single-page public browser (source only)

`open_webpage`, `scroll_webpage`, `screenshot_webpage` and `close_webpage` replace `render_webpage`. One turn-owned public browser process/page is reused without reloading on repeated opens of the same address. Opening a different address replaces the page context while retaining the process; omitted URLs reuse the current page or create a blank page initially. Scrolling uses absolute vertical offsets; screenshots cover the current 1280x800 viewport or an explicitly bounded viewport-relative crop. Explicit close releases page/process memory and allows reopening. Turn closure aborts work and acknowledges cleanup only after pending launch/page operations and process shutdown settle. Public browser contexts remain separate from Bilibili credentials; interaction tools are described above.

The existing checked downloader/deny proxy and per-resource limits remain. Resource load/byte budgets accumulate across observations of a page and reset when its context is replaced. Tool policy, Chinese feedback labels and URL-event sanitization use the new names. Snapshot text remains a bounded document prefix, not viewport/crop text. Temporary screenshots still use `TurnImages` and explicit `save_file` persistence. Temporary experiments were removed from `/tmp`; durable checkpoints remain in `scripts/check-*.mjs`, as documented in AGENTS.

Changed-module syntax/import, offline web-session, web-access, MCP-codec, feedback-routing, Codex-lifecycle, media-stream and file checks passed. An explicitly authorized, disposable non-root/read-only container with networking disabled and no production data mounts ran the Chromium fixture against stubbed DNS/HTTPS: persistent-page scrolling/crop pixel comparisons, blank pages, cancellation cleanup, cumulative resource budgets, redirects and blocked destinations passed. The host lacks Chromium system libraries, so no host dependency/browser installation was made. No real website, model, QQ, login, deployment or service restart was used. The user deploys using the existing workspace/deployment instructions below; real QQ tool use remains unvalidated.

## Next maintainer: search and webpage access

The last user-reported deployed search change is `d8d5bc8` (native search separation), following `88c1a0f` (web feedback URLs) and `08a71b1` (v2fly integration). The user reported a successful Compose rebuild and container recreate/start after the separation change. This establishes deployment-command success only; live native search, provider event URLs and QQ delivery still need user validation. Earlier source-only/not-deployed labels below describe the verification boundary when those changes were written, not a fresh assessment of the running container.

Keep these boundaries explicit:

- Codex owns native keyword search/open/find through `web_search="live"`. Do not reintroduce the project domain list into `tools.web_search.allowed_domains` or add another search provider.
- Project `read_webpage`, rendering, redirects, subresources and public downloads use `web-access-policy.mjs` and the compiled v2fly/curated allowlist. A native search result does not grant project acquisition access; a subsequent page read can legitimately be denied.
- Adult-site model guidance remains applicable to native search. Backend adult-domain denials protect project acquisition and suppress known adult URLs in administrator feedback; they do not constitute a native-search backend filter or a universal page-content classifier.
- Administrator feedback reports actual tool events and sanitized URLs only. Missing search-completion events or URLs are not evidence of a successful visit, nor enough to identify a provider failure.

For a future search complaint, first inspect bounded diagnostic stages/statuses and distinguish native search, project webpage acquisition and `send_reply` failures. Do not infer the cause from a generic interrupted-tool notice. No provider rejection of the former domain configuration was captured; its role in the earlier incident remains unproven. Do not automatically call a model or reproduce against QQ. Ask the user to validate a new normal turn after deployment; preserve stops, permissions and feedback preferences.

Relevant offline checks (no live search or QQ delivery):

```bash
node scripts/check-web-access.mjs
node scripts/check-web-domains.mjs
node scripts/check-feedback-routing.mjs
node scripts/check-codex-lifecycle.mjs
```

## Native search and webpage allowlist separation

The user clarified that v2fly grants apply only to project webpage acquisition. `CodexAdapter` retains native live search and no longer injects `tools.web_search.allowed_domains` at process/thread startup. Project reads, rendering, redirects, subresources and public downloads still enforce the full compiled allowlist and adult denials. Adult-site model guidance remains. URL feedback accepts sanitized public search URLs outside the acquisition list without fetching them; known adult destinations remain hidden and URLs stay out of diagnostics.

Changed-module syntax/import and offline web-access, domain-compiler, feedback-routing and Codex-lifecycle checks passed for `d8d5bc8`. Passive diagnostics showed a native search start without a matching completion and a separate `send_reply` failure (`ATTACHMENT_NOT_RETAINED`); they do not establish the native search failure cause. No model request, browser launch, live search test or restart was performed by the agent during investigation or validation.

## Web feedback URLs

URL feedback is included in the latest user-reported rebuild. Application readiness and live QQ behavior were not independently probed.

Native search/open/find events and webpage read/render MCP events now supply actual URLs to administrator-only Run feedback through `CodexAdapter → RequestUpdates → AdminNotifications → QQDelivery`. `web-feedback.mjs` bounds output to three deduplicated public-web HTTP(S) URLs independent of the acquisition allowlist, strips query strings/fragments and rejects credentials, unusual ports, adult/local destinations and oversized/credential-like values. Completion/interruption retains start URLs. Search events without displayable URLs explicitly report their absence; no result/visit is inferred. Other arguments, bodies, queries and commentary remain excluded. URLs are not written to diagnostics. Existing source switches, stop/cancellation checks, administrator rechecks and delivery-failure behavior remain intact.

Offline feedback-routing and Codex-lifecycle fixtures passed, covering event extraction, URL sanitization, private administrator delivery and URL-free diagnostic metadata. Changed-module syntax/import checks passed. No model/QQ call, browser launch or service restart was performed for this change; actual provider event URL availability remains for live QQ validation.

## Runtime connectivity and turn lifecycle

Deployment Compose pins `name: llm-watch-video` and gives the bot a dual-stack `egress` bridge (`fd73:83c1:9b4b::/64`, Docker-managed IPv4/NAT). Current read-only inspection confirms `llm-watch-video-bot-1` is running with that network. The isolated Codex home has ChatGPT login mode, no API key, no `config.toml`, and no configured HTTP/HTTPS/ALL proxy variables. Model inference therefore uses the container's Codex ChatGPT-authenticated provider path directly; MCP webpage/media downloads are separate. No live Codex process was present when socket ownership was inspected, so no actual inference connection family was observed.

Explicit unauthenticated connectivity probes after the user's restart: host and container IPv4 HTTPS to QQ succeeded; IPv4 TCP connections to `chatgpt.com` and `api.openai.com` timed out. Unforced container HTTPS HEAD probes selected IPv6 for both OpenAI domains (HTTP 403/421). This proves transport only, not authenticated model readiness or a forced IPv6 policy. The host connection-tracking table held 40/65,536 entries when checked; current measurements do not establish the pre-restart cause. No proxy/network configuration changes, model requests or QQ submissions were made. Existing stops and data are preserved; cloudcli/cloudflared remain untouched.

Source removes the default whole-turn deadline, rejects same-scope overlapping adapter runs before preparation, and immediately routes sanitized Codex error categories through diagnostics and administrator notifications independently of Run feedback. Retriable errors leave the turn active; terminal notifications end it. Fixed stderr signatures are classified from a bounded buffer without retaining raw output. Per-request/tool/media/wait deadlines and cancellation remain. Offline lifecycle and feedback checks use synthetic sessions/processes and fake delivery only.

## Public domain database (integrated in source, not deployed)

The pinned `vendor/v2fly-domain-list-community` checkout remains at `1b81d3cd34096e5d8cac6bca5935e80f30e990f0`. Runtime uses the committed `lib/web-domains/v2fly.json` snapshot and bundled MIT notice, not the raw vendor directory. Selected inputs are global/Iranian/Russian forums and Chinese/international/Iranian social-media categories, plus the preserved curated base. The current build has 843 suffix grants; known adult exclusions use upstream `category-porn` and local OnlyFans/Fansly overrides. Adult deny rules run before grants; the model is told not to access adult sites or pornographic pages, including on mixed-content platforms. This is domain/category filtering plus model guidance, not a classifier for every webpage.

Initialize the pinned checkout after cloning:

```bash
git submodule update --init --depth 1 vendor/v2fly-domain-list-community
```

An explicit database update and offline compilation uses:

```bash
git submodule update --remote --checkout --depth 1 vendor/v2fly-domain-list-community
node scripts/update-web-domains.mjs
node scripts/update-web-domains.mjs --check
node scripts/check-web-domains.mjs
node scripts/check-web-access.mjs
git diff --submodule=log
```

Review and commit the upstream pointer and generated snapshot before the user deploys. The compiler requires a clean official-origin checkout and matching bundled license, records source revision/digest/categories, resolves includes/filters/affiliations, omits top-level/exact/keyword/regex grants and advertising-tagged entries, and removes parent grants overlapping known adult hosts. It retains adult suffix/exact/keyword/regex denial. Invalid inputs fail before atomic snapshot publication. Updating the submodule without compilation does not change access; no runtime timer/downloader or model-editable exception is added. Existing domain/address/redirect/media guards and task settings are preserved. Snapshot reproducibility, syntax/import, documentation-link and non-root readability checks passed. Offline domain-compiler/access, MCP-codec, file, reply-part and feedback checks passed with synthetic data/stubbed transports. The renderer check refused to start without an explicit browser flag; no browser was launched or renderer functional check performed. No deployment/model/QQ call was used for validation.

## Prompt consolidation (not deployed)

Base/conversation/turn prompts and the MCP introduction no longer repeat the tool catalog, parameter tutorials, media budgets or send protocol. Individual tool descriptions own those details; `reply-guidance.mjs` supplies protocol text to `send_reply`, while turn input carries only scoped data and session metadata. Reply guidance first observes the conversation and necessary evidence, then chooses whether to speak, without a fixed delay, mandatory tool call or automatic acknowledgement. Group/video task wording follows that approach. Persona freedom to accept/decline, disagree, express preferences, push back verbally within stated boundaries or remain silent is retained in `BOT_INSTRUCTIONS`. Backend permissions, intake triggers, sending, media limits and persisted settings are unchanged. Changed-module syntax/import checks and offline content/MCP-codec, administrator-UI, conversation-event, group-behavior, reply-part, send-limit, feedback-routing and shared-memory checks passed. No model/QQ call, browser launch or deployment was performed. The user deploys; real response frequency remains for QQ validation.

## Persona quota (not deployed)

Custom persona quota is 5,000 tokens using the existing pinned offline tokenizer. Verified administrator private `/persona custom` commands use this quota instead of the ordinary 6,000-character chat-input cap; ordinary chat and administrator claiming retain their existing limits. Overflow preserves the previous persona, the settings preview remains 600 characters, and full text is injected on the next turn. README documents prompt owners and deployment/next-turn behavior. Existing saved personas, permissions and active tasks are unchanged. Changed-module syntax/import and offline administrator-UI/group checks passed, including exact 5,000-token acceptance, 5,001-token rejection with prior-state preservation, long-command admission, full prompt injection and unchanged ordinary-chat limits. No deployment, model call or QQ submission was performed.

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
