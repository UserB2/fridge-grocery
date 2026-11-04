#!/bin/zsh
cd -- "$(dirname -- "$0")"
if /usr/bin/curl -fsS http://127.0.0.1:8766/ >/dev/null 2>&1; then
  /usr/bin/open http://127.0.0.1:8766/
  exit 0
fi
/usr/bin/python3 -m http.server 8766 --bind 127.0.0.1 &
preview_pid=$!
trap 'kill "$preview_pid" 2>/dev/null' EXIT INT TERM
sleep 1
/usr/bin/open http://127.0.0.1:8766/
wait "$preview_pid"
