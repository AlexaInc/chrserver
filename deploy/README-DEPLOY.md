# chrserver — VPS deploy + Cloudflare tunnel (CI/CD)

**Date:** 2026-10-06 · **Author:** AlexaInc <rasanjanahansaka2006@gmail.com>
**Repo:** `AlexaInc/chrserver` — මේ ටික මේ round එකේ එකතු වුනා (chrclient / chrhw වලට වෙනසක් නෑ)

මේකෙන් ඔයාට ලැබෙන දේ:

1. **GitHub Actions CI/CD** — `main` එකට push කරාම → GitHub එකේ build වෙනවා → **ඔයාගේ VPS එකට
   තමන්ම deploy වෙනවා** → service එක restart වෙනවා → `/health` එක බලනවා. Fail වුනොත්
   **පරණ version එක තමන්ම ආපහු දානවා**.
2. **`.env` secret එක → `src/config/.env`** — ඔයා `ENV_CONTENT` කියලා secret එකක් දැම්මම, deploy
   වෙද්දී ඒක **`src/config/.env`** එකට ලියනවා (Windows CRLF `\r` auto-clean කරනවා).
3. **Cloudflare tunnel එක VPS එකේ** — Windows එකේ තියෙන `crophelth-tunnel` එකම, **Linux paths**
   වලින්, systemd service එකක් විදියට (boot එකේදී තමන්ම start වෙනවා).

---

## 1. VPS එකේ cloudflared — ඔයා ඇහුව ඒක 🙋

### (අ) ඇත්තටම run වෙන command එක

Windows එකේ ඔයා දැම්ම:

```powershell
TUNNEL_CMD='"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --config C:\Users\ASUS\.cloudflared\config.yml run crophelth-tunnel'
```

**VPS එකේ ඒකම මේ විදියට:**

```bash
cloudflared tunnel --config /etc/cloudflared/config.yml run crophelth-tunnel
```

ඔයාගේ `.env` එකේ `TUNNEL_CMD` line එක මේ විදියට වෙනස් කරන්න:

```env
TUNNEL_CMD=cloudflared tunnel --config /etc/cloudflared/config.yml run crophelth-tunnel
```

*(`cloudflared` කියන්නේ `/usr/local/bin/cloudflared` — setup script එකෙන් එතන install වෙනවා.
`TUNNEL_CMD` එක පාවිච්චි වෙන්නේ ඔයා server එක `--tunnel` කියලා start කරොත් විතරයි. Default
එකේදී tunnel එක **වෙනම systemd service එකක්** විදියට තමයි run වෙන්නේ — ඒක හොඳයි, මොකද app
එක restart වුනත් tunnel එක නවතින්නේ නෑ. දෙකම එකපාර run කරන්න එපා — එකම tunnel එකට connectors
දෙකක් වෙනවා.)*

### (ආ) `/etc/cloudflared/config.yml` හදන විදිය

`deploy/cloudflared/config.yml.example` එකේ template එක තියෙනවා. VPS එකේ ඒක **මේ විදියට** තියෙන්න ඕන:

```yaml
# /etc/cloudflared/config.yml
tunnel: 01234567-89ab-cdef-0123-456789abcdef        # ← crophelth-tunnel එකේ UUID එක
credentials-file: /etc/cloudflared/01234567-89ab-cdef-0123-456789abcdef.json

ingress:
  - hostname: crophealth.dpdns.org                  # ← ඔයාගේ public name එක
    service: http://127.0.0.1:8000                  # ← chrserver එකේ port එක
  - service: http_status:404
```

**UUID එකයි credentials file එකයි හොයාගන්නේ මෙහෙමයි:**

| කරන්න | කොහෙද | Command |
|---|---|---|
| tunnel එකේ UUID එක බලන්න | Windows (හෝ VPS) | `cloudflared tunnel list` → `crophelth-tunnel` පේළියේ ID එක |
| credentials JSON එක | **Windows** | `%USERPROFILE%\.cloudflared\<UUID>.json` — config.yml එකේ `credentials-file:` එකේ තියෙන file එකමයි |
| ඒක VPS එකට ගන්න | Windows PowerShell | `scp "$env:USERPROFILE\.cloudflared\<UUID>.json" <user>@<VPS-IP>:/tmp/` |
| VPS එකේ තියන්න | VPS | `sudo mv /tmp/<UUID>.json /etc/cloudflared/ && sudo chmod 600 /etc/cloudflared/<UUID>.json` |

> ඒ JSON file එක **ඒ tunnel එකේම යතුර**. ඒක කාටවත් දෙන්න එපා, git එකට දාන්නත් එපා.
> Windows එකේ තියෙන file එක VPS එකට copy කරන නිසා certificate එකක් ආයෙ හදන්න ඕන නෑ.

DNS route එක දැනටමත් දාලා නම් (Windows එකේ තියෙන නිසා ඇති) ආයෙ කරන්න ඕන නෑ. නැත්නම්
එකපාරක් මෙහෙම දාන්න:

```bash
cloudflared tunnel route dns crophelth-tunnel crophealth.dpdns.org
```

### (උ) Service එක විදියට (boot එකේදී තමන්ම)

`setup-vps.sh` එකෙන් මේක තමන්ම හදනවා (`deploy/cloudflared/cloudflared.service`):

```ini
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel --config /etc/cloudflared/config.yml run crophelth-tunnel
Restart=always
```

අතින් බලාගන්න:

```bash
sudo systemctl status cloudflared      # active (running) ද?
sudo systemctl restart cloudflared     # config.yml වෙනස් කරාම
sudo journalctl -u cloudflared -n 30   # error එකක් නම් මෙතන
```

**Windows එකේ තියෙන එක නවත්තන්න** (නැත්නම් tunnel එකට connectors දෙකක් — requests දෙකට බෙදෙනවා):

```powershell
# Windows එකේ run කරන තැන Ctrl+C   (service එකක් නම්:)
cloudflared service uninstall
```

---

## 2. Repository secrets (GitHub → Settings → Secrets and variables → Actions)

| Secret | දාන්න ඕන දේ | අනිවාර්යද |
|---|---|---|
| `VPS_HOST` | VPS එකේ IP හෝ hostname | ✅ |
| `VPS_USER` | SSH user (`root` හෝ sudo තියෙන user) | ✅ |
| `VPS_SSH_KEY` | **Private key එකේ සම්පූර්ණ content එක** (`-----BEGIN OPENSSH PRIVATE KEY-----` ඉඳන් අන්තිම line එක වෙනකම්) | ✅ |
| `ENV_CONTENT` | **මුළු `.env` file එකම** (multi-line secret එකක් විදියට paste කරන්න) | ✅ |
| `VPS_PORT` *(variable)* | SSH port (default `22`) | ➖ |
| `VPS_ROOT` *(variable)* | `/srv/chrserver` (වෙනස් කරන්න ඕන නම්) | ➖ |
| `ENV_CONTENT_BASE64` | ඒ `.env` file එකේම base64 (`ENV_CONTENT` paste කරන්න අමාරු නම්) | ➖ |

Private key එක `VPS_SSH_KEY` එකට දාන්නේ කොහොමද: Notepad එකෙන් file එක open කරලා **හැම line එකම**
(අන්තිම empty line එක ප්රශ්නයක් නෑ) secret box එකට paste කරන්න. `\r\n` තිබ්බත් කමක් නෑ — workflow එකේ
`sed -i 's/\r$//'` එකක් තියෙනවා. **Key එකේ passphrase එකක් තියෙනවා නම්** ඒක අයින් කරලා (passphrase
නැති) key එකක් deploy සඳහා හදාගන්න එක ලේසි:

```bash
ssh-keygen -t ed25519 -C "github-deploy" -f ~/.ssh/chr_deploy -N ""
# public key එක VPS එකේ:  ~/.ssh/authorized_keys  එකට එකතු කරන්න
# private key (~/.ssh/chr_deploy) එකේ content එක VPS_SSH_KEY එකට දාන්න
```

### `ENV_CONTENT` එක ඇතුලේ තියෙන්න ඕන දේ

ඔයාගේ දැනට තියෙන env content එකම, **පහත lines ටිකත් එක්කම** (Windows paths වෙනුවට VPS paths):

```env
PORT=8000
ADMIN_USERNAME=Administrator
ADMIN_PASSWORD=<ඔයාගේ එක>
JWT_SECRET=<ඔයාගේ එක>
ROBOT_TOKEN=<ඔයාගේ එක>
PUMP_TOKEN=<ඔයාගේ එක>
DOMAIN=https://crophealth.dpdns.org

# --- VPS ---
TUNNEL_CMD=cloudflared tunnel --config /etc/cloudflared/config.yml run crophelth-tunnel
DUCKDNS_TOKEN=

# state එක deploy වලින් නැති නොවෙන්න (deploy.sh එක මේවා නැත්තම් තමන්ම එකතු කරනවා,
# ඒත් ඔයාම දාන එක පැහැදිලියි)
CHR_DB_PATH=/srv/chrserver/shared/data/chr.db
WA_SESSION_DIR=/srv/chrserver/shared/wasession
WEBAPP_ROOT=/srv/chrserver/shared/public
WEBAPP_STATE_DIR=/srv/chrserver/shared/webapp-state

WEBAPP_ENABLED=true
WEBAPP_REPO=AlexaInc/chrclient
WEBAPP_RELEASE_TAG=latest
```

⚠️ **මේවා නැත්තම් මොකද වෙන්නේ** (deploy.sh එක ඒවා auto-add කරනවා, ඒත් දැනගෙන ඉන්න):
* `CHR_DB_PATH` නැත්තම් DB එක release folder එක ඇතුලේ හැදෙනවා → ඊළඟ deploy එකේදී **data නැති වෙනවා**.
* `WA_SESSION_DIR` නැත්තම් WhatsApp link එක නැති වෙනවා → **ආයෙ QR/pairing කරන්න වෙනවා**.
* `WEBAPP_ROOT` නැත්තම් හැම deploy එකකදීම web build එක ආයෙ download කරනවා (පාඩුවක් නෑ, නමුත් නිකරුනේ).

---

## 3. VPS එකේ එකපාර setup (once)

VPS එකේ (root විදියට, Ubuntu 22.04/24.04 හෝ Debian 12 හොඳ):

```bash
# 1) මේ files repo එකේ main එකට ගියාට පස්සේ, VPS එකේ:
curl -fsSL https://raw.githubusercontent.com/AlexaInc/chrserver/main/deploy/setup-vps.sh \
  -o /root/setup-vps.sh

# 2) tunnel UUID එකත් දීලා run කරන්න
sudo bash /root/setup-vps.sh --tunnel-id <UUID> --user <SSH-USER> --tunnel-host crophealth.dpdns.org
```

මේකෙන්: Node 20, git, build tools, `cloudflared`, `/srv/chrserver/...` folders, `chrserver.service`,
`cloudflared.service` — ඔක්කොම හදනවා. **Docker නැහැ** (Docker ඕන නම් කියන්න, ඒ විදියටත් හදන්නම්.)

ඊට පස්සේ GitHub secrets දාලා, `main` එකට push කරන්න (හෝ Actions → *Deploy to VPS* → *Run workflow*).

---

## 4. දවසින් දවස වැඩ කරන විදිය

```bash
# වෙනසක් කරලා push කරන්න ඕන නම්:
git add -A && git commit -m "..." && git push          # → CI build + deploy තමන්ම

# VPS එකේ තත්වය බලන්න (ඔයාගේ laptop එකෙන්):
ssh <user>@<VPS-IP> "sudo bash /srv/chrserver/current/deploy/deploy.sh --status"

# server log:
ssh <user>@<VPS-IP> "sudo journalctl -u chrserver -f"

# පරණ version එකට ආපහු:
ssh <user>@<VPS-IP> "sudo bash /srv/chrserver/current/deploy/rollback.sh"
#   හෝ: GitHub → Actions → Deploy to VPS → Run workflow → tick "rollback"

# service restart (deploy නැතුව):
ssh <user>@<VPS-IP> "sudo systemctl restart chrserver"
```

`--status` එකෙන් පෙන්නන දේ: දැන් run වෙන release එක, `/health` OK ද, DB එකේ size එක,
tunnel එක active ද, ports.

---

## 5. මොකද ඇතුලේ (technical)

| File | මොකටද |
|---|---|
| `.github/workflows/deploy.yml` | CI: build → bundle → scp → ssh deploy → health → (fail නම්) rollback. `workflow_dispatch` එකේ *rollback* checkbox එකකුත් තියෙනවා |
| `deploy/deploy.sh` | VPS එකේ run වෙන එක: new release dir → `.env` (CRLF clean, `src/config/.env` symlink) → shared state symlinks → `npm ci --omit=dev` → `current` flip → restart → `/health` → prune (last 5). `--status`, `--rollback` |
| `deploy/setup-vps.sh` | VPS එකේ එකපාර setup (Node, cloudflared, systemd units, folders) |
| `deploy/rollback.sh` | rollback wrapper |
| `deploy/chrserver.service` | systemd unit (setup script එකෙන් substitute කරලා `/etc/systemd/system/` එකට ලියනවා) |
| `deploy/cloudflared/config.yml.example` | tunnel config template (`/etc/cloudflared/config.yml`) |
| `deploy/cloudflared/cloudflared.service` | tunnel එක boot එකේදී run වෙන්න |

**වෙනස් වුන files:**
* `package.json` — `"start": "node dist/src/index.js"` (+ `npm run tunnel`), `main` එකත් හරි path එකට.
  **`tsc` එකේ output එක `dist/src/index.js`** (index.ts එක `src/` ඇතුලේ, `db/Sqlight.ts` `db/` ඇතුලේ
  නිසා common root එක project root). කලින් README එකේ තිබ්බ `node dist/index.js` එක **වැරදි** —
  ඒක නිකම් run කරොත් "Cannot find module" එනවා.
* `README.md` — production run + "Deploy to a VPS (CI/CD)" section එකක්.

**Safety:** deploy එකේදී run වෙන server එකට අත ගහන්නේ නෑ — build + `npm ci` එක **අලුත් folder එකේ**
වෙනවා, අන්තිමට විතරයි symlink එක මාරු වෙන්නේ. Health check එක fail වුනොත් තමන්ම පරණ release එකට
ආපහු යනවා. `git push` කරාම Actions → *Deploy to VPS* run එකේ summary එකේ result එක පේනවා.
