#!/bin/sh
set -eu
umask 077
if [ ! -r /opt/host-openai/codex/bin/codex.js ]; then
  echo 'HOST_CODEX_PACKAGE_MISSING: check WATCH_HOST_OPENAI_DIR' >&2
  exit 1
fi
node --input-type=module -e '
import { accessSync, constants } from "node:fs";
import { chromium } from "playwright";
try { accessSync(chromium.executablePath(), constants.R_OK | constants.X_OK); }
catch { console.error("HOST_BROWSER_PACKAGE_MISSING: check WATCH_HOST_BROWSERS_DIR and the Playwright browser revision"); process.exit(1); }
'
mkdir -p /data/state /data/auth /data/codex
exec "$@"
