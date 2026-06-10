#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

START_CACHE_DIR="$ROOT_DIR/.cache/start"
START_PID_FILE="$START_CACHE_DIR/dev.pids"
WITH_SERVICES="false"

log() {
  printf '\033[1;34m[stop]\033[0m %s\n' "$*"
}

warn() {
  printf '\033[1;33m[stop]\033[0m %s\n' "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  ./stop.sh                 Stop the detached API, Worker and Web stack.
  ./stop.sh --with-services Also stop postgres, redis, minio and qdrant via docker compose.
EOF
}

pid_running() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" >/dev/null 2>&1
}

screen_session_running() {
  local session="$1"
  [ -n "$session" ] || return 1
  command -v screen >/dev/null 2>&1 || return 1
  screen -list 2>/dev/null | grep -F ".${session}" >/dev/null 2>&1
}

kill_tree() {
  local pid="$1"
  pid_running "$pid" || return 0
  local child
  if command -v pgrep >/dev/null 2>&1; then
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do
      kill_tree "$child"
    done
  fi
  kill "$pid" >/dev/null 2>&1 || true
}

for arg in "$@"; do
  case "$arg" in
    --with-services)
      WITH_SERVICES="true"
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      warn "Unknown option: $arg"
      usage
      exit 1
      ;;
  esac
done

if [ -f "$START_PID_FILE" ]; then
  SCREEN_SESSION=""
  SUPERVISOR_PID=""
  API_PID=""
  WORKER_PID=""
  WEB_PID=""
  # shellcheck disable=SC1090
  source "$START_PID_FILE"

  if [ -n "$SCREEN_SESSION" ]; then
    if screen_session_running "$SCREEN_SESSION"; then
      log "Stopping screen session ${SCREEN_SESSION}"
      screen -S "$SCREEN_SESSION" -X quit >/dev/null 2>&1 || true
      sleep 1
      if screen_session_running "$SCREEN_SESSION"; then
        warn "Screen session ${SCREEN_SESSION} did not exit cleanly."
      fi
    else
      log "Screen session ${SCREEN_SESSION} is not running"
    fi
    rm -f "$START_PID_FILE"
    log "Detached dev stack stopped."
  elif [ -n "$SUPERVISOR_PID" ]; then
    if pid_running "$SUPERVISOR_PID"; then
      log "Stopping detached supervisor pid ${SUPERVISOR_PID}"
      kill_tree "$SUPERVISOR_PID"
      sleep 1
      if pid_running "$SUPERVISOR_PID"; then
        warn "Supervisor pid ${SUPERVISOR_PID} did not exit; forcing."
        kill -9 "$SUPERVISOR_PID" >/dev/null 2>&1 || true
      fi
    else
      log "Supervisor pid ${SUPERVISOR_PID} is not running"
    fi
    rm -f "$START_PID_FILE"
    log "Detached dev stack stopped."
  else
    for item in "API:$API_PID" "WORKER:$WORKER_PID" "WEB:$WEB_PID"; do
      name="${item%%:*}"
      pid="${item#*:}"
      if pid_running "$pid"; then
        log "Stopping ${name} pid ${pid}"
        kill_tree "$pid"
      else
        log "${name} pid ${pid:-unknown} is not running"
      fi
    done

    sleep 1
    for item in "API:$API_PID" "WORKER:$WORKER_PID" "WEB:$WEB_PID"; do
      name="${item%%:*}"
      pid="${item#*:}"
      if pid_running "$pid"; then
        warn "${name} pid ${pid} did not exit; forcing."
        kill -9 "$pid" >/dev/null 2>&1 || true
      fi
    done
    rm -f "$START_PID_FILE"
    log "Detached dev stack stopped."
  fi
else
  warn "No detached PID file found at $START_PID_FILE."
fi

if [ "$WITH_SERVICES" = "true" ]; then
  if command -v docker >/dev/null 2>&1; then
    log "Stopping local docker compose services."
    docker compose stop postgres redis minio minio-init qdrant
  else
    warn "docker is not installed or not on PATH; services were not stopped."
  fi
fi
