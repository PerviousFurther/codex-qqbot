# Current handoff

Updated: 2026-10-28 UTC. Read [AGENTS.md](AGENTS.md) for constraints, [README.md](README.md) for supported behavior and [architecture](docs/architecture.md) for module contracts. Git records implementation history; this file records deployment ownership, locations and outstanding validation.

## Deployment ownership and locations

The user deploys and validates live QQ behavior. Source changes and offline checkpoints do not establish what the running container contains. Shared context and confirmed bot-reply archival have not been validated in live QQ. At the user's explicit request, the bot was stopped and its runtime storage migrated to the project directory. The container was recreated with the existing image and new bind mount, without building or starting it; its state is `created`. The user starts it when ready.

- Source and Compose: `/home/YUE___/llm-bot`, project/service `llm-watch-video` / `bot`.
- Runtime directory: `/home/YUE___/llm-bot/runtime` → `/data`; business state `/data/state`; isolated Codex home `/data/codex`; Bilibili credentials `/data/auth/bilibili.json`. This directory is excluded from Git and image build inputs. The old `llm-watch-video_runtime` volume was deleted as explicitly requested after migration verification; no duplicate is retained.
- Host models: `/home/YUE___/llm-bot/models` → `/models`, read-only.
- Compose preserves the non-root/read-only runtime, dual-stack egress network and read-only host Codex/Playwright/project mounts. `.env`, `models/` and `runtime/` are ignored and excluded from image build inputs. The runtime bind requires an existing directory writable by UID/GID `10001:10001`; Compose does not create it automatically. On a fresh installation, create it with `sudo install -d -m 700 -o 10001 -g 10001 runtime` before startup. Never recreate an existing runtime directory or change its contents during ordinary deployment.

Migration verification compared sorted archive digests of the stopped source and destination, covering bytes, ownership, modes and timestamps. UID 10001 directory access, the recreated container's `/data` bind, Compose configuration and Git exclusion were checked. No chat bodies or credentials were displayed, no settings/stops were changed, and no bot/model/browser action was started. Normal deployment below starts the stopped container.

Deploy from the source directory:

```bash
docker compose -p llm-watch-video up -d --build bot
```

Preserve credentials, permissions, preferences, schedules, models, volumes and stopped tasks. Do not enable switches or resume work during updates. Leave cloudcli/cloudflared alone. Inspect current metadata before making production claims; earlier transport probes are not evidence of current model readiness.

## Current source and live validation boundary

- Message processing now preserves complete credential-redacted text, card text, delivered mentions and attachment metadata without capture count/depth/text quotas. Private/group/event/shared inputs use folded record projections; private input no longer duplicates the raw body or rejects ordinary text beyond 6,000 characters. `get_message_detail` has independent complete-record JSON content pages (`content_offset`/`content_limit`) alongside existing child pages. Shared identities are filtered before content serialization. Group keyword indexes retain complete ordinary text and searches keep time/member/cursor scopes and bounded pages. Message/reply/image/member retention is seven days without count eviction; expiry indexes and conditional orphan cleanup avoid full index scans when no records expire. Existing stored truncated content remains readable but cannot be reconstructed. Source changes are not deployed.

  Offline checkpoints cover long-tail search, exact content-page reconstruction including Unicode, credential redaction/whitespace, long private input, more than the former attachment/mention/node/depth/count limits, shared-page identity removal, seven-day expiry and unchanged input receipts. Message/detail/image/group/event/context/operator-record, file/media, feedback, policy/schema and Codex-lifecycle checks use synthetic fixtures only. No real chat bodies, model/QQ/browser/media execution, deployment or service restart was used. The user validates live QQ behavior after deployment.

- Removed the cumulative public-page resource caps (80 requests/32 MiB) at the user's request. Request/byte counters remain metadata; repeated observations no longer fail solely because those totals are exceeded. Per-resource acquisition bounds, operation timeouts, authorization and turn cleanup remain. The viewport stays 1280x800 CSS pixels. Offline synthetic routing checkpoints cover more than 80 requests and 32 MiB followed by a successful snapshot; no browser is launched for this validation. The separately authorized Chromium fixture has been updated but not executed. These source changes are not deployed.

- Public browser snapshots now include bounded DOM element references. `get_webpage_dom` adds CSS queries and sanitized HTML excerpts; `click_webpage` accepts current element IDs; `edit_webpage_dom` can remove/hide overlays and explicitly unlock scrolling. References are backend-held, bounded and invalidated by observations/navigation/detachment; no arbitrary code/HTML injection is exposed. Fixed the browser route handler's early synchronous domain rejection so click navigation/subresources reach the approval gate. Syntax/import, offline web-session (including synthetic DOM/handles), web-access, web-approval/status and actual route-handler fixtures, feedback-routing, Codex-lifecycle and admin-UI checks pass; no real Chromium/QQ interaction, deployment or restart was performed. Live popup dismissal, element clicks and dynamic-page compatibility remain for user validation.

- Webpage domain approval now waits inside pre-transport acquisition, including initial open, redirect hops and click/form-generated requests. Approval continues the held unsent request after live rechecks; no tool replay is used. Each operation has up to 60 seconds of aggregate extra approval waiting alongside existing active-work budgets. Token-bound status polling rechecks source authorization and stops. Offline approval/status IPC, fake-browser open/click waits, one-shot POST redirect continuation, denial/cancellation/revocation and aggregate wait-budget checkpoints passed, together with web-session, web-access, feedback-routing, Codex-lifecycle and admin-UI checks. Source changes are not deployed; real Chromium and live administrator approval, click/form continuation and cancellation remain for user validation.

- Removed the optional passive-reply quota advisory, its group setting/button, command handlers and diagnostic field. Reaching the local passive count no longer notifies administrators; existing passive-to-proactive continuation is unchanged. Actual send failures and explicit QQ rate-limit rejections still notify administrators through the existing delivery failure paths, independently of Run feedback. Old stored advisory fields are inert and require no runtime migration. Offline group-behavior, feedback-routing, reply-parts, send-limits, admin-UI and diagnostic-summary checkpoints, changed-module syntax/import and whitespace checks passed. No live sending, runtime mutation or deployment was performed.
- Shared evidence includes recursive messages, images, audio/video/file attachments and confirmed bot replies. Authorized groups require collection and no stop; each private chat opts in through `/context-sharing` (default off). Threads remain separate, with evidence queried on demand. Existing detail/media/save tools use `context_chat` and `turn_id`; `ContextAccess` owns scope resolution and live reauthorization. Cached media retains its original sharing guard. Explicit saves create independent current-workspace copies, which sharing revocation cannot retract.
- Substantive replies tagged for history are archived only after QQ acceptance, including actual image/audio bytes. Seven-day retention has no incoming/outgoing count limits. Complete credential-redacted reply text is archived; delivery is unchanged. Pre-send epochs and final maintenance/collection checks prevent late writes after cleanup. Menus, feedback/errors, login material and failed/uncertain sends are excluded. Old unrecorded replies cannot be reconstructed; archive failure never retries an accepted send.
- Models may choose any offered recipient alias without another user request. Private input access does not gate outgoing aliases; recipient stops and source/target authorization remain. The fixed private menu contains Help, Administrator settings and Stop tasks; startup removes owned legacy video shortcuts while preserving custom entries and the original backup.
- Chat output uses `send_reply` only. Final JSON may complete a silent turn and sends no fallback or reply-preparation hint. Actual tool feedback follows `CodexAdapter → RequestUpdates → AdminNotifications → QQDelivery`; live QQ rendering and provider event availability still need user validation.
- The public browser reuses one turn-owned process/page, supports open/scroll/screenshot/close/click/type/press/back and awaits cleanup. Navigation, frames and bounded submissions use checked acquisition. Cookies are ephemeral and Bilibili authentication is separate. Intermediate redirect cookies and redirected-resource cookies are not reconstructed; complete login or verification compatibility is unvalidated. Earlier explicitly authorized offline Chromium fixtures passed in a disposable non-root/read-only container with networking disabled and stubbed acquisition. No browser is authorized as a routine cleanup check.
- Unknown project webpage hosts may request private administrator review. `WebAccessRequests` alone writes the exact-host overlay in `web-access.json`; requests expire after ten minutes, deduplicate globally, cap at three hosts per turn and suppress denied repeats for one hour. Grants survive restart/scoped cleanup but do not bypass adult/address/source checks. Unsent webpage requests wait for approval at the acquisition gate, then recheck live authorization and continue. Clicks/submissions are never replayed and stopped tasks are never resumed. Live review delivery/buttons remain for QQ validation.
- Codex native live search is independent of the project acquisition domain list. Do not restore `tools.web_search.allowed_domains` or add another provider. Native search results do not grant subsequent project downloads. Feedback exposes only sanitized actual public URLs; missing completion/URL events do not establish successful browsing or a specific provider failure. Investigate bounded model/tool/send metadata separately, without automatic live reproduction.
- Default whole-turn deadlines are disabled; RPC/tool/media/wait limits and cancellation remain. Receipts track supplied input rather than replies. `wait_reply` defaults to 30 seconds, at most 50; waiting group input bypasses batch thresholds while retaining authorization and reservation checks.
- Unified file tools preserve old flat text files and saved image assets without bulk migration. Selected workspace copies have no automatic expiry. Project reads require the current explicit verified-administrator foreground request. Shared notes and mood/public-topic state remain separate from chat evidence and cannot contain private transcripts or identities.

## Local audio

The user reports local speech recognition and the visual asynchronous media flow work. Model weights are already installed; no download or live recognition test is pending. Detailed native resource measurements and the newer QQ-video speech branch still need user validation. Website/Bilibili stream/audio integration is **ON HOLD** pending that validation and an explicit request.

Compose enables `WATCH_AUDIO_RUNTIME=true` and defaults to:

```text
WATCH_AUDIO_MODEL_DIR=/models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25
WATCH_AUDIO_VAD_MODEL=/models/silero_vad.onnx
```

Explicit environment values override these defaults. Native runtime dependencies/ffmpeg are installed during image build; weights are separate. `scripts/download-audio-models.sh` is only for explicitly requested installation. See [audio decoder](docs/audio-decoder.md) for budgets and configuration. Last reported host resources were about two CPU threads/3.8 GiB RAM; the default container limit is 2 GiB. These are historical observations, not a current capacity measurement.

## Domain snapshot maintenance

Runtime uses committed `lib/web-domains/v2fly.json` and its MIT notice, plus the curated base and administrator exact-host overlay. The pinned upstream revision is recorded in Git and generated snapshot metadata. The selected snapshot contains forum/social grants and adult exclusions; domain filtering and model guidance do not classify every page on mixed-content sites.

Initialize the pinned source after cloning:

```bash
git submodule update --init --depth 1 vendor/v2fly-domain-list-community
```

Only for an explicitly requested database update:

```bash
git submodule update --remote --checkout --depth 1 vendor/v2fly-domain-list-community
node scripts/update-web-domains.mjs
node scripts/update-web-domains.mjs --check
node scripts/check-web-domains.mjs
node scripts/check-web-access.mjs
git diff --submodule=log
```

Review and commit the pointer, snapshot and license together. The compiler requires clean official-origin inputs, resolves includes/filters/affiliations, excludes unsupported or overly broad grants and preserves adult denials. Invalid input fails before atomic publication. Updating the submodule alone does not change runtime access. No runtime upstream updater is supported.

## Latest cleanup and verification

Run feedback distinguishes shared notes and Markdown notes, text, images, GIFs, audio, video and files without extensions using file-tool arguments. Unknown types display only an ASCII alphanumeric extension of at most 16 characters; other suffixes receive a generic unknown label. `file-feedback.mjs` reuses the file codec classification and projects bounded metadata, never filenames, paths or bodies. `CodexAdapter` retains that classification through completion/interruption; `RequestUpdates` chooses Chinese labels. Classification and suffixes stay out of diagnostics. Existing feedback switches and administrator delivery remain unchanged. Offline feedback-routing and Codex-lifecycle checkpoints cover labels, omitted completion arguments and non-disclosure; live QQ validation remains with the user.

Removed an unused audio import and module-internal exports. Message/image/media/file owners now use `ContextAccess` directly instead of maintaining duplicate current-chat fallback branches. Standalone owners retain current-chat reads and reject shared aliases without an authorization channel. Historical file readers, stored formats, legacy-menu removal and durable regression checkpoints remain supported. This handoff replaces accumulated change logs and stale deployment labels; Git retains those details.

Changed-module syntax/import and whitespace checks passed, along with `check-files`, `check-chat-context`, `check-message-detail-images`, `check-content-codecs`, `check-media-stream` and `check-media-audio`. The file checkpoint also verifies that a shared alias without an authorization channel is rejected before acquisition. Tests used disposable state and fake transports/decoders only; no live QQ/model/browser/media action, runtime data cleanup or deployment was performed.

Never query real chat bodies, call models, connect bots, launch browsers/login flows, download/play media, send messages, clear runtime records or restart services as routine verification. `scripts/check-runtime.mjs` is an online deployment probe, not an offline check. No maintenance action is pending.
