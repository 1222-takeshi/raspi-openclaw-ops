#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/raspi-openclaw-ops}
SERVICE_NAME=${SERVICE_NAME:-raspi-openclaw-ops}

# Optional: load local config (gitignored)
# Default: config/.env.local
DOTENV_FILE=${DOTENV_FILE:-config/.env.local}

# Optional overrides for /etc/systemd/system/<service>.service.d/override.conf
PORT=${PORT:-}
HOST=${HOST:-}
CLAWDBOT_SERVICE=${CLAWDBOT_SERVICE:-}
CLAWDBOT_PROCESS_PATTERNS=${CLAWDBOT_PROCESS_PATTERNS:-}

if [[ $EUID -eq 0 ]]; then
  echo "Do not run as root. Run as a normal user with sudo available." >&2
  exit 1
fi

# Safety: encourage running from a git working tree (prevents deploying random /opt contents).
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: This script should be run from a git working tree (e.g. ~/src/raspi-openclaw-ops)." >&2
  echo "       Current directory is not a git repo." >&2
  echo "       If you really know what you're doing, set ALLOW_NO_GIT=1." >&2
  if [[ "${ALLOW_NO_GIT:-}" != "1" ]]; then
    exit 2
  fi
fi

if [[ -f "${DOTENV_FILE}" ]]; then
  echo "==> Loading dotenv: ${DOTENV_FILE}" >&2
  # shellcheck disable=SC1090
  set -a
  source "${DOTENV_FILE}"
  set +a
fi

# Re-read after dotenv
PORT=${PORT:-}
HOST=${HOST:-}
CLAWDBOT_SERVICE=${CLAWDBOT_SERVICE:-}
CLAWDBOT_PROCESS_PATTERNS=${CLAWDBOT_PROCESS_PATTERNS:-}

if [[ -n "${CLAWDBOT_SERVICE}" && -n "${CLAWDBOT_PROCESS_PATTERNS}" ]]; then
  echo "ERROR: Set only one of CLAWDBOT_SERVICE or CLAWDBOT_PROCESS_PATTERNS." >&2
  exit 2
fi

echo "==> Installing to: ${APP_DIR}" >&2
sudo mkdir -p "${APP_DIR}"
sudo chown -R "$USER:$USER" "${APP_DIR}"

echo "==> Syncing files" >&2
rsync -a --delete \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  ./ "${APP_DIR}/"

echo "==> Installing dependencies & building" >&2
cd "${APP_DIR}"
npm ci --include=dev
npm run build

echo "==> Installing systemd unit" >&2
sudo cp "${APP_DIR}/systemd/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}.service"

# Create systemd drop-in overrides if any env vars are provided.
OVERRIDE_DIR="/etc/systemd/system/${SERVICE_NAME}.service.d"
OVERRIDE_FILE="${OVERRIDE_DIR}/override.conf"

if [[ -n "${PORT}" || -n "${HOST}" || -n "${CLAWDBOT_SERVICE}" || -n "${CLAWDBOT_PROCESS_PATTERNS}" ]]; then
  echo "==> Writing systemd override: ${OVERRIDE_FILE}" >&2
  sudo mkdir -p "${OVERRIDE_DIR}"

  tmpfile=$(mktemp)
  {
    echo "[Service]"
    [[ -n "${PORT}" ]] && echo "Environment=PORT=${PORT}"
    [[ -n "${HOST}" ]] && echo "Environment=HOST=${HOST}"
    [[ -n "${CLAWDBOT_SERVICE}" ]] && echo "Environment=CLAWDBOT_SERVICE=${CLAWDBOT_SERVICE}"
    [[ -n "${CLAWDBOT_PROCESS_PATTERNS}" ]] && echo "Environment=CLAWDBOT_PROCESS_PATTERNS=${CLAWDBOT_PROCESS_PATTERNS}"
  } >"${tmpfile}"

  sudo cp "${tmpfile}" "${OVERRIDE_FILE}"
  rm -f "${tmpfile}"
else
  echo "==> No overrides provided; skipping drop-in generation" >&2
fi

sudo systemctl daemon-reload
sudo systemctl enable --now "${SERVICE_NAME}"

# Post-check
echo "==> Verifying" >&2
sudo systemctl --no-pager -l status "${SERVICE_NAME}" | sed -n '1,12p' >&2 || true

CHECK_PORT=${PORT:-8080}
if command -v curl >/dev/null 2>&1; then
  echo "==> Checking health endpoint: http://127.0.0.1:${CHECK_PORT}/health.json" >&2
  curl -fsS "http://127.0.0.1:${CHECK_PORT}/health.json" || true
  echo >&2
fi

echo "==> Done" >&2
echo "- Status: systemctl status ${SERVICE_NAME}" >&2
echo "- Logs:   journalctl -u ${SERVICE_NAME} -f" >&2
