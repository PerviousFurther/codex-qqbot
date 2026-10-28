# Current handoff

Updated: 2026-10-28 UTC. Read [AGENTS.md](AGENTS.md) for constraints, [README.md](README.md) for supported behavior and [architecture](docs/architecture.md) for module contracts. Git records implementation history; this file records deployment ownership, locations and outstanding validation.

## Deployment ownership and locations

The user deploys and validates live QQ behavior. Source changes and offline checkpoints do not establish what the running container contains. The last user-reported rebuild covered native search separation; later passive inspection found browser interactions and recipient routing in the deployed source. Shared context and confirmed bot-reply archival have not been validated in live QQ. No deployment or restart was performed during the latest cleanup.

- Source and Compose: `/home/YUE___/llm-bot`, project/service `llm-watch-video` / `bot`.
- Runtime volume: `llm-watch-video_runtime` → `/data`; business state `/data/state`; isolated Codex home `/data/codex`; Bilibili credentials `/data/auth/bilibili.json`.
- Host models: `/home/YUE___/llm-bot/models` → `/models`, read-only.
- Compose preserves the non-root/read-only runtime, dual-stack egress network, named runtime volume and read-only host Codex/Playwright/project mounts. `.env` and `models/` are ignored and excluded from image build inputs.

Deploy from the source directory:

```bash
docker compose -p llm-watch-video up -d --build bot
```

Preserve credentials, permissions, preferences, schedules, models, volumes and stopped tasks. Do not enable switches or resume work during updates. Leave cloudcli/cloudflared alone. Inspect current metadata before making production claims; earlier transport probes are not evidence of current model readiness.

## Current source and live validation boundary

- Shared evidence includes recursive messages, images, audio/video/file attachments and confirmed bot replies. Authorized groups require collection and no stop; each private chat opts in through `/context-sharing` (default off). Threads remain separate, with evidence queried on demand. Existing detail/media/save tools use `context_chat` and `turn_id`; `ContextAccess` owns scope resolution and live reauthorization. Cached media retains its original sharing guard. Explicit saves create independent current-workspace copies, which sharing revocation cannot retract.
- Substantive replies tagged for history are archived only after QQ acceptance, including actual image/audio bytes. Seven-day retention has separate incoming/outgoing limits of 5,000 each per group and 512 each per private chat. Reply text is archived up to 12,000 characters with explicit truncation; delivery is unchanged. Pre-send epochs and final maintenance/collection checks prevent late writes after cleanup. Menus, feedback/errors, login material and failed/uncertain sends are excluded. Old unrecorded replies cannot be reconstructed; archive failure never retries an accepted send.
- Models may choose any offered recipient alias without another user request. Private input access does not gate outgoing aliases; recipient stops and source/target authorization remain. The fixed private menu contains Help, Administrator settings and Stop tasks; startup removes owned legacy video shortcuts while preserving custom entries and the original backup.
- Chat output uses `send_reply` only. Final JSON may complete a silent turn and sends no fallback or reply-preparation hint. Actual tool feedback follows `CodexAdapter → RequestUpdates → AdminNotifications → QQDelivery`; live QQ rendering and provider event availability still need user validation.
- The public browser reuses one turn-owned process/page, supports open/scroll/screenshot/close/click/type/press/back and awaits cleanup. Navigation, frames and bounded submissions use checked acquisition. Cookies are ephemeral and Bilibili authentication is separate. Intermediate redirect cookies and redirected-resource cookies are not reconstructed; complete login or verification compatibility is unvalidated. Earlier explicitly authorized offline Chromium fixtures passed in a disposable non-root/read-only container with networking disabled and stubbed acquisition. No browser is authorized as a routine cleanup check.
- Unknown project webpage hosts may request private administrator review. `WebAccessRequests` alone writes the exact-host overlay in `web-access.json`; requests expire after ten minutes, deduplicate globally, cap at three hosts per turn and suppress denied repeats for one hour. Grants survive restart/scoped cleanup but do not bypass adult/address/source checks. Approval does not retry reads/submissions or resume tasks. Live review delivery/buttons remain for QQ validation.
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

Removed an unused audio import and module-internal exports. Message/image/media/file owners now use `ContextAccess` directly instead of maintaining duplicate current-chat fallback branches. Standalone owners retain current-chat reads and reject shared aliases without an authorization channel. Historical file readers, stored formats, legacy-menu removal and durable regression checkpoints remain supported. This handoff replaces accumulated change logs and stale deployment labels; Git retains those details.

Changed-module syntax/import and whitespace checks passed, along with `check-files`, `check-chat-context`, `check-message-detail-images`, `check-content-codecs`, `check-media-stream` and `check-media-audio`. The file checkpoint also verifies that a shared alias without an authorization channel is rejected before acquisition. Tests used disposable state and fake transports/decoders only; no live QQ/model/browser/media action, runtime data cleanup or deployment was performed.

Never query real chat bodies, call models, connect bots, launch browsers/login flows, download/play media, send messages, clear runtime records or restart services as routine verification. `scripts/check-runtime.mjs` is an online deployment probe, not an offline check. No maintenance action is pending.
