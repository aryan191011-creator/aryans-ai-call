#!/usr/bin/env bash
# Supervised dev server for the preview.
#
# Why: an unsupervised `node server.mjs` is fine until the day a frame arrives
# that throws, the process exits, and the preview stays dark for an hour because
# nothing was watching. The loop costs one line and turns "dead preview" into a
# one-second blip you never notice.
set -u
cd "$(dirname "$0")/.."
PORT="${PORT:-8787}"
tries=0

while true; do
  started=$(date +%s)
  PORT="$PORT" node server.mjs
  code=$?
  ran=$(( $(date +%s) - started ))

  # Crash-loop guard: if it dies again within 3s we are not fixing anything by
  # hammering the port — a bind conflict or a syntax error needs a human.
  if [ "$ran" -lt 3 ]; then
    tries=$((tries + 1))
    if [ "$tries" -ge 3 ]; then
      echo "[supervisor] $tries exits in under 3s (code $code) — giving up. Check 'node server.mjs' by hand." >&2
      exit 1
    fi
  else
    tries=0
  fi

  echo "[supervisor] server exited (code $code, ran ${ran}s) — restarting in 1s" >&2
  sleep 1
done
