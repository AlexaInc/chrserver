#!/usr/bin/env bash
# ============================================================================
#  chrserver — VPS deploy script (runs ON the VPS, called by GitHub Actions)
#
#  Usage:
#     bash deploy.sh <bundle.tgz> [release-id] [--env-file <path>]
#     bash deploy.sh --rollback            # go back to the previous release
#     bash deploy.sh --status              # what is deployed / is it healthy
#
#  What it does, in order:
#     1. unpacks the bundle into a NEW release directory (nothing is overwritten
#        in place, so a half-finished deploy can never break the running server)
#     2. installs the .env (from the GitHub secret) into shared/.env, normalises
#        CRLF from Windows, and makes <release>/src/config/.env point at it
#     3. shares state between releases: the SQLite database, the WhatsApp
#        session, the served web build, the AI model folder
#     4. installs production dependencies (npm ci --omit=dev) inside the release
#     5. flips the `current` symlink and restarts the service
#     6. waits for /health; if the new release does not answer, it puts the
#        previous release back and fails — the old, working server keeps serving
#     7. prunes old releases (keeps the newest 5)
#
#  Env overrides:  CHR_ROOT (default /srv/chrserver)  CHR_SERVICE (chrserver)
#                  CHR_KEEP (5)  CHR_RESTART_CMD (custom restart)  CHR_SKIP_NPM=1
# ============================================================================
set -euo pipefail

ROOT="${CHR_ROOT:-/srv/chrserver}"
SERVICE="${CHR_SERVICE:-chrserver}"
KEEP="${CHR_KEEP:-5}"
RELEASES="$ROOT/releases"
SHARED="$ROOT/shared"
CURRENT="$ROOT/current"
ENV_FILE="$SHARED/.env"
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[1;32m[ok]\033[0m   %s\n' "$*"; }
warn() { printf '  \033[1;33m[warn]\033[0m %s\n' "$*"; }
fail() { printf '  \033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; }

die() { fail "$*"; exit 1; }

# ---------------------------------------------------------------- helpers ---

# Read one key from the .env (for the port we should health-check).
env_value() {
    local key="$1" default="${2:-}"
    [ -f "$ENV_FILE" ] || { printf '%s' "$default"; return; }
    local line
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
    [ -n "$line" ] || { printf '%s' "$default"; return; }
    printf '%s' "${line#*=}" | tr -d '\r' | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# The VPS paths for state that must survive a deploy. If the operator's .env
# does not name them, they are appended (a release directory would otherwise
# take the database and the WhatsApp link with it when it is pruned).
ensure_env_lines() {
    [ -f "$ENV_FILE" ] || return 0
    local added=0
    want() { # key value comment
        if ! grep -qE "^$1=" "$ENV_FILE"; then
            printf '\n# --- added by deploy.sh: state that must survive a deploy (%s) ---\n%s=%s\n' "$3" "$1" "$2" >> "$ENV_FILE"
            added=$((added + 1))
        fi
    }
    want CHR_DB_PATH      "$SHARED/data/chr.db"        "the SQLite database"
    want WA_SESSION_DIR   "$SHARED/wasession"          "the WhatsApp link (do NOT lose this: re-linking needs the phone)"
    want WEBAPP_ROOT      "$SHARED/public"             "the chrclient web build this server serves"
    want WEBAPP_STATE_DIR "$SHARED/webapp-state"       "which web build is on disk already"
    [ "$added" -gt 0 ] && ok "added $added missing path setting(s) to shared/.env"
    return 0
}

install_env_file() { # $1 = uploaded env file
    local src="$1"
    [ -s "$src" ] || die "the uploaded .env is empty"
    mkdir -p "$SHARED"
    # Windows CRLF -> LF: a trailing \r would end up inside ADMIN_PASSWORD and
    # the login would fail with the correct password.
    if grep -q $'\r' "$src"; then
        tr -d '\r' < "$src" > "$ENV_FILE.new"
        ok "converted Windows CRLF line endings in .env"
    else
        cp "$src" "$ENV_FILE.new"
    fi
    mv "$ENV_FILE.new" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    shred -u "$src" 2>/dev/null || rm -f "$src"
    ok "installed the .env from the GitHub secret ($(wc -l < "$ENV_FILE" | tr -d ' ') lines)"
    ensure_env_lines
}

share_models() { # $1 = release dir
    local rel="$1"
    mkdir -p "$SHARED/models"
    # The plant models live in the repository (src/models) and travel inside
    # the bundle, so a fresh VPS needs no manual upload: seed shared/models
    # from the release on every deploy (repo contents win). shared/ keeps
    # owning the files afterwards — they survive release pruning and every
    # release just gets the symlink.
    if [ -f "$rel/src/models/manifest.json" ]; then
        cp -rf "$rel/src/models/." "$SHARED/models/"
        ok "shared/models synced from the release ($(ls -A "$SHARED/models" | wc -l | tr -d ' ') entries)"
    fi
    rm -rf "$rel/src/models"
    ln -sfn "$SHARED/models" "$rel/src/models"
}

restart_service() {
    if [ -n "${CHR_RESTART_CMD:-}" ]; then
        ok "restarting with CHR_RESTART_CMD"
        bash -lc "$CHR_RESTART_CMD"
        return
    fi
    if command -v systemctl >/dev/null 2>&1 && [ -f "/etc/systemd/system/${SERVICE}.service" ]; then
        local sudo=""
        [ "$(id -u)" = "0" ] || sudo="sudo -n"
        if $sudo systemctl restart "$SERVICE"; then
            ok "restarted the $SERVICE service"
            return
        fi
        die "could not restart $SERVICE (is passwordless sudo allowed for this user?)"
    fi
    # No systemd (containers, a hand-run VPS): start it directly so the deploy
    # still ends with a running server.
    warn "no systemd unit found — starting the server directly (nohup)"
    if [ -f "$SHARED/logs/server.pid" ]; then
        kill "$(cat "$SHARED/logs/server.pid")" 2>/dev/null || true
    fi
    # Still running an older release of THIS install? (the pattern names this
    # installation's release path, so nothing unrelated can be hit, and this
    # shell is skipped explicitly)
    for pid in $(pgrep -f "node .*${ROOT}/releases/" 2>/dev/null || true); do
        [ "$pid" = "$$" ] && continue
        [ "$pid" = "$PPID" ] && continue
        kill "$pid" 2>/dev/null || true
    done
    sleep 1
    (cd "$CURRENT" && mkdir -p "$SHARED/logs" && nohup env NODE_ENV=production \
        ENV_FILE="$CURRENT/src/config/.env" node "$CURRENT/dist/src/index.js" \
        >> "$SHARED/logs/server.log" 2>&1 & echo $! > "$SHARED/logs/server.pid")
    ok "started (pid $(cat "$SHARED/logs/server.pid")) — log: $SHARED/logs/server.log"
}

# Which port should be health-checked? The .env is the normal answer, but the
# systemd unit may set PORT itself (and dotenv never overrides a variable that
# already exists in the environment), so every plausible port is tried.
candidate_ports() {
    { unit_port; printf '\n'; env_value PORT 8000; printf '\n'; printf '8000\n'; } \
        | tr -d '\r' | awk 'NF && /^[0-9]+$/' | awk '!seen[$0]++'
}

unit_port() {
    local unit="/etc/systemd/system/${SERVICE}.service"
    [ -f "$unit" ] || return 0
    grep -oE '^Environment=PORT=[0-9]+' "$unit" 2>/dev/null | tail -n1 | cut -d= -f3
}

health_port() { # the port that actually answered, empty when none did
    local port
    for port in $(candidate_ports); do
        if curl -fsS -m 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
            printf '%s' "$port"
            return 0
        fi
    done
    return 1
}

wait_for_health() { # $1 = seconds
    local tries="${1:-40}" i=1
    while [ "$i" -le "$tries" ]; do
        if health_port >/dev/null; then
            ok "/health answered on port $(health_port) (after ${i}s)"
            return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    return 1
}

unit_state() { # active / inactive / n/a, exactly one word
    local unit="$1" state
    state="$(systemctl is-active "$unit" 2>/dev/null | head -n1 || true)"
    [ -n "$state" ] || state="n/a"
    printf '%s' "$state"
}

log_tail() {
    if command -v journalctl >/dev/null 2>&1 && [ -f "/etc/systemd/system/${SERVICE}.service" ]; then
        journalctl -u "$SERVICE" -n 25 --no-pager 2>/dev/null || true
    elif [ -f "$SHARED/logs/server.log" ]; then
        tail -n 25 "$SHARED/logs/server.log"
    fi
}

current_release_abs() { # absolute path of the release that is serving, if any
    local p
    p="$(current_release)"
    [ -n "$p" ] && readlink -f "$p"
    return 0
}

point_current_at() { # $1 = release dir  (atomic: temp symlink + rename)
    mkdir -p "$ROOT"
    local tmp="$ROOT/.current.$$"
    ln -sfn "$1" "$tmp"
    mv -Tf "$tmp" "$CURRENT" 2>/dev/null || { rm -f "$CURRENT"; ln -sfn "$1" "$CURRENT"; }
    # a self-loop would make every later command die with "Too many levels of
    # symbolic links" — refuse to leave one behind
    if [ "$(readlink "$CURRENT")" = "$CURRENT" ]; then
        rm -f "$CURRENT"; die "refused to point current at itself"
    fi
}

# `readlink -f` echoes the path even when it does not exist (which would make
# "the release before this one" resolve to the symlink itself and create a
# current -> current loop), so the symlink is read and validated by hand.
current_release() {
    local p
    p="$(readlink "$CURRENT" 2>/dev/null || true)"
    [ -n "$p" ] && [ -d "$p" ] && printf '%s' "$p"
    return 0
}

previous_release() { # the newest release that is not the current one
    local cur
    cur="$(current_release)"
    find "$RELEASES" -maxdepth 1 -mindepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | cut -d' ' -f2- | while read -r dir; do
            [ "$dir" = "$cur" ] && continue
            printf '%s\n' "$dir"
            break
        done
}

prune_releases() {
    local cur
    cur="$(current_release)"
    local dirs
    dirs="$(find "$RELEASES" -maxdepth 1 -mindepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-)"
    local i=0
    while read -r dir; do
        [ -n "$dir" ] || continue
        i=$((i + 1))
        if [ "$i" -le "$KEEP" ]; then continue; fi
        [ "$dir" = "$cur" ] && continue
        rm -rf "$dir"
        warn "pruned old release $(basename "$dir")"
    done <<< "$dirs"
}

# ------------------------------------------------------------------ modes ---

status_mode() {
    say "chrserver deploy status"
    printf '  root:      %s\n' "$ROOT"
    printf '  current:   %s\n' "$(readlink -f "$CURRENT" 2>/dev/null || echo '(none)')"
    printf '  releases:  %s\n' "$(ls -1 "$RELEASES" 2>/dev/null | wc -l | tr -d ' ')"
    printf '  env:       %s (%s)\n' "$ENV_FILE" "$([ -s "$ENV_FILE" ] && echo "present, $(wc -l < "$ENV_FILE" | tr -d ' ') lines" || echo MISSING)"
    printf '  env path:  %s\n' "$(readlink -f "$CURRENT/src/config/.env" 2>/dev/null || echo '(none)')"
    printf '  port:      %s\n' "$(env_value PORT 8000)"
    printf '  service:   %s\n' "$(unit_state "$SERVICE")"
    printf '  tunnel:    %s\n' "$(unit_state cloudflared)"
    local hp
    if hp="$(health_port)"; then
        printf '  health:    \033[1;32mOK\033[0m (http://127.0.0.1:%s/health)\n' "$hp"
    else
        printf '  health:    \033[1;31mNOT ANSWERING\033[0m (tried ports: %s)\n' "$(candidate_ports | paste -sd, -)"
    fi
    printf '  db:        %s\n' "$(env_value CHR_DB_PATH "$SHARED/data/chr.db")"
    printf '  db size:   %s\n' "$(du -h "$(env_value CHR_DB_PATH "$SHARED/data/chr.db")" 2>/dev/null | cut -f1 || echo '—')"
    printf '  wasession: %s\n' "$(env_value WA_SESSION_DIR "$SHARED/wasession")"
    exit 0
}

rollback_mode() {
    say "chrserver rollback"
    local prev
    prev="$(previous_release)"
    [ -n "$prev" ] || die "there is no earlier release to go back to"
    ok "going back to $(basename "$prev")"
    point_current_at "$prev"
    restart_service
    wait_for_health 40 || { log_tail; die "the previous release did not come up either"; }
    ok "rollback finished"
    exit 0
}

# ------------------------------------------------------------- main deploy --

BUNDLE="${1:-}"
case "$BUNDLE" in
    --status)   status_mode ;;
    --rollback) rollback_mode ;;
    ""|-h|--help)
        sed -n '2,20p' "$0"; exit 0 ;;
esac
shift || true

RELEASE_ID="$STAMP"
ENV_UPLOAD=""
while [ $# -gt 0 ]; do
    case "$1" in
        --env-file) ENV_UPLOAD="${2:-}"; shift 2 ;;
        --*)        die "unknown option $1" ;;
        *)          RELEASE_ID="$1"; shift ;;
    esac
done

[ -f "$BUNDLE" ] || die "bundle not found: $BUNDLE"

say "chrserver deploy — release $RELEASE_ID"
mkdir -p "$RELEASES" "$SHARED/data" "$SHARED/wasession" "$SHARED/public" "$SHARED/webapp-state" "$SHARED/logs"

# 1. .env first: if it is broken there is no point touching anything else
if [ -n "$ENV_UPLOAD" ]; then
    install_env_file "$ENV_UPLOAD"
elif [ ! -s "$ENV_FILE" ]; then
    die "shared/.env is missing and no --env-file was given (add the ENV_CONTENT secret and deploy again)"
fi

# 2. unpack into a fresh release directory
REL="$RELEASES/$RELEASE_ID"
[ -e "$REL" ] && die "release $RELEASE_ID already exists (use another id)"
mkdir -p "$REL"
tar -xzf "$BUNDLE" -C "$REL"
rm -f "$BUNDLE"
[ -f "$REL/dist/src/index.js" ] || die "the bundle does not contain dist/src/index.js — build step broken?"
[ -f "$REL/package-lock.json" ] || die "the bundle does not contain package-lock.json"
ok "unpacked $(du -sh "$REL" | cut -f1) into releases/$RELEASE_ID"

# 3. state that must survive the deploy
mkdir -p "$REL/src/config"
ln -sfn "$ENV_FILE" "$REL/src/config/.env"
ok "src/config/.env -> shared/.env"
share_models "$REL"
ok "src/models -> shared/models (seeded automatically from the repo bundle)"
# the database path normally comes from the .env; if the operator overrode it to
# a relative path, keep the file inside shared/ so a pruned release cannot take it
DBPATH="$(env_value CHR_DB_PATH "$SHARED/data/chr.db")"
case "$DBPATH" in
    /*) ok "database: $DBPATH" ;;
    *)  warn "CHR_DB_PATH is relative ($DBPATH) — the database would live inside the release; set an absolute path under $SHARED/data" ;;
esac

# 4. production dependencies
if [ "${CHR_SKIP_NPM:-0}" = "1" ]; then
    warn "CHR_SKIP_NPM=1 — leaving node_modules alone (shared across releases?)"
    [ -d "$REL/node_modules" ] || ln -sfn "$(readlink -f "$CURRENT/node_modules" 2>/dev/null || echo /nonexistent)" "$REL/node_modules"
else
    say "installing production dependencies (npm ci --omit=dev)"
    if ! (cd "$REL" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -8); then
        rm -rf "$REL"
        die "npm ci failed — the running server was left untouched"
    fi
    ok "node_modules ready"
fi

# 5. remember where we were, then flip
BEFORE="$(current_release)"
[ -n "$BEFORE" ] && ok "currently serving: releases/$(basename "$BEFORE")" || warn "no release was serving yet (first deploy)"
point_current_at "$REL"
ok "current -> releases/$RELEASE_ID"

# 6. restart + health check, with automatic rollback
say "restarting and waiting for /health"
restart_service
if ! wait_for_health 40; then
    fail "the new release did not answer /health — rolling back"
    log_tail
    if [ -n "$BEFORE" ]; then
        point_current_at "$BEFORE"
        restart_service
        wait_for_health 30 || fail "the previous release is not answering either — check the log above"
        fail "deploy FAILED, previous release is back in place"
    else
        fail "deploy FAILED (no previous release to fall back to)"
    fi
    exit 1
fi

prune_releases
say "done"
printf '  release:   %s\n' "$RELEASE_ID"
printf '  root:      %s\n' "$ROOT"
printf '  health:    http://127.0.0.1:%s/health\n' "$(health_port || env_value PORT 8000)"
printf '  log:       %s\n' "$(command -v journalctl >/dev/null 2>&1 && echo "journalctl -u $SERVICE -f" || echo "$SHARED/logs/server.log")"
