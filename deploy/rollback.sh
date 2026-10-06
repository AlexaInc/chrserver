#!/usr/bin/env bash
# Put the previous release back (same as: bash deploy.sh --rollback)
#   ssh <user>@<vps> "sudo bash /srv/chrserver/current/deploy/rollback.sh"
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$HERE/deploy.sh" --rollback
