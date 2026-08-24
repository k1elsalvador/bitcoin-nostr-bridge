#!/usr/bin/env bash
# Installs bitcoin-nostr-bridge as a systemd service.
# Usage: sudo ./deploy/linux/install-service.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_BIN="$(command -v node || true)"
SERVICE_USER="${SUDO_USER:-$USER}"
UNIT_PATH="/etc/systemd/system/bitcoin-nostr-bridge.service"

if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install Node.js 18+ first." >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/config.json" ]; then
  echo "config.json not found in $PROJECT_ROOT — copy config.example.json to config.json" \
    "and fill it in before installing the service." >&2
  exit 1
fi

if [ "$EUID" -ne 0 ]; then
  echo "Re-run with sudo (writes to /etc/systemd/system)." >&2
  exit 1
fi

# Escape sed replacement-text metacharacters (backslash, ampersand) in each
# substituted value — unescaped, a path or username containing "&" would be
# expanded to the matched text by sed and corrupt the generated unit file.
sed_escape_repl() {
  printf '%s' "$1" | sed -e 's/[\&]/\\&/g'
}

sed \
  -e "s#__PROJECT_ROOT__#$(sed_escape_repl "$PROJECT_ROOT")#g" \
  -e "s#__NODE_BIN__#$(sed_escape_repl "$NODE_BIN")#g" \
  -e "s#__SERVICE_USER__#$(sed_escape_repl "$SERVICE_USER")#g" \
  "$PROJECT_ROOT/deploy/linux/bitcoin-nostr-bridge.service.template" > "$UNIT_PATH"

systemctl daemon-reload
systemctl enable --now bitcoin-nostr-bridge

echo ""
echo "Installed and started. Live log: journalctl -u bitcoin-nostr-bridge -f"
echo "Manage with: systemctl status/stop/restart bitcoin-nostr-bridge"
