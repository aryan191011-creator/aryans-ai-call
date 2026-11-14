#!/usr/bin/env bash
# Is the preview actually answering? Exit 0 = healthy, 1 = needs a start.
#
# Probes /healthz rather than the port, because a process can bind a socket and
# still be wedged — an accepted connection that never answers is the failure
# mode that looks alive to `ss` and feels dead to the browser.
set -u
PORT="${PORT:-8787}"
URL="http://localhost:${PORT}/healthz"

if body=$(curl -fsS -m 3 "$URL" 2>/dev/null); then
  echo "preview: healthy on :${PORT} — ${body}"
  exit 0
fi

echo "preview: nothing answering on :${PORT}" >&2
exit 1
