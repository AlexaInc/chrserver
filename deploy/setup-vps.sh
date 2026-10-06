#!/usr/bin/env bash
# ============================================================================
#  chrserver — one-time VPS setup (Ubuntu / Debian, x86_64)
#
#  Run this ONCE on a fresh VPS, as root (or with sudo):
#
#      sudo bash setup-vps.sh --tunnel-id <TUNNEL-UUID>
#
#  It installs everything the server needs and prepares /srv/chrserver, so the
#  GitHub Action can deploy from then on. Nothing here needs to be repeated for
#  later deploys.
#
#  Options:
#     --tunnel-id UUID     Cloudflare tunnel UUID (from `cloudflared tunnel list`)
#     --tunnel-host HOST   the public hostname (default: from the repo's .env.example)
#     --user NAME          the account the server runs as (default: the one calling)
#     --root PATH          install root           (default /srv/chrserver)
#     --port N             app port               (default 8000)
#     --no-tunnel          skip the cloudflared setup
# ============================================================================
set -euo pipefail

TUNNEL_ID=""
TUNNEL_HOST="crophealth.dpdns.org"
RUN_USER="${SUDO_USER:-$(id -un)}"
ROOT="/srv/chrserver"
PORT="8000"
WITH_TUNNEL=1

while [ $# -gt 0 ]; do
    case "$1" in
        --tunnel-id)   TUNNEL_ID="${2:-}"; shift 2 ;;
        --tunnel-host) TUNNEL_HOST="${2:-}"; shift 2 ;;
        --user)        RUN_USER="${2:-}"; shift 2 ;;
        --root)        ROOT="${2:-}"; shift 2 ;;
        --port)        PORT="${2:-}"; shift 2 ;;
        --no-tunnel)   WITH_TUNNEL=0; shift ;;
        *) echo "unknown option $1" >&2; exit 2 ;;
    esac
done

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m[ok]\033[0m   %s\n' "$*"; }
warn() { printf '  \033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '  \033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run this with sudo / as root"
id "$RUN_USER" >/dev/null 2>&1 || die "user '$RUN_USER' does not exist"
command -v apt-get >/dev/null 2>&1 || die "this script is for Ubuntu/Debian (apt). Adapt it for other distros."
[ -f /etc/os-release ] && . /etc/os-release && ok "distro: ${PRETTY_NAME:-unknown}"

export DEBIAN_FRONTEND=noninteractive

say "1/6  system packages"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg lsb-release jq \
    build-essential python3 tar gzip >/dev/null
ok "curl git ca-certificates build-essential python3 (native modules: sqlite3, sharp)"

say "2/6  Node.js 20 LTS"
if command -v node >/dev/null 2>&1 && [ "$(node -v | cut -c2-3)" -ge 20 ] 2>/dev/null; then
    ok "node $(node -v) already installed"
else
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    ok "installed node $(node -v) / npm $(npm -v)"
fi

say "3/6  $ROOT (releases that can be rolled back, and shared state)"
mkdir -p "$ROOT/releases" "$ROOT/shared/data" "$ROOT/shared/wasession" \
         "$ROOT/shared/public" "$ROOT/shared/webapp-state" "$ROOT/shared/models" "$ROOT/shared/logs"
touch "$ROOT/shared/.env"
chmod 600 "$ROOT/shared/.env"
chown -R "$RUN_USER":"$RUN_USER" "$ROOT"
ok "owner: $RUN_USER"
ok "the GitHub Action fills shared/.env from the ENV_CONTENT secret"

say "4/6  systemd service (chrserver)"
cat > /etc/systemd/system/chrserver.service <<UNIT
[Unit]
Description=chrserver — AI Crop Robot backend
Documentation=https://github.com/AlexaInc/chrserver
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT/current
# The .env prepared by the deploy (src/config/.env is a symlink to shared/.env).
# ENV_FILE is explicit so both \`node dist/src/index.js\` and \`tsx src/index.ts\`
# read the very same file.
Environment=NODE_ENV=production
# PORT is deliberately NOT set here: the .env is the single source of
# truth for it (dotenv never overrides a variable that already exists)
Environment=ENV_FILE=$ROOT/current/src/config/.env
ExecStart=/usr/bin/node $ROOT/current/dist/src/index.js
# The tunnel runs as its own service (cloudflared), so nothing here depends on it
Restart=always
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal
SyslogIdentifier=chrserver
# /health is polled by the deploy; give it a moment to come up on restarts
TimeoutStopSec=20
KillSignal=SIGINT
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable chrserver >/dev/null 2>&1 || true
ok "unit installed (user $RUN_USER, port $PORT) — it starts on boot"
warn "chrserver will keep restarting until the first deploy writes the real .env"

if [ "$WITH_TUNNEL" = "1" ]; then
    say "5/6  Cloudflare tunnel (cloudflared)"
    if ! command -v cloudflared >/dev/null 2>&1; then
        arch="$(uname -m)"
        case "$arch" in
            x86_64|amd64) cfarch="amd64" ;;
            aarch64|arm64) cfarch="arm64" ;;
            *) die "unsupported architecture $arch" ;;
        esac
        curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfarch}" \
            -o /usr/local/bin/cloudflared
        chmod +x /usr/local/bin/cloudflared
        ok "installed $(cloudflared --version 2>/dev/null | head -1)"
    else
        ok "cloudflared already installed"
    fi

    mkdir -p /etc/cloudflared
    if [ -z "$TUNNEL_ID" ]; then
        warn "no --tunnel-id given: /etc/cloudflared/config.yml is written with a placeholder."
        warn "On Windows run:  cloudflared tunnel list     and copy the UUID of crophelth-tunnel"
        warn "Then:  sudo sed -i 's/TUNNEL-UUID/HERE-THE-REAL-UUID/g' /etc/cloudflared/config.yml"
        TUNNEL_ID="TUNNEL-UUID"
    fi
    cat > /etc/cloudflared/config.yml <<YAML
# Cloudflare Tunnel for chrserver — the same tunnel the Windows machine runs,
# now on the VPS. Command (see cloudflared.service):
#   cloudflared tunnel --config /etc/cloudflared/config.yml run crophelth-tunnel
tunnel: $TUNNEL_ID
credentials-file: /etc/cloudflared/$TUNNEL_ID.json

ingress:
  # the public address the app + robot talk to -> the local server
  - hostname: $TUNNEL_HOST
    service: http://127.0.0.1:$PORT
  # websockets (socket.io) are proxied by the same rule above; keep this last
  - service: http_status:404
YAML
    ok "wrote /etc/cloudflared/config.yml (tunnel $TUNNEL_ID -> http://127.0.0.1:$PORT)"

    cat > /etc/systemd/system/cloudflared.service <<'UNIT'
[Unit]
Description=Cloudflare Tunnel (crophelth-tunnel -> chrserver)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Same command as on Windows, with Linux paths
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel --config /etc/cloudflared/config.yml run crophelth-tunnel
Restart=always
RestartSec=5
StartLimitIntervalSec=0
User=root
SyslogIdentifier=cloudflared

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable cloudflared >/dev/null 2>&1 || true
    if [ -f "/etc/cloudflared/$TUNNEL_ID.json" ]; then
        systemctl restart cloudflared || true
        ok "cloudflared service started"
    else
        warn "the credentials file is still missing: /etc/cloudflared/$TUNNEL_ID.json"
        warn "copy it from the Windows machine (it is the <UUID>.json in %USERPROFILE%\\.cloudflared)"
        warn "   scp \"\$env:USERPROFILE\\.cloudflared\\$TUNNEL_ID.json\" $RUN_USER@<VPS-IP>:/tmp/"
        warn "   ssh $RUN_USER@<VPS-IP> 'sudo mv /tmp/$TUNNEL_ID.json /etc/cloudflared/ && chmod 600 /etc/cloudflared/$TUNNEL_ID.json && sudo systemctl restart cloudflared'"
    fi
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
        warn "ufw is active — keep ports 8000 and 22 open (or only 22: the tunnel needs no inbound port)"
    fi
else
    say "5/6  skipped the tunnel (--no-tunnel)"
fi

say "6/6  summary"
printf '  root:        %s\n' "$ROOT"
printf '  service:     %s\n' "systemctl status chrserver"
printf '  tunnel:      %s\n' "$([ "$WITH_TUNNEL" = "1" ] && echo "systemctl status cloudflared" || echo "(not set up here)")"
printf '  env:         %s\n' "$ROOT/shared/.env  (filled by the GitHub secret ENV_CONTENT)"
printf '  database:    %s\n' "$ROOT/shared/data/chr.db"
printf '  whatsapp:    %s\n' "$ROOT/shared/wasession"
printf '  AI models:   %s\n' "$ROOT/shared/models  (drop the plant model folders here once)"
cat <<'NEXT'

  Next, in the GitHub repository (Settings → Secrets and variables → Actions):

     VPS_HOST       = <this server's IP or hostname>
     VPS_USER       = <the SSH user, e.g. root / ubuntu>
     VPS_SSH_KEY    = the private key that logs in here (whole PEM file)
     ENV_CONTENT    = the whole .env file, one VAR=value per line
                      (add CHR_DB_PATH / WA_SESSION_DIR / WEBAPP_ROOT / TUNNEL_CMD —
                       see deploy/README-DEPLOY.md for the exact block)

  Then push to main (or run the "Deploy to VPS" workflow by hand).
NEXT
