#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-5001}"
WEB_PORT="${WEB_PORT:-5173}"
API_URL="http://localhost:${API_PORT}"
WEB_URL="http://localhost:${WEB_PORT}"
START_CACHE_DIR="$ROOT_DIR/.cache/start"
START_PID_FILE="$START_CACHE_DIR/dev.pids"
START_LOG_DIR="$START_CACHE_DIR/logs"
LOCAL_TOOL_BIN="$ROOT_DIR/.cache/tools/bin"
INSTALL_STAMP="$START_CACHE_DIR/install.stamp"
BUILD_STAMP="$START_CACHE_DIR/build.stamp"
RUN_MODE="foreground"
WITH_SERVICES="false"
SCREEN_SESSION="${SCREEN_SESSION:-aigc_video_hub_${API_PORT}_${WEB_PORT}}"

if [ -d "$LOCAL_TOOL_BIN" ]; then
  export PATH="$LOCAL_TOOL_BIN:$PATH"
fi

log() {
  printf '\033[1;34m[start]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[start]\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ./start.sh                 Start API, Worker and Web in the foreground.
  ./start.sh --detach        Start built API, Worker and Web preview in the background.
  ./start.sh --with-services Also start postgres, redis, minio and qdrant via docker compose.

Environment:
  API_PORT=5001 WEB_PORT=5173 ./start.sh --detach

Stop detached processes with:
  ./stop.sh
EOF
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

port_in_use() {
  local port="$1"
  if have_cmd ss; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}$"
    return $?
  fi
  if have_cmd lsof; then
    lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

newer_than_path() {
  local path="$1"
  shift
  [ ! -e "$path" ] && return 0
  find "$@" -newer "$path" -print -quit 2>/dev/null | grep -q .
}

pid_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1
}

screen_session_running() {
  local session="$1"
  [ -n "$session" ] || return 1
  have_cmd screen || return 1
  screen -list 2>/dev/null | grep -F ".${session}" >/dev/null 2>&1
}

clear_stale_pid_file() {
  [ -f "$START_PID_FILE" ] || return 0
  local running=""
  while IFS='=' read -r key value; do
    if [ "$key" = "SCREEN_SESSION" ] && screen_session_running "$value"; then
      running="$running screen:${value}"
    elif pid_running "$value"; then
      running="$running pid:${value}"
    fi
  done <"$START_PID_FILE"
  if [ -n "$running" ]; then
    fail "A detached dev stack already appears to be running:${running}. Run ./stop.sh first."
  fi
  rm -f "$START_PID_FILE"
}

ensure_bin_permissions() {
  chmod +x node_modules/ts-node-dev/lib/bin.js node_modules/ts-node/dist/bin*.js 2>/dev/null || true
}

needs_install() {
  [ ! -d node_modules ] && return 0
  [ ! -x node_modules/.bin/tsc ] && return 0
  [ ! -x node_modules/.bin/vite ] && return 0
  [ ! -x node_modules/.bin/ts-node-dev ] && return 0
  newer_than_path "$INSTALL_STAMP" \
    package.json package-lock.json \
    apps/api/package.json \
    apps/web/package.json \
    apps/worker/package.json \
    packages/agent-runtime/package.json \
    packages/db/package.json \
    packages/queue/package.json \
    packages/shared/package.json \
    packages/storage/package.json
}

needs_build() {
  [ ! -d apps/web/dist ] && return 0
  [ ! -d apps/api/dist ] && return 0
  [ ! -d apps/worker/dist ] && return 0
  newer_than_path "$BUILD_STAMP" \
    package.json package-lock.json \
    apps/api/package.json apps/api/tsconfig.json apps/api/src \
    apps/web/package.json apps/web/tsconfig.json apps/web/src apps/web/public apps/web/index.html \
    apps/worker/package.json apps/worker/tsconfig.json apps/worker/src \
    packages/agent-runtime/package.json packages/agent-runtime/tsconfig.json packages/agent-runtime/src \
    packages/db/package.json packages/db/tsconfig.json packages/db/src packages/db/prisma \
    packages/queue/package.json packages/queue/tsconfig.json packages/queue/src \
    packages/shared/package.json \
    packages/storage/package.json packages/storage/tsconfig.json packages/storage/src
}

cleanup() {
  local code=$?
  if [ "${API_PID:-}" ]; then
    kill "$API_PID" >/dev/null 2>&1 || true
  fi
  if [ "${WORKER_PID:-}" ]; then
    kill "$WORKER_PID" >/dev/null 2>&1 || true
  fi
  if [ "${WEB_PID:-}" ]; then
    kill "$WEB_PID" >/dev/null 2>&1 || true
  fi
  wait >/dev/null 2>&1 || true
  exit "$code"
}

start_detached_supervisor() {
  local supervisor_log="$START_LOG_DIR/supervisor.log"
  printf '\033[1;34m[start]\033[0m Starting detached supervisor; log: %s\n' "$supervisor_log" >&2
  AIGC_ROOT_DIR="$ROOT_DIR" START_LOG_DIR="$START_LOG_DIR" API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" \
    nohup bash -lc '
      set -Eeuo pipefail
      cd "$AIGC_ROOT_DIR"

      api_pid=""
      worker_pid=""
      web_pid=""

      cleanup() {
        [ -n "$api_pid" ] && kill "$api_pid" >/dev/null 2>&1 || true
        [ -n "$worker_pid" ] && kill "$worker_pid" >/dev/null 2>&1 || true
        [ -n "$web_pid" ] && kill "$web_pid" >/dev/null 2>&1 || true
        wait >/dev/null 2>&1 || true
      }

      trap cleanup INT TERM EXIT

      env PIPELINE_MODE=queue USE_PRODUCTION_PIPELINE=true PORT="$API_PORT" \
        npm run start --prefix apps/api >"$START_LOG_DIR/api.log" 2>&1 &
      api_pid=$!

      env PIPELINE_MODE=queue USE_PRODUCTION_PIPELINE=true \
        npm run start --prefix apps/worker >"$START_LOG_DIR/worker.log" 2>&1 &
      worker_pid=$!

      npm run preview --prefix apps/web -- --host 0.0.0.0 --port "$WEB_PORT" --strictPort \
        >"$START_LOG_DIR/web.log" 2>&1 &
      web_pid=$!

      wait
    ' >"$supervisor_log" 2>&1 &
  printf '%s' "$!"
}

start_screen_session() {
  local supervisor_log="$START_LOG_DIR/supervisor.log"
  log "Starting screen session ${SCREEN_SESSION}; log: ${supervisor_log}"
  AIGC_ROOT_DIR="$ROOT_DIR" START_LOG_DIR="$START_LOG_DIR" API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" \
    screen -dmS "$SCREEN_SESSION" bash -lc '
      set -Eeuo pipefail
      cd "$AIGC_ROOT_DIR"

      api_pid=""
      worker_pid=""
      web_pid=""

      cleanup() {
        [ -n "$api_pid" ] && kill "$api_pid" >/dev/null 2>&1 || true
        [ -n "$worker_pid" ] && kill "$worker_pid" >/dev/null 2>&1 || true
        [ -n "$web_pid" ] && kill "$web_pid" >/dev/null 2>&1 || true
        wait >/dev/null 2>&1 || true
      }

      trap cleanup INT TERM EXIT

      env PIPELINE_MODE=queue USE_PRODUCTION_PIPELINE=true PORT="$API_PORT" \
        npm run start --prefix apps/api >"$START_LOG_DIR/api.log" 2>&1 &
      api_pid=$!

      env PIPELINE_MODE=queue USE_PRODUCTION_PIPELINE=true \
        npm run start --prefix apps/worker >"$START_LOG_DIR/worker.log" 2>&1 &
      worker_pid=$!

      npm run preview --prefix apps/web -- --host 0.0.0.0 --port "$WEB_PORT" --strictPort \
        >"$START_LOG_DIR/web.log" 2>&1 &
      web_pid=$!

      wait
    ' >"$supervisor_log" 2>&1
}

for arg in "$@"; do
  case "$arg" in
    --detach | --daemon)
      RUN_MODE="detach"
      ;;
    --with-services)
      WITH_SERVICES="true"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $arg"
      ;;
  esac
done

[ -f package.json ] || fail "package.json not found. Run this script from the repo root."
[ -d apps/api ] || fail "apps/api not found. Sync to the latest remote version first."
[ -d apps/web ] || fail "apps/web not found. Sync to the latest remote version first."
have_cmd node || fail "node is not installed."
have_cmd npm || fail "npm is not installed."

log "Node: $(node -v)"
log "npm: $(npm -v)"

ensure_bin_permissions

if needs_install; then
  log "Dependencies missing or stale; running npm install."
  npm install
  ensure_bin_permissions
  mkdir -p "$START_CACHE_DIR"
  touch "$INSTALL_STAMP"
else
  log "Dependencies look ready; skipping npm install."
fi

if needs_build; then
  log "Build output missing or stale; running npm run build."
  npm run build
  mkdir -p "$START_CACHE_DIR"
  touch "$BUILD_STAMP"
else
  log "Build output looks ready; skipping npm run build."
fi

if [ "$RUN_MODE" = "detach" ]; then
  mkdir -p "$START_CACHE_DIR" "$START_LOG_DIR"
  clear_stale_pid_file
fi

if [ "$WITH_SERVICES" = "true" ]; then
  have_cmd docker || fail "docker is not installed or not on PATH."
  log "Starting local services with docker compose."
  docker compose up -d postgres redis minio minio-init qdrant
fi

port_in_use "$API_PORT" && fail "Port ${API_PORT} is already in use. Stop that process or set API_PORT=xxxx."
port_in_use "$WEB_PORT" && fail "Port ${WEB_PORT} is already in use. Stop that process or set WEB_PORT=xxxx."

if [ "$RUN_MODE" = "detach" ]; then
  if have_cmd screen; then
    start_screen_session
    sleep 1
    if ! screen_session_running "$SCREEN_SESSION"; then
      fail "Detached screen session exited early. Check .cache/start/logs/*.log, or run ./start.sh in the foreground."
    fi
    cat >"$START_PID_FILE" <<EOF
SCREEN_SESSION=$SCREEN_SESSION
API_PORT=$API_PORT
WEB_PORT=$WEB_PORT
EOF
  else
    SUPERVISOR_PID="$(start_detached_supervisor)"
    sleep 1
    if ! pid_running "$SUPERVISOR_PID"; then
      fail "Detached supervisor exited early. Check .cache/start/logs/*.log, or run ./start.sh in the foreground."
    fi
    cat >"$START_PID_FILE" <<EOF
SUPERVISOR_PID=$SUPERVISOR_PID
API_PORT=$API_PORT
WEB_PORT=$WEB_PORT
EOF
  fi
  log "Detached dev stack started."
  log "Open ${WEB_URL}"
  log "Stop it with ./stop.sh"
  exit 0
fi

log "Starting API on ${API_URL}"
PIPELINE_MODE=queue USE_PRODUCTION_PIPELINE=true PORT="$API_PORT" npm run dev --prefix apps/api &
API_PID=$!

log "Starting BullMQ worker"
PIPELINE_MODE=queue USE_PRODUCTION_PIPELINE=true npm run dev --prefix apps/worker &
WORKER_PID=$!

log "Starting web on ${WEB_URL}"
npm run dev --prefix apps/web -- --host 0.0.0.0 --port "$WEB_PORT" --strictPort &
WEB_PID=$!

trap cleanup INT TERM EXIT

log "Open ${WEB_URL}"
wait "$API_PID" "$WORKER_PID" "$WEB_PID"
