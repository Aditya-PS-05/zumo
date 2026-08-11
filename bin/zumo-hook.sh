#!/usr/bin/env bash
set -u

port="${ZUMO_PORT:-${PORT23_PORT:-7323}}"
session="${ZUMO_SESSION:-${PORT23_SESSION:-}}"

curl --max-time 2 --silent --show-error \
  --request POST \
  --header 'Content-Type: application/json' \
  --data-binary @- \
  "http://127.0.0.1:${port}/api/events?session=${session}" \
  >/dev/null 2>&1 || true
