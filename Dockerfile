FROM node:24-trixie-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/data \
    CODEX_HOME=/data/codex \
    WATCH_CODEX_HOME=/data/codex \
    WATCH_DATA_DIR=/data/state \
    WATCH_BILIBILI_STATE=/data/auth/bilibili.json

WORKDIR /app
COPY package.json package-lock.json ./
COPY audio-runtime/package.json ./audio-runtime/
ARG WATCH_AUDIO_RUNTIME=false
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && node node_modules/playwright/cli.js install-deps chromium \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/* /root/.npm \
    && mkdir -p /opt/host-openai /ms-playwright \
    && ln -s /opt/host-openai/codex/bin/codex.js /usr/local/bin/codex

# Opt in at build time; no model downloads or change to existing runtime settings.
RUN if [ "$WATCH_AUDIO_RUNTIME" = "true" ]; then \
      npm install --prefix audio-runtime --omit=dev --no-audit --no-fund \
      && rm -rf /var/lib/apt/lists/* /root/.npm; \
    fi

RUN groupadd --gid 10001 watchvideo \
    && useradd --uid 10001 --gid watchvideo --home-dir /data --no-create-home --shell /usr/sbin/nologin watchvideo \
    && mkdir -p /data/state /data/codex /data/auth \
    && chown -R watchvideo:watchvideo /data
COPY lib ./lib
COPY scripts ./scripts
COPY deploy/container-entrypoint.sh /usr/local/bin/watch-video-entrypoint
RUN chmod 0555 /usr/local/bin/watch-video-entrypoint \
    && chmod -R go-w /app

USER 10001:10001
ENTRYPOINT ["/usr/local/bin/watch-video-entrypoint"]
CMD ["node", "scripts/start.mjs"]
