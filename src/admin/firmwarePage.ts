/**
 * src/admin/firmwarePage.ts — the built-in OTA page (no build step, no assets).
 *
 * Why a page inside chrserver instead of only the app card: flashing a board is
 * something the operator does from a laptop, right next to the board and the
 * `.bin` file that the Arduino IDE / PlatformIO just produced. This page needs
 * nothing but a browser pointed at the same server the board already talks to
 * (the tunnel URL or http://<lan-ip>:8000), so the operator can upload the file
 * and press Update without copying anything around.
 *
 * It uses the same auth as every other panel call: SHA-256(username + nonce) and
 * SHA-256(password + nonce) against /auth/login, with a small SHA-256 written
 * into the page because crypto.subtle is only available in a secure context
 * (https or localhost) and this page must also work over plain http on the LAN.
 */

export const FIRMWARE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chrserver — Firmware (OTA)</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #0f172a; }
  header { background: #0f172a; color: #fff; padding: 14px 18px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  header h1 { font-size: 16px; margin: 0; font-weight: 800; letter-spacing: .2px; }
  header .sub { font-size: 12px; opacity: .75; }
  header .spacer { flex: 1; }
  main { max-width: 1080px; margin: 0 auto; padding: 18px; display: grid; gap: 16px; }
  section { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
  h2 { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eef2f7; vertical-align: middle; }
  th { color: #64748b; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  code { background: #f1f5f9; padding: 1px 5px; border-radius: 5px; font-size: 12px; }
  input, select, button { font: inherit; }
  input, select { width: 100%; padding: 9px 10px; border: 1px solid #cbd5e1; border-radius: 9px; background: #fff; color: inherit; }
  label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; margin: 0 0 4px; }
  button { border: 0; border-radius: 9px; padding: 10px 14px; font-weight: 700; cursor: pointer; background: #1d4ed8; color: #fff; }
  button.ghost { background: #eef2f7; color: #1e293b; }
  button.danger { background: #e11d48; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .row { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); align-items: end; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .pill.on { background: #dcfce7; color: #166534; }
  .pill.off { background: #f1f5f9; color: #64748b; }
  .pill.warn { background: #fef3c7; color: #92400e; }
  .pill.bad { background: #ffe4e6; color: #9f1239; }
  .note { font-size: 12px; color: #64748b; margin-top: 10px; }
  .log { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #0f172a; color: #e2e8f0; border-radius: 10px; padding: 10px; max-height: 180px; overflow: auto; white-space: pre-wrap; }
  .msg { margin-top: 10px; font-size: 13px; font-weight: 600; }
  .msg.ok { color: #15803d; }
  .msg.err { color: #be123c; }
  #login { display: grid; gap: 10px; max-width: 380px; }
  .hidden { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>Firmware updates (OTA)</h1>
  <span class="sub">upload a .bin → press Update → the board flashes itself and reboots</span>
  <span class="spacer"></span>
  <button class="ghost" id="logout" class="hidden">Sign out</button>
</header>
<main>
  <section id="loginCard">
    <h2>Operator sign-in</h2>
    <div id="login">
      <div><label for="u">Username</label><input id="u" autocomplete="username"></div>
      <div><label for="p">Password</label><input id="p" type="password" autocomplete="current-password"></div>
      <button id="signin">Sign in</button>
      <div class="msg err hidden" id="loginMsg"></div>
    </div>
  </section>

  <section id="panel" class="hidden">
    <h2>Boards the server has heard from</h2>
    <table>
      <thead><tr><th>Board</th><th>Role</th><th>OTA target</th><th>Firmware on the board</th><th>State</th><th>Last hello</th></tr></thead>
      <tbody id="devices"><tr><td colspan="6">loading…</td></tr></tbody>
    </table>
    <p class="note" id="deviceNote"></p>
  </section>

  <section id="uploadCard" class="hidden">
    <h2>Upload a compiled firmware image</h2>
    <div class="row">
      <div><label for="target">Target (board family)</label><input id="target" list="targets" placeholder="rover | pump-c3 | pump-devkit"><datalist id="targets"></datalist></div>
      <div><label for="version">Version</label><input id="version" placeholder="2026-10-07-arc-avoid"></div>
      <div><label for="notes">Notes (optional)</label><input id="notes" placeholder="what changed"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <div><label for="file">Firmware .bin</label><input id="file" type="file" accept=".bin,application/octet-stream"></div>
      <div><button id="upload">Upload</button></div>
    </div>
    <p class="note">
      Nothing here is pushed to a board until you press <b>Update</b> in the next table. The target must match the
      <code>FW_TARGET</code> compiled into the board; a mismatch is refused by the server <i>and</i> by the board.
      The version must be the one shown in that build (e.g. <code>FW_VERSION</code> in config.h) — it is the only way the
      server can tell whether a board already runs the new image.
    </p>
    <div class="msg hidden" id="uploadMsg"></div>
  </section>

  <section id="storeCard" class="hidden">
    <h2>Images on this server</h2>
    <table>
      <thead><tr><th>Target</th><th>Version</th><th>Size</th><th>MD5</th><th>Uploaded</th><th>Queued update</th><th></th></tr></thead>
      <tbody id="builds"><tr><td colspan="7">loading…</td></tr></tbody>
    </table>
    <p class="note">“Queued” means the server will keep offering that image to every board of that target (including one that is switched off right now) until the board reports it after the reboot.</p>
    <div class="msg hidden" id="updateMsg"></div>
  </section>

  <section id="logCard" class="hidden">
    <h2>Activity</h2>
    <div class="log" id="log"></div>
  </section>
</main>
<script>
/* ------------------------------------------------------------------ */
/* tiny SHA-256 — the login hash needs it, and it must also work on    */
/* plain http (crypto.subtle is https/localhost only)                  */
/* ------------------------------------------------------------------ */
function sha256Hex(ascii) {
  function rr(x, n) { return (x >>> n) | (x << (32 - n)); }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
           0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
           0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
           0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
           0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
           0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
           0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
           0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var bytes = [];
  for (var i = 0; i < ascii.length; i++) {
    var c = ascii.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
    else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  var bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
             (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  var w = new Array(64);
  for (var off = 0; off < bytes.length; off += 64) {
    for (var t = 0; t < 16; t++) {
      w[t] = ((bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) |
              (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3]) >>> 0;
    }
    for (var t2 = 16; t2 < 64; t2++) {
      var s0 = rr(w[t2 - 15], 7) ^ rr(w[t2 - 15], 18) ^ (w[t2 - 15] >>> 3);
      var s1 = rr(w[t2 - 2], 17) ^ rr(w[t2 - 2], 19) ^ (w[t2 - 2] >>> 10);
      w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) >>> 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (var i2 = 0; i2 < 64; i2++) {
      var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[i2] + w[i2]) >>> 0;
      var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      var mj = (a & b) ^ (a & c) ^ (b & c);
      var t2v = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2v) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map(function (x) { return ("00000000" + x.toString(16)).slice(-8); }).join("");
}

/* ------------------------------------------------------------------ */
/* state + plumbing                                                    */
/* ------------------------------------------------------------------ */
var TOKEN_KEY = "chrserver.firmware.token";
var token = localStorage.getItem(TOKEN_KEY) || "";
var $ = function (id) { return document.getElementById(id); };
function log(text) {
  var el = $("log");
  var line = new Date().toLocaleTimeString() + "  " + text;
  el.textContent = line + "\\n" + el.textContent;
}
function say(id, text, ok) {
  var el = $(id);
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}
function show(which) {
  ["panel", "uploadCard", "storeCard", "logCard"].forEach(function (id) { $(id).classList.toggle("hidden", !which); });
  $("loginCard").classList.toggle("hidden", which);
  $("logout").classList.toggle("hidden", !which);
}
async function api(path, options) {
  options = options || {};
  var headers = options.headers || {};
  headers["Authorization"] = "Bearer " + token;
  var res = await fetch(path, Object.assign({}, options, { headers: headers }));
  if (res.status === 401) { token = ""; localStorage.removeItem(TOKEN_KEY); show(false); throw new Error("session expired — sign in again"); }
  var body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  if (!res.ok) throw new Error((body && (body.message || body.error)) || ("HTTP " + res.status));
  return body;
}
function esc(text) {
  return String(text == null ? "" : text).replace(/[&<>"]/g, function (ch) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch];
  });
}
function prettySize(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(2) + " MB" : Math.round(bytes / 1024) + " kB"; }

/* ------------------------------------------------------------------ */
/* sign in                                                             */
/* ------------------------------------------------------------------ */
$("signin").addEventListener("click", async function () {
  var username = $("u").value, password = $("p").value;
  if (!username || !password) { $("loginMsg").className = "msg err"; $("loginMsg").textContent = "Enter username and password."; return; }
  var nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    var res = await fetch("/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: sha256Hex(username + nonce), password: sha256Hex(password + nonce), nonce: nonce }),
    });
    var body = await res.json();
    if (!res.ok || !body.token) throw new Error(body.message || "sign-in failed");
    token = body.token;
    localStorage.setItem(TOKEN_KEY, token);
    log("signed in as operator");
    show(true);
    await refresh();
  } catch (error) {
    $("loginMsg").className = "msg err";
    $("loginMsg").textContent = error.message;
  }
});
$("logout").addEventListener("click", function () {
  token = ""; localStorage.removeItem(TOKEN_KEY); show(false); log("signed out");
});

/* ------------------------------------------------------------------ */
/* refresh                                                             */
/* ------------------------------------------------------------------ */
async function refresh() {
  var data = await api("/api/firmware");
  var devices = data.devices || [];
  var targets = (data.targets || []);
  $("targets").innerHTML = targets.map(function (t) { return "<option value='" + esc(t.target) + "'>"; }).join("");

  $("devices").innerHTML = devices.length ? devices.map(function (d) {
    var state = d.online ? "<span class='pill on'>ONLINE</span>" : "<span class='pill off'>OFFLINE</span>";
    return "<tr><td><code>" + esc(d.deviceId) + "</code></td><td>" + esc(d.role || "—") + "</td><td>" +
      (d.fwTarget ? "<code>" + esc(d.fwTarget) + "</code>" : "<span class='pill warn'>unknown — flash once over USB</span>") + "</td><td>" +
      esc(d.firmware || "—") + "</td><td>" + state + "</td><td>" + (d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "—") + "</td></tr>";
  }).join("") : "<tr><td colspan='6'>No board has announced itself yet.</td></tr>";
  $("deviceNote").textContent = data.enabled
    ? "A board that is offline right now still gets the update: the server keeps the request queued and sends it the moment the board reconnects."
    : "OTA is switched off on this server (FIRMWARE_OTA_ENABLED=0).";

  var rows = [];
  targets.forEach(function (t) {
    (t.builds || []).forEach(function (b, index) {
      var pending = t.pending && t.pending.version === b.version;
      rows.push("<tr><td><code>" + esc(t.target) + "</code></td><td>" + esc(b.version) +
        (index === 0 ? " <span class='pill on'>newest</span>" : "") + "</td><td>" + prettySize(b.size) +
        "</td><td><code>" + esc(String(b.md5).slice(0, 12)) + "…</code></td><td>" + new Date(b.uploadedAt).toLocaleString() +
        "</td><td>" + (pending ? "<span class='pill warn'>QUEUED — waiting for the board</span>" : "<span class='pill off'>—</span>") +
        "</td><td style='white-space:nowrap'><button data-target='" + esc(t.target) + "' data-version='" + esc(b.version) + "' class='update'>Update boards</button> " +
        "<button data-target='" + esc(t.target) + "' data-version='" + esc(b.version) + "' class='ghost danger remove'>Delete</button></td></tr>");
    });
  });
  $("builds").innerHTML = rows.length ? rows.join("") :
    "<tr><td colspan='7'>Nothing uploaded yet — upload the .bin your Arduino IDE / PlatformIO build produced.</td></tr>";

  document.querySelectorAll("button.update").forEach(function (button) {
    button.addEventListener("click", async function () {
      button.disabled = true;
      try {
        var target = button.getAttribute("data-target"), version = button.getAttribute("data-version");
        var out = await api("/api/firmware/update", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: target, version: version }),
        });
        var sent = (out.sent || []).length;
        say("updateMsg", sent
          ? "Update queued and sent to " + sent + " online board(s): " + (out.sent || []).join(", ") + ". Offline boards of this target get it when they reconnect."
          : "Update queued. No board of " + target + " is online right now — it will be sent as soon as one reconnects.", true);
        log("queued " + target + "@" + version + " → sent to " + sent + " board(s)");
        await refresh();
      } catch (error) {
        say("updateMsg", error.message, false);
      } finally { button.disabled = false; }
    });
  });
  document.querySelectorAll("button.remove").forEach(function (button) {
    button.addEventListener("click", async function () {
      var target = button.getAttribute("data-target"), version = button.getAttribute("data-version");
      if (!confirm("Delete " + target + " " + version + " from this server?")) return;
      try {
        await api("/api/firmware/" + encodeURIComponent(target) + "/" + encodeURIComponent(version), { method: "DELETE" });
        log("deleted " + target + "@" + version);
        await refresh();
      } catch (error) { say("updateMsg", error.message, false); }
    });
  });
}

$("upload").addEventListener("click", async function () {
  var file = $("file").files[0];
  var target = $("target").value.trim(), version = $("version").value.trim(), notes = $("notes").value.trim();
  if (!file) { say("uploadMsg", "Choose the .bin file first.", false); return; }
  if (!target || !version) { say("uploadMsg", "Target and version are required.", false); return; }
  var form = new FormData();
  form.append("target", target); form.append("version", version); form.append("notes", notes); form.append("file", file);
  $("upload").disabled = true;
  try {
    var out = await api("/api/firmware", { method: "POST", body: form });
    say("uploadMsg", "Stored " + out.build.target + " " + out.build.version + " (" + prettySize(out.build.size) + ", md5 " + String(out.build.md5).slice(0, 12) + "…). Press Update in the table below to send it.", true);
    log("uploaded " + target + "@" + version + " (" + prettySize(out.build.size) + ")");
    $("file").value = "";
    await refresh();
  } catch (error) {
    say("uploadMsg", error.message, false);
  } finally { $("upload").disabled = false; }
});

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
if (token) {
  show(true);
  refresh().catch(function (error) { log("refresh failed: " + error.message); });
  setInterval(function () { refresh().catch(function () { }); }, 5000);
} else {
  show(false);
}
</script>
</body>
</html>
`;
