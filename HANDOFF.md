# Current handoff

Updated: 2026-10-29 UTC. Read [AGENTS.md](AGENTS.md) for constraints, [README.md](README.md) for supported behavior and [architecture](docs/architecture.md) for module contracts. Git records implementation history; this file records deployment ownership, locations and outstanding validation.

## Deployment ownership and locations

The user deploys and validates live QQ behavior. The official Tencent QQBot SDK and its connection/API implementation have been removed at the user's request. `scripts/start.mjs` now exits with `CHAT_CHANNEL_NOT_CONFIGURED` before touching runtime state; there is no application chat transport until SnowLuma integration is implemented. Do not run the application deployment command during this intermediate state.

The two stopped official-bot containers (`llm-watch-video-bot-1`, `llm-watch-video-service-bot-1`) and their dedicated tagged images were deleted as authorized on 2026-10-29. Docker's reported total image size fell from 12.09 GB to 9.644 GB. No volume, bind directory, credentials, model, preferences, permission, schedule, stop or runtime record was deleted. The older container's now-unused data volume remains preserved. SnowLuma, cloudcli and cloudflared remained running; no service was restarted.

- Source and retained application Compose: `/home/YUE___/llm-bot`, project/service `llm-watch-video` / `bot`. Compose/Dockerfile remain for the reusable application core, not a working official adapter.
- Runtime directory: `/home/YUE___/llm-bot/runtime` → `/data`; business state `/data/state`; isolated Codex home `/data/codex`; former credentials remain untouched. Runtime is excluded from Git and build inputs.
- Host models: `/home/YUE___/llm-bot/models` → `/models`, read-only. Existing Codex/Playwright/project mounts and Debian 13 non-root/read-only application settings remain intact. Do not rebuild duplicate shared dependencies or change cloudcli/cloudflared.
- `.env` is preserved. Official `QQBOT_*` credentials/settings have no reader in the application startup; the example no longer advertises them. Retained `WATCH_ADMIN_OPENIDS` still supports historical-record authorization. A future ordinary-account channel requires a separate identity namespace and explicit administrator binding, never automatic reuse of saved OpenID grants.

The user previously migrated runtime storage to the project bind and deleted the original `llm-watch-video_runtime` volume after digest/ownership verification. Do not recreate or clear existing storage during transport migration.

## SnowLuma standalone login trial

Prepared `deploy/snowluma.compose.yaml` for a separate single-account trial. It does not connect to the application, inherit its credentials, mount project/runtime/model directories, or enable OneBot integrations. Application integration is pending; retained permissions and records remain unchanged. The user deploys and performs login; no image was pulled and no QQ process was started during preparation.

The upstream multi-platform image manifest is pinned to `sha256:29536cd34e9c9c3f8a942be4e5cd6a17d366acd9b2096aa56b5863d024a80d23` (resolved 2026-10-29). Its amd64 compressed layers total approximately 702 MiB; installed size is larger and has not been measured. Configuration follows [upstream Docker deployment](https://snowluma.github.io/zh/docs/guide/deploy/docker) and framework source commit `3f388b17f8baf47b4c2c9606b8a3121eb8599fef`. This upstream image uses Bookworm and a root bootstrap/supervisor, with QQ and SnowLuma running as UID 1000. Its writable filesystem, SYS_PTRACE and unconfined seccomp belong only to this isolated third-party trial. The existing Debian 13 non-root/read-only application is unchanged. Do not apply these settings to the application bot. No Docker socket, host PID namespace or host process injection is configured.

The trial has a 1,536-MiB memory limit, 1-GiB shared-memory capacity (usage counts toward container memory), no automatic container restart, bounded logs, independent Compose-scoped persistent volumes and no published OneBot ports. At preparation the host had about 2.9 GiB available RAM, no swap and 25 GiB free disk. This is a trial budget, not a verified QQ memory requirement; peak usage and long-term compatibility remain untested. The user subsequently deployed this trial and reports successful QQ login and process injection. Metadata-only inspection found no OOM or restart; the observed idle container usage was approximately 865 MiB after login.

From `/home/YUE___/llm-bot`, start only the trial:

```bash
docker compose -f deploy/snowluma.compose.yaml up -d
```

On the operator's own computer, open an SSH tunnel using the normal server address:

```bash
ssh -N -L 16081:127.0.0.1:16081 -L 15099:127.0.0.1:15099 YUE___@SERVER_ADDRESS
```

The operator opens `http://127.0.0.1:16081/` locally for noVNC. Retrieve initial passwords locally on the server (do not paste passwords, QR codes or full logs into chat):

```bash
docker compose -f deploy/snowluma.compose.yaml logs --no-color snowluma | rg 'remote desktop password:|远程桌面密码:|initial credentials|临时密码'
```

Use the remote-desktop password to view the QQ window, scan its QR code with the intended phone QQ account, and complete any verification in QQ yourself. This logs in a regular QQ account; the official bot AppID/secret cannot be used. Then open `http://127.0.0.1:15099/` for SnowLuma WebUI, using the initial credentials shown in the local log. Upstream documents automatic hook loading after login. Do not configure HTTP reports, reverse WebSocket targets, plugins or model integrations during the login/resource trial. Login persistence uses the three dedicated volumes; never run `down -v` for an ordinary stop.

Metadata-only checks after startup:

```bash
docker compose -f deploy/snowluma.compose.yaml ps
docker stats --no-stream
docker inspect --format '{{.State.Status}} OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}}' llm-snowluma-trial-snowluma-1
```

Stop the trial while retaining login state:

```bash
docker compose -f deploy/snowluma.compose.yaml stop
```

Compose configuration and static isolation/resource checks passed. Login and injection were performed/confirmed by the user; application integration has not been implemented. No real chat inspection or message send was performed for the removal. Next configure authenticated private OneBot access and bind a new-channel administrator explicitly before connecting application events. The user reports the upstream `#sl` status command replies across conversations; disable that upstream responder separately before relying on application authorization.

## Raw face inspection status

The user deployed the temporary one-shot SDK hook, completed the authorized pre-normalization event inspection, then reported successful restoration with the normal Compose command. The ignored hook, hashed target configuration, override and synthetic scratch checks have been removed. Permanent synthetic delivered-format card/face checkpoints remain in `scripts/check-content-codecs.mjs`. No real raw event or credential is committed. Subsequent read-only container inspection confirmed the normal `node scripts/start.mjs` command; no earlier raw snapshot was read again. No temporary capture or cleanup action remains pending in source.

## Nested-forward inspection status

The user deployed both temporary capture versions and supplied the authorized test events. Full raw-event and generic interior inspection found a flattened textual preview and a picture descriptor, without msg_elements or a JSON-encoded child-message container. These observations concern the supplied samples only; they do not establish whether another platform transport can fetch additional bodies. No raw record was committed and no missing hierarchy was reconstructed. The user restored the normal Compose command; subsequent read-only container inspection confirmed `node scripts/start.mjs`. All task-owned ignored capture/config/override/analyzer/check files have been removed. No temporary capture or cleanup remains pending.

## Current source and live validation boundary

The official SDK/channel, menu/keyboard wire encoding, group metadata/reception queries, media/file API calls, SDK logger interception and official passive quotas are removed. Shared delivery/response owners are now `ChatDelivery`/`ChatResponse` with an injected transport contract; pure metadata errors, existing scoped records/codecs, authorization, model, browser and media capabilities remain. Old-format card/face fixtures now start at normalized delivered input, not an installed official SDK. SDK-only diagnostic-upload checks were removed; content/detail/pixel/model-boundary and simulated commit-revocation checks remain in their existing owners. No SnowLuma event connection or model execution was performed. A subsequent user-requested read-only command-line probe called only `get_status` and `get_version_info` inside the existing container: unauthenticated status returned HTTP 401; authenticated calls returned HTTP 200 / retcode 0. The runtime reported online=true, good=true, SnowLuma 2.2.1-node and protocol v11. This verifies authenticated API access and reported account health, not actual new-message delivery or card/forward completeness. Tokens and account identities were not printed; no chat bodies, sends, configuration mutations, service restart or model connection occurred. Account HTTP/WS endpoints remain loopback-only with tokens; the account statusCommand remains enabled with swallow=false. Git records earlier implementation and completed sample investigations. Fifteen affected offline checkpoints passed: content codecs, group behavior, send limits, administrator UI, file management, feedback routing, cross-chat context, reply parts, chat-record UI, message detail/images, MCP codecs/policy, diagnostic summary, reply routing, conversation events and Codex lifecycle. All 157 JavaScript modules passed syntax/relative-import checks; package/lock agreement, both Compose configurations and whitespace checks passed. Synthetic prototypes used ignored `temp/` and were removed.

Retained core capabilities still awaiting live validation after a new channel is integrated: general webpage/media/DOM tools, per-conversation cookies and exact-host approval waits; cross-conversation evidence and accepted-reply archival; descriptor-only picture acquisition and complete nested-reference detail reads. Source changes and offline fixtures do not establish QQ delivery, browser compatibility or provider behavior. Native live search stays independent of the project acquisition domain list. Do not resume saved groups or tasks during migration.

## Local audio

The user reports local speech recognition and the visual asynchronous media flow work. Model weights are already installed; no download or live recognition test is pending. Detailed native resource measurements and the newer QQ-video speech branch still need user validation. The user has requested general website integration. Browser HTML video/audio reading and checked public-file decoding are implemented in source; authenticated/segmented browser stream capture for ASR is not supported. Live compatibility and native-resource validation remain with the user.

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
