#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

TOOLS_DIR="$ROOT_DIR/.cache/tools"
LOCAL_TOOL_BIN="$TOOLS_DIR/bin"
FFMPEG_ARCHIVE="$TOOLS_DIR/ffmpeg-release-amd64-static.tar.xz"
FFMPEG_URL="${FFMPEG_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}"
NODE_VERSION="${NODE_VERSION:-v24.14.0}"
NODE_ARCHIVE="$TOOLS_DIR/node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_URL="${NODE_URL:-https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz}"

SKIP_NPM=0
SKIP_FFMPEG=0
SKIP_BUILD=0
PREWARM_CLIP=0
WITH_PROD_SERVICES=0

log() {
  printf '\033[1;34m[setup]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

usage() {
  cat <<'USAGE'
Usage: ./setup.sh [options]

Options:
  --prewarm-clip   Download the CLIP model cache after npm install.
  --with-prod-services
                   Check Docker Compose availability for Postgres/Redis/Qdrant/MinIO mode.
  --skip-npm       Skip npm install and Prisma generation.
  --skip-ffmpeg    Skip local ffmpeg setup.
  --skip-build     Skip npm run build.
  -h, --help       Show this help.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-npm)
      SKIP_NPM=1
      ;;
    --skip-ffmpeg)
      SKIP_FFMPEG=1
      ;;
    --skip-build)
      SKIP_BUILD=1
      ;;
    --prewarm-clip)
      PREWARM_CLIP=1
      ;;
    --with-prod-services)
      WITH_PROD_SERVICES=1
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
  shift
done

apt_install() {
  [ "$#" -gt 0 ] || return 0
  have_cmd apt-get || return 1

  if [ "$(id -u)" -eq 0 ]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
    return
  fi

  if have_cmd sudo && sudo -n true 2>/dev/null; then
    sudo apt-get update
    sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
    return
  fi

  return 1
}

ensure_download_tools() {
  local missing_packages=()

  have_cmd curl || missing_packages+=("curl")
  have_cmd tar || missing_packages+=("tar")
  have_cmd xz || missing_packages+=("xz-utils")

  if [ "${#missing_packages[@]}" -eq 0 ]; then
    return
  fi

  log "Installing system setup tools: ${missing_packages[*]}"
  if ! apt_install "${missing_packages[@]}"; then
    fail "Missing setup tools: ${missing_packages[*]}. Install manually, for example: sudo apt-get update && sudo apt-get install -y ${missing_packages[*]}"
  fi
}

node_version_ok() {
  have_cmd node || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) || (major === 20 && minor >= 19) ? 0 : 1);'
}

activate_local_node_if_available() {
  local node_dir
  node_dir="$(find "$TOOLS_DIR" -maxdepth 1 -type d -name 'node-v*-linux-x64' -print -quit 2>/dev/null || true)"
  if [ -n "$node_dir" ] && [ -x "$node_dir/bin/node" ] && [ -x "$node_dir/bin/npm" ]; then
    export PATH="$node_dir/bin:$PATH"
  fi
}

setup_node() {
  mkdir -p "$TOOLS_DIR"
  activate_local_node_if_available

  if node_version_ok && have_cmd npm; then
    log "Node: $(node -v)"
    log "npm: $(npm -v)"
    return
  fi

  [ "$(uname -s)" = "Linux" ] || fail "Node.js >=20.19 or >=22.12 is required. Install Node manually on this OS."
  [ "$(uname -m)" = "x86_64" ] || fail "Automatic Node.js download only supports x86_64. Install Node manually."

  ensure_download_tools

  log "Downloading local Node.js ${NODE_VERSION}."
  curl -fL "$NODE_URL" -o "$NODE_ARCHIVE"

  local top_dir
  top_dir="$(tar -tf "$NODE_ARCHIVE" | sed -n '1s#/.*##p')"
  [ -n "$top_dir" ] || fail "Could not inspect Node.js archive."

  log "Extracting Node.js to .cache/tools."
  tar -xJf "$NODE_ARCHIVE" -C "$TOOLS_DIR"
  [ -x "$TOOLS_DIR/$top_dir/bin/node" ] || fail "node binary missing after extraction."
  [ -x "$TOOLS_DIR/$top_dir/bin/npm" ] || fail "npm binary missing after extraction."

  export PATH="$TOOLS_DIR/$top_dir/bin:$PATH"
  node_version_ok || fail "Downloaded Node.js is still incompatible."
  have_cmd npm || fail "npm is unavailable after Node.js setup."

  log "Node: $(node -v)"
  log "npm: $(npm -v)"
}

ensure_project_tools() {
  ensure_download_tools
  setup_node
}

ensure_bin_permissions() {
  chmod +x \
    node_modules/prettier/bin/prettier.cjs \
    node_modules/ts-node-dev/lib/bin.js \
    node_modules/ts-node/dist/bin.js \
    node_modules/typescript/bin/tsc \
    node_modules/vite/bin/vite.js \
    2>/dev/null || true
}

setup_npm() {
  if [ "$SKIP_NPM" -eq 1 ]; then
    log "Skipping npm install."
    return
  fi

  log "Installing npm dependencies."
  npm install
  ensure_bin_permissions

  log "Generating Prisma Client."
  npm run db:generate

  if [ "$PREWARM_CLIP" -eq 1 ]; then
    log "Prewarming CLIP model cache."
    npm run clip:prewarm
  fi
}

setup_ffmpeg() {
  if [ "$SKIP_FFMPEG" -eq 1 ]; then
    log "Skipping ffmpeg setup."
    return
  fi

  mkdir -p "$LOCAL_TOOL_BIN"

  if [ -x "$LOCAL_TOOL_BIN/ffmpeg" ] && [ -x "$LOCAL_TOOL_BIN/ffprobe" ]; then
    export PATH="$LOCAL_TOOL_BIN:$PATH"
    log "Using local ffmpeg: $($LOCAL_TOOL_BIN/ffmpeg -version | sed -n '1p')"
    return
  fi

  if have_cmd ffmpeg && have_cmd ffprobe; then
    log "Using system ffmpeg: $(ffmpeg -version | sed -n '1p')"
    return
  fi

  [ "$(uname -s)" = "Linux" ] || fail "Automatic ffmpeg download only supports Linux. Install ffmpeg manually."
  [ "$(uname -m)" = "x86_64" ] || fail "Automatic ffmpeg download only supports x86_64. Install ffmpeg manually."
  ensure_download_tools

  log "Downloading static ffmpeg."
  curl -fL "$FFMPEG_URL" -o "$FFMPEG_ARCHIVE"

  local top_dir
  top_dir="$(tar -tf "$FFMPEG_ARCHIVE" | sed -n '1s#/.*##p')"
  [ -n "$top_dir" ] || fail "Could not inspect ffmpeg archive."

  log "Extracting ffmpeg to .cache/tools."
  tar -xJf "$FFMPEG_ARCHIVE" -C "$TOOLS_DIR"
  [ -x "$TOOLS_DIR/$top_dir/ffmpeg" ] || fail "ffmpeg binary missing after extraction."
  [ -x "$TOOLS_DIR/$top_dir/ffprobe" ] || fail "ffprobe binary missing after extraction."

  ln -sf "../$top_dir/ffmpeg" "$LOCAL_TOOL_BIN/ffmpeg"
  ln -sf "../$top_dir/ffprobe" "$LOCAL_TOOL_BIN/ffprobe"
  export PATH="$LOCAL_TOOL_BIN:$PATH"

  log "Installed local ffmpeg: $($LOCAL_TOOL_BIN/ffmpeg -version | sed -n '1p')"
}

check_prod_services() {
  if [ "$WITH_PROD_SERVICES" -eq 0 ]; then
    return
  fi

  have_cmd docker || fail "Docker is required for --with-prod-services. Install Docker Desktop or Docker Engine."
  if docker compose version >/dev/null 2>&1; then
    log "Docker Compose: $(docker compose version | sed -n '1p')"
  elif have_cmd docker-compose; then
    log "docker-compose: $(docker-compose version | sed -n '1p')"
  else
    fail "Docker Compose is required for --with-prod-services."
  fi
}

run_build() {
  if [ "$SKIP_BUILD" -eq 1 ]; then
    log "Skipping build."
    return
  fi

  log "Building project."
  npm run build
}

ensure_project_tools
setup_npm
setup_ffmpeg
check_prod_services
run_build

log "Setup complete."
log "Start the app with: ./start.sh"
