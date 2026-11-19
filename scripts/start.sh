#!/bin/sh
# Local start: stop a server already running on our port, then start a fresh one.
# (Docker runs server.js directly and doesn't use this.)
cd "$(dirname "$0")/.." || exit 1
PORT=$(sed -n 's/^PORT=//p' .env 2>/dev/null | tail -n 1)
PORT=${PORT:-8787}

# Only node processes listening on the port, so nothing else gets killed by accident.
pids=$(lsof -nP -t -a -c node -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)
if [ -n "$pids" ]; then
  echo "stopping the server already on port $PORT (pid $pids)"
  kill $pids
  i=0
  while lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
fi

exec node --env-file=.env server.js
