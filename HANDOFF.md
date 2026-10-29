# Current handoff

Updated: 2026-10-29 UTC. Read [AGENTS.md](AGENTS.md) for constraints, [README.md](README.md) for supported behavior and [architecture](docs/architecture.md) for module contracts. Git records implementation history; this file records deployment ownership, locations and outstanding validation.

## Deployment ownership and locations

The user deploys and validates live QQ behavior. The official Tencent QQBot SDK and its connection/API implementation have been removed at the user's request. SnowLuma source integration is implemented with offline fixtures. The user has deployed the application. During the 2026-10-29 startup investigation it was restart-looping with SNOWLUMA_CONNECTION_ERROR: the running gateway still listened on loopback although saved configuration used 0.0.0.0. With user authorization, the gateway was recreated using the existing Compose file and preserved volumes. After the operator completed QQ login, both OneBot listeners were verified on 0.0.0.0 (3000/3001). The application reported connected, its maintenance socket existed, and an authenticated get_status from the application container returned HTTP 200 / retcode 0 / online=true / good=true. The application started at 2026-10-29 09:19:38 UTC; its 25 prior restart attempts belong to the failed connection/login period. Both containers reported no OOM. No model call or test send was performed during this investigation; live QQ command/reply validation remains with the operator.

The two stopped official-bot containers (`llm-watch-video-bot-1`, `llm-watch-video-service-bot-1`) and their dedicated tagged images were deleted as authorized on 2026-10-29. Docker's reported total image size fell from 12.09 GB to 9.644 GB. No volume, bind directory, credentials, model, preferences, permission, schedule, stop or runtime record was deleted. The older container's now-unused data volume remains preserved. SnowLuma, cloudcli and cloudflared remained running; no service was restarted.

- Source and retained application Compose: `/home/YUE___/llm-bot`, project/service `llm-watch-video` / `bot`. Compose/Dockerfile remain for the reusable application core, with the new SnowLuma adapter; the official adapter remains removed.
- Runtime directory: `/home/YUE___/llm-bot/runtime` → `/data`; business state `/data/state`; isolated Codex home `/data/codex`; former credentials remain untouched. Runtime is excluded from Git and build inputs.
- Host models: `/home/YUE___/llm-bot/models` → `/models`, read-only. Existing Codex/Playwright/project mounts and Debian 13 non-root/read-only application settings remain intact. Do not rebuild duplicate shared dependencies or change cloudcli/cloudflared.
- `.env` is preserved. Official `QQBOT_*` credentials/settings have no reader in the application startup; the example no longer advertises them. `WATCH_ADMIN_OPENIDS` and retained `admin.json` no longer supply administrator authorization. SnowLuma requires account-qualified identities and explicit SNOWLUMA_ADMIN_QQS binding, never automatic reuse of saved OpenID grants.

The user previously migrated runtime storage to the project bind and deleted the original `llm-watch-video_runtime` volume after digest/ownership verification. Do not recreate or clear existing storage during transport migration.

## SnowLuma application migration and deployment

The running gateway restart policy was changed to `unless-stopped` without restarting it. The memory watcher is prepared, not installed or enabled. The operator supplied one personal QQ administrator; the setup helper saved that explicit binding in ignored `.env`, along with existing gateway tokens. Both saved gateway configurations now bind OneBot to the private network, report array messages, suppress self reports and disable `#sl`. The files were verified without printing credentials. The gateway was subsequently recreated and the operator completed QQ login. Both private-network listeners and application connection are now verified. Last metadata-only sample was approximately 898 MiB / 1,536 MiB with no OOM/restart. GPU/software rasterizer/compositing disable flags were present. These observations do not prove long-term memory stability.

From the source directory, use Node 24.22.1 or a newer SDK-supported runtime. Initial binding is already saved. To change or add administrators later, supply the full desired comma-separated list of **personal QQ accounts**, not the logged-in bot account:

```bash
node scripts/configure-snowluma.mjs --admin YOUR_PERSONAL_QQ
```

This operator-only helper reads the single existing account configuration inside the gateway, preserves its HTTP/WS tokens, writes private-network array-format listeners, disables self reporting and the built-in `#sl` responder, and updates ignored `.env` without printing tokens. It rejects missing/ambiguous listeners/accounts. Writes are atomic per file, not a distributed transaction; after any failure rerun the helper before deployment. It never reads chats, connects the bot, starts a model or restarts a service. Existing unrelated `.env` values remain intact. New-channel group/private defaults do not inherit legacy identity grants. Keep retained volumes and runtime state.

Apply the gateway configuration, then deploy the app:

```bash
docker compose up -d --force-recreate snowluma
docker compose up -d --build bot
```

The app joins `llm-snowluma-trial_default`; OneBot ports are not published on the host. Existing read-only/non-root app security and shared mounts remain. Login persistence is retained, but an upstream restart may require operator verification/login again. Send `/help` from the bound administrator account; authorize each new group and its collection/participation switches explicitly. Test private/group text, faces, cards, images/files and nested delivered records manually. Unknown forwarded bodies are still explicit unread references, not automatically fetched. Do not enable old groups or background settings as part of migration.

After the app is configured/running, activate the host memory watcher:

```bash
sudo install -m 0644 deploy/snowluma-memory.service /etc/systemd/system/snowluma-memory.service
sudo systemctl daemon-reload
sudo systemctl enable --now snowluma-memory.service
```

The unit uses this checkout and the existing host Node path. It samples only Docker memory metadata. At >=85% for five minutes, it asks the app to drain and waits up to ten minutes. Existing work may finish; new background starts pause. Incoming traffic cancels an unsealed attempt. Only an acknowledged idle seal permits a gateway restart. Failed/busy attempts wait one hour; no forced task cancellation. A renewable two-minute socket lease releases admission if the watcher fails. The socket is 0600 and contains no message bodies or credentials. The application has no Docker socket or host restart permission. Stop automatic high-memory recovery with `sudo systemctl disable --now snowluma-memory.service`; Docker crash recovery remains separate. Do not intentionally trigger a live memory restart for automated testing.

## One-time transition to unified Compose

Source now defines both services in `compose.yaml`; deployment remains operator-owned. Existing gateway mounts were verified by read-only Docker inspection. The three volumes (`llm-snowluma-trial_gateway-data`, `llm-snowluma-trial_qq-config`, `llm-snowluma-trial_qq-data`) and network (`llm-snowluma-trial_default`) are explicit external resources, so Compose cannot silently replace them or delete them with its project. Preserve these names even though they contain the former project name. The gateway container becomes `llm-watch-video-snowluma-1`; setup and optional memory-watcher scripts use that name. The watcher remains disabled unless explicitly enabled by the operator.

Run once from the project directory. Stop and remove only the old gateway container, without `-v`; this releases the existing host ports and QQ volumes before the new service starts:

```bash
docker compose stop bot
docker stop llm-snowluma-trial-snowluma-1
docker rm llm-snowluma-trial-snowluma-1
docker compose up -d snowluma
```

Open noVNC and complete login if required. To retrieve the current desktop password locally, use `docker compose exec snowluma x11vnc -showrfbauth /root/.vnc/passwd`; do not paste it into chat. Then start/update the application:

```bash
docker compose up -d --build bot
docker compose ps
```

Subsequent full startup uses `docker compose up -d --build`; app-only updates use `docker compose up -d --build bot`. No `depends_on` is added: app-only operations must not implicitly start/recreate QQ, and gateway container startup does not establish completed QQ login. Both services share the existing private network and the `snowluma` DNS alias. Do not run the old gateway alongside the new service or remove the external network/volumes. Fresh installations must explicitly provision the named external resources; this configuration prioritizes preserving the existing deployment.

## SnowLuma gateway deployment

The root `compose.yaml` owns both `bot` and `snowluma`. The gateway retains its independent security/resource settings, loopback desktop/WebUI ports and dedicated existing QQ volumes; it does not mount project/runtime/model directories or inherit application credentials. The former separate trial Compose file is removed. Complete the one-time ownership transition below before using unified startup commands.

The upstream multi-platform image manifest is pinned to `sha256:29536cd34e9c9c3f8a942be4e5cd6a17d366acd9b2096aa56b5863d024a80d23` (resolved 2026-10-29). Its amd64 compressed layers total approximately 702 MiB; installed size is larger and has not been measured. Configuration follows [upstream Docker deployment](https://snowluma.github.io/zh/docs/guide/deploy/docker) and framework source commit `3f388b17f8baf47b4c2c9606b8a3121eb8599fef`. This upstream image uses Bookworm and a root bootstrap/supervisor, with QQ and SnowLuma running as UID 1000. Its writable filesystem, SYS_PTRACE and unconfined seccomp belong only to this isolated third-party trial. The existing Debian 13 non-root/read-only application is unchanged. Do not apply these settings to the application bot. No Docker socket, host PID namespace or host process injection is configured.

The trial has a 1,536-MiB memory limit, 1-GiB shared-memory capacity (usage counts toward container memory), `unless-stopped` container restart, bounded logs, independent Compose-scoped persistent volumes and no published OneBot ports. At preparation the host had about 2.9 GiB available RAM, no swap and 25 GiB free disk. This is a trial budget, not a verified QQ memory requirement; peak usage and long-term compatibility remain untested. The user subsequently deployed this trial and reports successful QQ login and process injection. Metadata-only inspection found no OOM or restart; the observed idle container usage was approximately 865 MiB after login.

From `/home/YUE___/llm-bot`, start only the gateway after the one-time transition:

```bash
docker compose up -d snowluma
```

On the operator's own computer, open an SSH tunnel using the normal server address:

```bash
ssh -N -L 16081:127.0.0.1:16081 -L 15099:127.0.0.1:15099 YUE___@SERVER_ADDRESS
```

The operator opens `http://127.0.0.1:16081/` locally for noVNC. Retrieve initial passwords locally on the server (do not paste passwords, QR codes or full logs into chat):

```bash
docker compose logs --no-color snowluma | rg 'remote desktop password:|远程桌面密码:|initial credentials|临时密码'
```

Use the remote-desktop password to view the QQ window, scan its QR code with the intended phone QQ account, and complete any verification in QQ yourself. This logs in a regular QQ account; the official bot AppID/secret cannot be used. Then open `http://127.0.0.1:15099/` for SnowLuma WebUI, using the initial credentials shown in the local log. Upstream documents automatic hook loading after login. The application uses the authenticated direct WebSocket and HTTP listeners configured above; no reverse reports, extra plugins or model integrations are needed. Login persistence uses the three dedicated volumes; never run `down -v` for an ordinary stop.

Metadata-only checks after startup:

```bash
docker compose ps
docker stats --no-stream
docker inspect --format '{{.State.Status}} OOMKilled={{.State.OOMKilled}} Restarts={{.RestartCount}}' llm-watch-video-snowluma-1
```

Stop the trial while retaining login state:

```bash
docker compose stop snowluma
```

Compose configuration and static isolation/resource checks passed. Login and injection were performed/confirmed by the user. Application integration is deployed with an explicit new-channel administrator binding and authenticated private OneBot access. No real chat inspection or test message send was performed during startup validation. The upstream `#sl` responder is disabled in both saved gateway configurations; its live behavior remains operator-validated.

## Raw face inspection status

The user deployed the temporary one-shot SDK hook, completed the authorized pre-normalization event inspection, then reported successful restoration with the normal Compose command. The ignored hook, hashed target configuration, override and synthetic scratch checks have been removed. Permanent synthetic delivered-format card/face checkpoints remain in `scripts/check-content-codecs.mjs`. No real raw event or credential is committed. Subsequent read-only container inspection confirmed the normal `node scripts/start.mjs` command; no earlier raw snapshot was read again. No temporary capture or cleanup action remains pending in source.

## Nested-forward inspection status

The user deployed both temporary capture versions and supplied the authorized test events. Full raw-event and generic interior inspection found a flattened textual preview and a picture descriptor, without msg_elements or a JSON-encoded child-message container. These observations concern the supplied samples only; they do not establish whether another platform transport can fetch additional bodies. No raw record was committed and no missing hierarchy was reconstructed. The user restored the normal Compose command; subsequent read-only container inspection confirmed `node scripts/start.mjs`. All task-owned ignored capture/config/override/analyzer/check files have been removed. No temporary capture or cleanup remains pending.

## Named operator commands

The operator deployed the named-command redesign with a successful Compose build/up result; live QQ behavior remains operator-validated. Current source removes `/action` and keeps function/operation names. SnowLuma group arguments render as actual QQ group IDs (`/group view 123456789`, `/group remark 123456789 New remark`). Known group IDs are resolved through current-account stored metadata without granting authorization or querying chats.

Opaque file/media/record targets use stable `#N` object references in their original commands, such as `/files current view #1` and `/files current delete #1`. One object retains its number across operations and restarts, scoped to the requesting conversation and source list. `command-references.json` persists only ordinary opaque pointers and the allocation counter; confirmation tokens remain transient and one-time. The old `command-sequence.json` is unused and remains untouched on disk. Free-form command values are not interpreted as object references.

Deploy with `docker compose up -d --build bot`, then reopen `/groups`, `/files` or `/memory` to obtain the named commands. Validate a group lookup, a remark edit and a file view in QQ. The previous `/action` commands are no longer accepted. No runtime data was read or deleted, and no service restart or live send was performed during implementation.

## Remaining channel cleanup

At the operator's request, old-channel compatibility entry points were removed: first-message administrator claiming, persisted `admin.json` authorization fallback, and `WATCH_ADMIN_OPENIDS` reading/forwarding. Only explicit current administrator IDs reach the application and isolated MCP processes. Existing files and environment values remain untouched on disk.

Stop-task menus and diagnostic group summaries now filter to the active channel. Cross-conversation directories filter unsupported channel scopes before authorization, preventing a retained old group from aborting the whole listing. Diagnostics no longer present obsolete official-platform receive-mode/cache fields. General content/file storage readers and credential redaction remain in use and were not removed.

Deploy with `docker compose up -d --build bot` together with the group-directory changes. No runtime cleanup, live API call, model execution or service restart was performed for this change.

## Group-directory update

The operator reported successful deployment of the command-menu update, then found that `/groups` still showed retained local identifiers. The source now refreshes group IDs/names through the authenticated SnowLuma SDK when a private administrator opens `/groups`, filters the menu to the current account's channel and displays numeric group IDs alongside names/remarks. Existing grants/stops and old records remain unchanged; newly discovered groups remain disabled. Refresh failures show cached data with an explicit notice, and reconnect invalidates stale responses.

Deploy this update with `docker compose up -d --build bot`, then send `/groups` in the administrator private chat. Gateway recreation is unnecessary. Offline fixtures cover directory discovery, legacy filtering, preserved settings, departure tombstones, failed refresh and reconnect; no live directory query or service restart was performed during development.

## Command-menu update

The operator reported a successful application build/recreation after the full capability audit. This confirms deployment execution, not live message behavior. A subsequent source update changes SnowLuma menu rendering to copyable commands on separate lines, marks editable actions, and replaces obsolete button/click instructions throughout operator pages. Existing command values, authorization, confirmation tokens, pagination and return routes are preserved. The numbered selection layer is described above; commands are never executed automatically.

This command-menu update requires a new application build with `docker compose up -d --build bot`; it does not require gateway recreation. Validate `/help`, `/settings`, a model page, an editable preference and a return command in the administrator's QQ private chat after deployment. No live send or service restart was performed for this update.

## Full capability migration audit

The 2026-10-29 follow-up audit covered all existing capability owners: private/group intake and authorization, command menus, reply routing and archival, message/card/nested-reference codecs, image/audio/video and workspace files, shared context/notes, webpage access approvals and turn lifecycle, model orchestration, feedback and diagnostics. These capabilities already use the shared core behind SnowLuma; there is no separate legacy transport implementation left to migrate.

The audit fixed two integration omissions: channel intake now rechecks its connection generation after drain, decoding and group-observation awaits before continuing dispatch; HTTP send rejections now preserve their numeric status through delivery diagnostics. Synthetic channel fixtures cover reconnect during intake, 21 administrator command pages, attachment-only image/audio/video/file events and denial of group-owner management privileges. Existing legacy grants and stopped settings remain unchanged.

All 25 non-browser/offline checkpoints passed. The browser-launch checkpoint and online runtime probe were not run. No real chat, gateway connection, model call, send, restart or deployment was performed for this audit. The source changes still require the operator's application deployment (`docker compose up -d --build bot`) and client validation. The gateway configuration is unchanged and does not require recreation for these changes.

Server-local attachments, browser-stream ASR and universal share-card video resolution remain explicit capability boundaries. Explicit SnowLuma forward acquisition is now implemented as described below; it still requires live validation. The optional host memory watcher remains uninstalled/disabled unless the operator enables it using the commands above.

## Current source and live validation boundary

SnowLuma now uses the pinned upstream SDK for authenticated events, text/media delivery and streamed files. Existing scoped records, authorization, model, browser and media owners are retained. Sixteen affected offline checkpoints passed: content codecs, detail/images, sends, group/channel behavior and drain/socket/configuration, routing, feedback, administrator UI, conversation events, cross-chat context, chat-record UI, file management, MCP codecs/policy, Codex lifecycle, reply parts, diagnostic summary and content streams. Fixtures use disposable state, fake SDK transports and synthetic message bodies; actual detail-tool image bytes and private/group model projections are checked. All 166 JavaScript modules passed syntax/relative-import checks; package/lock agreement, both Compose configurations, the systemd unit and whitespace checks passed. No live SnowLuma event connection, model execution, send or forced restart was performed for the migration. Server-local attachment paths are not fetched; forward acquisition is explicit and described below.

A prior user-requested metadata probe called only `get_status` and `get_version_info` inside the existing container: unauthenticated status returned HTTP 401; authenticated calls returned HTTP 200 / retcode 0, online=true, good=true, SnowLuma 2.2.1-node / protocol v11. That verifies API access and reported account health, not actual message delivery. Tokens and account identities were not printed. The setup helper has now saved the operator-approved binding and gateway configuration; the subsequent gateway recreation applied the saved startup configuration, and listener binding was verified after QQ login. Status-responder behavior remains operator-validated.

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


## Context reminders and explicit forwarded-message reads

Source now includes a short relevance-based memory/context/search reminder at the start of reply-capable turns and before `send_reply`. Simple social replies do not require a tool call; there is no merged thread, automatic history injection or broader sharing grant.

The operator authorized reading the reported group context. Targeted read-only inspection of its recent retained records and corresponding tool events found an opaque forward reference without a stored body; the model attempted `get_message_detail` and received `MESSAGE_NOT_RETAINED`. No broader chat search or live SDK/model/browser call was performed. The previous adapter discarded the native acquisition key.

New events retain private forward keys alongside their source records. Explicit `get_message_detail` reads can now acquire a selected body through SDK `get_forward_msg`, using the existing turn-bound context bridge and source/target checks. Parent pages never fetch descendants. Returned nodes/media pointers use the existing codecs, original retention deadline and single-transaction graph publication; no new discussion input is created. Old references without keys cannot be recovered locally. The operator should resend a forwarded record after deployment, ask the bot to inspect its interior, and check a deeper forward and image. No stored records were rewritten.

Deploy the application with `docker compose up -d --build bot`. This change does not require gateway recreation. All 25 non-browser offline checkpoints passed, including explicit forward acquisition through fake SDK responses, real local IPC, actual synthetic image bytes, nested references, shared access revocation, turn closure and source-retention checks. All 167 modules passed syntax/relative-import checks. The browser-launch checkpoint and online runtime probe were not run; real QQ forward-body delivery still requires operator validation.

## Changing the logged-in QQ account

The operator performs login and service changes. Stop the application with `docker compose stop bot`, then use the existing noVNC page to sign out and log into the intended QQ account. Configure that account’s authenticated HTTP/WS listeners in SnowLuma WebUI on the private Compose network. Synchronize `.env` values `SNOWLUMA_ACCOUNT_ID`, `SNOWLUMA_HTTP_URL`, `SNOWLUMA_WS_URL`, `SNOWLUMA_HTTP_TOKEN` and `SNOWLUMA_WS_TOKEN` with the selected account. `SNOWLUMA_ADMIN_QQS` lists the separate personal QQ accounts allowed to administer it. Do not print tokens or paste login QR images into chat. Apply listener changes through the gateway’s supported controls; if saved startup settings require recreation, use `docker compose up -d --force-recreate snowluma` and complete login again if requested. Finally run `docker compose up -d --build bot`, then use administrator `/help` and `/groups` to discover and explicitly authorize the new account’s groups.

Retain all volumes/runtime data. Account-qualified identities isolate prior grants, records and scoped preferences; changing account does not migrate them. Global persona/public notes and other global settings remain shared application state. `configure-snowluma.mjs` currently requires exactly one account configuration; do not run it blindly after adding another saved account. Merely changing administrators requires updating `SNOWLUMA_ADMIN_QQS` and recreating the application, without changing the gateway login.


## Outgoing QQ interactions

Source adds interaction-only `send_reply` calls for a current-chat incoming message’s sender (poke) or message (emoji reaction/removal). No new switch or remote-history reader is added. The user deploys with `docker compose up -d --build bot`; gateway recreation is unnecessary. Validate one private/group poke and a supported reaction/removal in QQ. No real poke, reaction, historical-message query, model call or service restart was performed during implementation. Thirteen affected offline checkpoints passed, along with syntax/relative-import validation for all 168 modules. Fixtures exercise SDK action encoding, controller/IPC/private/group delivery, duplicate/conflict handling, collection/retention revocation and rate-limit/uncertain-failure behavior. SDK historical-message methods exist but are not wired into automatic collection or model tools.

## QQ history search update

Source adds explicit `search_qq_history` for current/authorized shared conversations: SDK page enumeration, local keyword/time filtering, bounded excerpts and turn-local continuation. No new feature switch or automatic history backfill is added. Existing permissions, collection, sharing, stops and stored records are unchanged. Seven-day access bounds remain. SDK availability, history coverage and real QQ paging still need operator validation; no real history was queried during implementation.

Deploy only the application with `docker compose up -d --build bot`. Gateway recreation is unnecessary. In an authorized chat, ask for a known recent keyword with a time range; validate matching excerpts and continuation/partial-coverage reporting. Offline checks use synthetic SDK responses and local turn IPC, including inclusive anchors, time filters, private/group routing, revocation, disconnect, cancellation and no persistence.

## Five-minute event waits and private-send timing

The operator completed the application build/recreation for the history-search update; that output establishes container startup, not live history-query correctness. Current source raises `wait_reply` to 300 seconds while preserving the 30-second default. Wait-specific IPC has 15 seconds of overhead (minimum 65 seconds), and the MCP server timeout is 330 seconds; send, browser, audio and acquisition owners retain their existing deadlines. Cancellation reaches the waiting socket, and new messages still wake it immediately. Offline fixtures cover schema/backend bounds, 315-second IPC configuration, early arrival, cancellation and both fresh/resumed thread configuration; no five-minute live wait or model call was performed. Deploy with `docker compose up -d --build bot`.

A metadata-only inspection of retained private-send diagnostics on 2026-10-29 found one recent multipart send: the first part reached the application acceptance checkpoint in 289 ms; the media part took approximately 38 ms to upload and 3,334 ms from MEDIA_SEND to acceptance. The complete send_reply tool took 3,685 ms. These are application checkpoints, including local acceptance processing, not recipient-client display measurements or proof of the cause of every reported delay. Source contains no fixed private-send delay; no speculative delivery change was made. No real message bodies were queried, no test message was sent and no service was restarted.

## Shared-video card investigation

The operator authorized inspection of the reported group’s video cards. Targeted read-only inspection found a retained Bilibili mini-app card with a correctly extracted public short-link destination. The corresponding model turn successfully called `get_message_detail`, then sent a reply without invoking webpage or player tools. No observed browser/player failure establishes that this video is inaccessible; the model stopped at metadata. No real chat content, identities or share URLs are copied into source documentation or fixtures.

The `get_message_detail` description now explicitly routes video-share destinations through `open_webpage` → `list_webpage_media` → `read_webpage_media`, distinguishing webpage links from received media attachments and uninspected content from confirmed access failures. No new video resolver, automatic playback, site-specific API or runtime record rewrite is added. Deploy with `docker compose up -d --build bot` and explicitly ask the bot to inspect a newly shared video. Live page/player availability remains unverified; no browser, playback, download or send was performed during this investigation.

## Named QQ reaction lookup

The operator clarified that the model did not know what numeric reaction IDs mean. Source now exposes `search_qq_faces` using the pinned SDK’s system-face name search and ID lookup, then guides `send_reply` to reuse the chosen ID. Tool results expose names/aliases only, not image URLs or arbitrary upstream fields. Accepted sends echo the selected action/ID/add-remove state. SDK method contracts were verified locally; live catalog availability and per-face reaction support remain operator-validated. No hard-coded name mapping, live catalog query or test interaction was used.

Deploy with `docker compose up -d --build bot`. Validate a named reaction lookup and selected response in QQ. Synthetic checkpoints cover name/ID lookup, unknown names, field filtering, disconnect, source revocation, turn tokens and accepted-interaction results.

## Unified incoming interactions and private failure reporting

Source now admits private/group pokes and group reaction add/remove notices through ordinary capture and turn intake. Pokes to the bot reuse mention triggering; collection/participation/stops remain authoritative. Notice records can identify an authenticated sender for a return poke, but cannot masquerade as native message IDs for reactions. The upstream OneBot notice converter was inspected at SnowLuma revision `8ffd314260e9e2b6967eeca494d87aa5be046c34`; actual delivery from the deployed gateway still requires operator validation. Private reaction notices are not claimed: the inspected converter exposes group reactions only. No live event bodies, model, gateway call or interaction send was used for validation.

Failures continue through the administrator-only private notification boundary. Regression fixtures cover group/private failure recipients; model-facing sending guidance additionally prohibits operational-error notices and failed-interaction apologies to ordinary users/groups. No settings, stopped tasks, credentials or runtime data were changed. Deploy only the application with `docker compose up -d --build bot`; then validate a private poke, an authorized group poke and group reaction removal, including an existing waiting turn. Gateway recreation is unnecessary.

Validation: eight affected offline checkpoints passed (content-codecs, conversation-events, feedback-routing, group-behavior, send-limits, message-detail-images, mcp-codecs and chat-context), plus syntax checks for all 12 changed JavaScript modules and `git diff --check`. Fixtures cover retained notice provenance, model/shared projections, body-free reaction targets, return-poke resolution, wait/receipt intake, collection/private-access gates and administrator-only error delivery. Live QQ behavior remains unverified.

## Observation and learning guidance

The base instructions preserve independent preferences, disagreement, refusal and silence without prescribing verbal attacks, talking back or teasing. Shared expression guidance encourages active curiosity, relevant information gathering and revision based on evidence and corrections. This is a prompt-only change; subjective conversational effects require operator evaluation. Syntax/import checks passed for the composed instructions; no model calls or runtime changes were made. Deploy through the application-only command above.
