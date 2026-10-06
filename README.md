# chrserver — Crop Health Robot Server

Backend server for the **AI Smart Crop Health Monitoring Robot**, a Year 1 / Semester 1
mini project (module **IT1140 – Fundamentals of Computing**) at the
**Sri Lanka Institute of Information Technology (SLIIT)**.

The robot uses an **ESP32‑S3** controller with sensors and an AI camera to monitor crop
and soil conditions, detect plant diseases, and support automated irrigation. This
repository is the **central server** that the robot and client apps talk to. It exposes a
REST API (auth, image upload, robot commands) and a real‑time **Socket.IO** gateway that
relays live messages between the ESP32 and authorized dashboard/mobile clients.

> Project group: **Group 01**, Academic Year 2026.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [Available Scripts](#available-scripts)
- [REST API Reference](#rest-api-reference)
- [Real-Time (Socket.IO) API](#real-time-socketio-api)
<<<<<<< ours
=======
- [Operator safety, owner numbers & per-well moisture](#operator-safety-owner-numbers--per-well-moisture)
>>>>>>> theirs
- [Serving the web app (chrclient web build)](#serving-the-web-app-chrclient-web-build)
- [WhatsApp Service](#whatsapp-service)
- [Where This Fits in the Overall System](#where-this-fits-in-the-overall-system)
- [Known Issues / To Do](#known-issues--to-do)
- [Team](#team)
- [License & Usage](#license--usage)

---

## Features

- **REST API** built on Express 5 for authentication, image upload, and robot control.
- **Real-time messaging** with Socket.IO 4 — bidirectional relay between the ESP32 robot
  and authorized clients (dashboard / mobile app).
- **Role-based socket rooms** — the ESP32 joins a dedicated room so control commands are
  routed only to the robot.
- **Structured logging** with [pino](https://getpino.io) (pretty-printed in development).
- **Image upload validation** — accepts only `png` / `jpg` / `jpeg`, with a 10 MB JSON
  payload limit to accommodate image buffers.
- **WhatsApp control bot** — pair one WhatsApp account with a pairing code and drive the whole
farm from chat (mission deploy, pump on/off, telemetry, alerts). Owner-gated, interactive
button replies, footer on every message.
- **Centralized error handling** with environment-aware error messages.
- Written in **TypeScript** with a class-based, chainable server setup.

---

- **Serves the web dashboard** — the newest `chrclient` web build is fetched from its GitHub release into `public/` at startup and served on `/` (no download at all when the copy on disk is already the newest; the API paths stay untouched).

## Tech Stack

| Layer         | Technology                          |
| ------------- | ----------------------------------- |
| Language      | TypeScript (target ES2016, CommonJS)|
| Runtime       | Node.js                             |
| Web framework | Express 5                           |
| Real-time     | Socket.IO 4                         |
| Logging       | pino + pino-pretty                  |
| Dev tooling   | tsx (watch mode), TypeScript        |

---

## Architecture

```
                           ┌───────────────────────────────┐
   Sensors + AI Camera     │        ESP32-S3 Robot         │
   (soil, DHT22, etc.)     │  (Socket.IO client "esp_32")  │
                           └─────┬─────────────────────────┘
                                 │                   ▲ 
                           esp_32_message            │
                                 │           control_command
                                 ▼                   │
                        ┌───────────────────────────────────────────┐
                        │              chrserver (this)             │
                        │  ┌────────────┐        ┌───────────────┐  │
                        │  │ Express    │        │  Socket.IO    │  │
                        │  │  REST API  │        │  WS gateway   │  │
                        │  │ /auth      │        │  rooms/roles  │  │
                        │  │ /api/...   │        │               │  │
                        │  └────────────┘        └───────────────┘  │
                        └───────────────────────────────────────────┘
                                   ▲                     │
                                   │             broadcast_from_a
                             control_message             │
                                   │                     ▼
                       ┌──────────────────────────────────────────────┐
                       │  Dashboard / Mobile app (role "authorized")  │
                       └──────────────────────────────────────────────┘
```

The server is composed of two cooperating classes:

- **`Server`** (`src/server.ts`) — configures Express middleware, registers REST routes,
  and sets up global error handling.
- **`WSServer`** (`src/sockets/wsserver.ts`) — wraps the Express app in an HTTP server and
  attaches a Socket.IO instance that handles connections by role.

Both are wired together in `src/index.ts`.

---

## Project Structure

```
chrserver/
├── src/
│   ├── index.ts            # Entry point: boots Server + WSServer, sets up logger
│   ├── server.ts           # Express app: middleware, REST routes, error handling
│   ├── sockets/
│   │    └── wsserver.ts   
│   └── models/
│       └── apple          # models will here
├── package.json
├── tsconfig.json
└── .gitignore
```

---

## Getting Started

### Prerequisites

- **Node.js** 18+ (recommended 20+)
- **npm** (ships with Node.js)

### Installation

```bash
# Clone the repository
git clone https://github.com/AlexaInc/chrserver.git
cd chrserver

# Install dependencies
npm install
```

### Run in development

Runs the server with hot reload via `tsx watch`:

```bash
npm run dev
```

You should see:

```
🚀 Server started successfully at http://0.0.0.0:8000
```

### Build for production

```bash
npm run build      # compiles TypeScript to dist/
node dist/index.js # run the compiled server
```

The server listens on **port 8000** and binds to **`0.0.0.0`** by default (see
`src/index.ts`).

---

## Configuration

Configuration is currently minimal and read from environment variables:

| Variable     | Default | Description                                                        |
| ------------ | ------- | ------------------------------------------------------------------ |
| `NODE_ENV`   | —       | Set to `production` to disable pretty logs and hide error details. |
| `LOG_LEVEL`  | `info`  | pino log level (`trace`, `debug`, `info`, `warn`, `error`, ...).   |
| `ROBOT_TOKEN` | — | Dedicated credential for `esp_32` robot devices and image uploads. |
| `PUMP_TOKEN` | — | Different credential for `esp_c3_pump` irrigation controllers. |

> The listening port (`8000`) and host (`0.0.0.0`) are set in `src/index.ts`. To change
> them, edit the `new Server({ port, domain })` call. Moving these to environment
> variables is a good future improvement.

---

## Available Scripts

| Script          | Description                                        |
| --------------- | -------------------------------------------------- |
| `npm run dev`   | Start the server in watch mode with `tsx`.         |
| `npm run build` | Compile TypeScript to JavaScript in `dist/`.       |

---

Regression suites (run them in the repository root):

```bash
npm i --no-save socket.io-client     # test-only dependency
npx tsx chrserver-verify-safety.ts   # robot safety / speed / arc telemetry
npx tsx chrserver-verify-whatsapp.ts # WhatsApp link, commands and footers
npx tsx chrserver-verify-webapp.ts   # web build sync + serving (no network needed)
```


## REST API Reference

Base URL: `http://<host>:8000`

### `POST /auth/login`

Placeholder authentication endpoint. Logs the request body and returns success.

**Response** `200 OK`
```json
{ "ok": true }
```

---

### `POST /api/images/upload`

Accepts a crop image (e.g. captured by the robot's AI camera) as part of the JSON body.
The endpoint validates that a file payload with a supported type and non-empty buffer is
present. Max JSON payload size is **10 MB**.

**Request body**
```json
{
  "file": {
    "type": "image/jpeg",
    "buffer": "<image data>"
  }
}
```

**Responses**

| Status | Condition                                   | Body                                                                     |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------ |
| `200`  | Image received and processed                | `{ "ok": true, "message": "Image uploaded and processed successfully" }` |
| `400`  | Missing `file` payload                       | `{ "ok": false, "error": "Bad Request", "message": "Missing file payload in request body" }` |
| `400`  | Empty buffer                                | `{ "ok": false, "error": "Bad Request", "message": "Buffer is empty" }`  |
| `415`  | Unsupported file type                       | `{ "ok": false, "error": "Unsupported Media Type", "message": "Invalid file type, only support png or jpg" }` |

Supported file types: `image/jpg`, `image/png`, `image/jpeg`.

---

### `POST /api/robot/command`

Accepts a command for the robot and logs it. Placeholder for HTTP-based robot control
(real-time control is available over Socket.IO — see below).

**Response** `200 OK`
```json
{ "ok": true }
```

---

### Error handling

Any unhandled error is caught by the global error handler and returns:

```json
{
  "ok": false,
  "error": "Internal Server Error",
  "message": "An unexpected error occurred"
}
```

In non-production environments, `message` contains the actual error message to aid
debugging.

---

## Real-Time (Socket.IO) API

Clients connect over Socket.IO and identify a **role** either through the connection
`auth` object, a `role` query parameter, or the auth `token`.

```js
// Example client connection
import { io } from "socket.io-client";

const socket = io("http://<host>:8000", {
  auth: { role: "authorized", token: "<token>" },
});
```

### Roles

| Role         | Behavior                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `esp_32`     | Joins the `esp_32_room`. Represents the robot. Sends sensor/status data. |
| `authorized` | A dashboard/mobile client allowed to send control commands to the robot. |
| *(other)*    | Connects as a generic client (no special privileges).                    |

### Events

**From the ESP32 robot (`esp_32` role):**

| Event            | Direction        | Payload                                        | Description                                    |
| ---------------- | ---------------- | ---------------------------------------------- | ---------------------------------------------- |
| `esp_32_message` | client → server  | any                                            | Robot sends sensor readings / status.          |
| `broadcast_from_a` | server → all clients | `{ sender: <socketId>, payload: <data> }` | Server broadcasts the robot's message to all.  |

**From an authorized client (`authorized` role):**

| Event             | Direction        | Payload                                     | Description                                     |
| ----------------- | ---------------- | ------------------------------------------- | ----------------------------------------------- |
| `control_message` | client → server  | any                                         | Client sends a control command.                 |
| `control_command` | server → `esp_32_room` | `{ from: <socketId>, command: <data> }` | Server relays the command only to the robot.    |

**Lifecycle:**

| Event        | Description                        |
| ------------ | --------------------------------- |
| `connection` | A new socket connects.            |
| `disconnect` | A socket disconnects (logged).    |

> CORS for Socket.IO is currently open (`origin: true`) for `GET` and `POST`, suitable for
> development. Tighten this before any public deployment.

### Robot safety, speed limits & the SD field-map cache

The tables above are historical; the live gateway uses two real events:
devices send `message.upsert` (`{ Type, Message }`) and the server sends
`control_command` (`{ command: { action, data } }`) into `esp_32_room` /
`pump_room`. On top of that:

**Field map — downloaded only when it actually changed**

| Step | Who | What |
| ---- | --- | ---- |
| 1 | server | `mapRevision(map)` = sha1 prefix of a key-sorted copy of the stored map, attached as `rev` |
| 2 | robot | caches the map on its SD card (`/chrhw/fieldmap.json` + `.meta`, temp-file + rename) |
| 3 | robot → server | `device_hello` event: `{ deviceId, role, firmware, mapRev, mapBlocks, mapBytes, sd, driveSpeedPercent, turnSpeedPercent, sensorAngleLeftDeg, sensorAngleRightDeg, avoidAssist }` |
| 4 | server | `rev` matches → nothing sent. Mismatch (or no hello within 2.5 s, i.e. older firmware) → `field_map { …map, rev }` |
| 5 | robot → server | `message.upsert { Type: "map_status", Message: { rev, name, blocks, bytes, sd, path, reason } }` (`saved`, `unchanged`, `save_failed`) |

`save_field_map` recomputes the revision and pushes the new map to the rover
immediately. `GET /api/status` → `status.fieldMap` reports
`{ serverRev, robotRev, inSync, blocks, bytes, sd, lastSaveReason }`, which is
what the app shows as *Field map (SD cache) → IN SYNC / NOT SYNCED*.

**Speed limits — the rover can only ever be made slower**

| Action (server → rover) | Payload | Effect |
| ---- | ---- | ---- |
| `motion_config` | `{ driveSpeedPercent, turnSpeedPercent, sensorAngleLeftDeg, sensorAngleRightDeg, avoidAssist }` (speeds 0-100, angles 0-80) | applies + stores on SD; pushed on every connect and on every settings save |
| `set_speed` | `{ percent }` or `{ driveSpeedPercent, turnSpeedPercent, sensorAngleLeftDeg, sensorAngleRightDeg, avoidAssist }` | convenience form, clamped server-side (`clampPercent` / `clampAngle`) |
| `get_motion_status` | — | rover answers with `motion_config` |
| `get_map_status` | — | rover answers with `map_status` |

`FleetConfig` gained `driveSpeedPercent` (default **70**), `turnSpeedPercent`
(default **65**), `sensorAngleLeftDeg` / `sensorAngleRightDeg` (default
**45°** — the printed side brackets) and `avoidAssist` (default **true**);
`apply_config` stores and forwards all of them. 100 % equals the firmware's own
safe cruise PWM (110 of 255 duty) and `MOTION_HARD_MAX_PWM` (150) is a
compile-time ceiling, so a panel value can never make the rover run away. The
angles are how the rover knows where its side beams point: the firmware converts
each side reading into `reading x sin(angle + cone/2)` before it calls a gap
passable, so a re-bolted bracket only needs the number changed.

**Front-arc avoidance — going AROUND a plant is reported as a manoeuvre, not a stop**

The rover steers to the wider side, creeps past at crawl speed and returns to
the mission heading; it only stops when neither side gap is wider than the
chassis (`no-path`) or something is inside the emergency ring. The gateway just
carries that honestly:

| `motion_config.reason` | Meaning | Alert |
| ---- | ---- | ---- |
| `applied` / `unchanged` / `requested` | config ack | — |
| `avoiding` | steering to the wider side (payload has `avoidState`, `avoidDir`, `gapLeftCm`, `gapRightCm`, `frontCm`, `blockedBy`: `plant-left` / `plant-right` / `plant-ahead`) | info |
| `creep` | turned enough, driving past the plant at crawl speed | info |
| `turn-back` / `clear` | swinging back onto the heading / back to normal | — |
| `no-path` | **stopped**: no side gap wide enough to pass | warning |
| `emergency` | something inside the emergency ring | warning |
| `obstacle` | safety-distance stop with the assist switched off | info |
| `failsafe` | no fresh drive command arrived | warning |

State changes only — the firmware never reports once per scan, so an avoiding
manoeuvre produces one info alert, not a stream. `RobotStatus.motion` carries
the same fields (`avoidState`, `avoidDir`, `gapLeftCm`, `gapRightCm`, `frontCm`,
`sensorAngleLeftDeg`, `sensorAngleRightDeg`, `avoidAssist`) next to the PWM
values, which is what the app's Controller screen renders as
*"Going around a plant — steering right (26 cm ahead · gaps 20 cm left /
48 cm right)"*.

**Safety telemetry**

The rover acks every speed change and reports self-protection events as
`message.upsert { Type: "motion_config" }` with `reason: "applied" | "obstacle" |
"failsafe" | "unchanged"`, plus the live `appliedPwm`, `intent`, `source`,
`blockedBy` and `obstacleStopCm`. `RobotStatus.motion` exposes them next to the
operator's configured limits, an obstacle stop raises an *info* alert and a
dead-man failsafe cut raises a *warning* alert, so the operator learns why the
rover stopped instead of guessing.

> Regression suite (the two files are in this repository):
>
> ```bash
> npm i --no-save socket.io-client      # test-only dependency, not shipped
> npx tsx chrserver-verify-safety.ts    # 30 checks: robot safety / map / arc
> npx tsx chrserver-verify-whatsapp.ts  # 25 checks: WhatsApp link / commands / footer
> ```
>
> Both boot the real gateway against a temporary SQLite file and talk to it with
> fake sockets — no robot, no pump and no WhatsApp account needed.
>
> `npx tsx chrserver-verify-safety.ts` — 30 checks covering
> the revision handshake, the legacy path, clamping (speeds **and** angles),
> forwarding, the avoidance/manoeuvre alerts, and the status payload, with no
> hardware and no WhatsApp connection needed.

---

## WhatsApp Service

One WhatsApp account is paired to the server with a **pairing code** (no QR scan) and then
controls the farm from a chat. Everything the bot does goes through the same entry points the
dashboard uses (`WSServer.deployMission` / `setRobotMode` / `controlRobot` / `controlPump`), so
online checks, route planning limits and audit behaviour are identical.

> Implementation: [`src/services/WhatsAppService.ts`](src/services/WhatsAppService.ts) ·
> owner number + link state live in the `settings` table (`whatsapp` key, see
> [`db/Sqlight.ts`](db/Sqlight.ts) → `WhatsAppSettings`).

### Pairing from the app (Settings → **WhatsApp Service**)

The client card calls these authorized endpoints (`Authorization: Bearer <token>`):

| Method | Route                    | Purpose                                                                 |
| ------ | ------------------------ | ----------------------------------------------------------------------- |
| `GET`  | `/api/whatsapp`          | current state: `disabled / idle / pairing / connected`, numbers, pairing code |
| `POST` | `/api/whatsapp/link`     | `{ "number": "94766045156" }` → pair that account, returns the pairing code |
| `POST` | `/api/whatsapp/relink`   | delete the current session and pair a different account                 |
| `POST` | `/api/whatsapp/enabled`  | `{ "enabled": true\|false }` → the bot's ON/OFF switch (OFF stops the socket, keeps the session) |
| `POST` | `/api/whatsapp/unlink`   | **delete the session** (signs the account out); keeps the owner number   |
| `POST` | `/api/whatsapp/owner`    | `{ "number": "94766045156" }` → save the commander number                |
| `POST` | `/api/whatsapp/test`     | send a test message to the owner number                                  |

`GET /api/whatsapp` also reports `sessionHealth` — `active` (connected), `inactive`
(session saved, bot switched off), `invalid` (the account was logged out, link it again) or
`not_linked` — which is what the app's Settings card shows next to the ON/OFF switch.

Numbers are stored in E.164 **digital** form — country code included, no `+`, no spaces
(Sri Lanka `076 604 5156` → `94766045156`). Local formats are rejected on purpose: without a
country code the bot can never reach that chat. On the first link the owner number defaults to
the number you paired, and it can be changed at any time in the app or with `.owner set …`.

### Chat commands (owner only)

| Chat command                                        | What it does                                                  |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `.menu` / `.help`                                   | command menu with quick replies + list buttons                 |
| `.status` (`.rs`, `.robot`)                          | robot online/offline, mode, mission progress, last sensor tick, pump, alert count |
| `.telemetry` (`.tlm`)                                | temperature, humidity, rain, ultrasonic, soil moisture, GPS    |
| `.mission`                                           | pick a block (list buttons) → **deploy mission**               |
| `.mission deploy <blockId\|all>` / `.mission_status` | deploy a route / show progress                                |
| `.mission_pause` / `.mission_resume`                 | manual (paused) / autonomous patrol                            |
| `.stop`                                             | emergency stop: halt movement + pause the patrol               |
| `.photo`                                            | ask the rover for a photo                                      |
| `.pump` / `.pump_on 60` / `.pump_off`                | **water pump** control (duration in seconds)                   |
| `.pump_auto on\|off` / `.pump_status` / `.pump_stop` | auto-irrigation mode, live state, abort a run                 |
| `.pump threshold 45` / `.pump irrigate <block> 120`  | moisture threshold / irrigate one block                        |
| `.alerts` · `.reports` · `.blocks`                   | last alerts · latest analysis report · field blocks             |
| `.bot on\|off`                                        | start/stop this WhatsApp service (session is kept when off)     |
| `.session` · `.owner` · `.owner set 94XXXXXXXXX`      | bot + session health · owner number                             |
| `.owners` / `.owners add\|remove 94XXXXXXXXX`         | **all** owner numbers (up to 10, stored in the DB)              |
| `.pump threshold 40 \[pumpId\]`                      | moisture threshold for one well (or the whole farm)              |
| `.rain` / `.rain clear` · `.fuel` / `.fuel refilled`  | rain latch · tank-empty report (and clearing it)                 |
| `.safety`                                            | rain latch, tank state, well thresholds at a glance              |

Replies are native-flow interactive messages whose buttons are **derived from the live state**
(`pumpButtons()` / `missionButtons()` in `WhatsAppService.ts`): while the pump runs you are
offered *Pump OFF* and never another *Pump ON*; a loaded-but-paused mission offers
*Resume* + *Stop*; nothing loaded offers *Deploy*; an offline robot offers only *Status* — so
the same card is correct in every situation instead of showing a hardcoded on/off pair. A
`single_select` list carries the full menu and a `cta_url` wall shows the support contacts to
anyone who is *not* the owner. Button taps arrive as
`buttonsResponseMessage` / `listResponseMessage` / `templateButtonReplyMessage` /
`interactiveResponseMessage` and are normalised back into commands, so tapping behaves exactly
like typing. **Every** outgoing message carries the footer `Powered by hazu@AlexaInc.github.io`
in the message's **native footer field** (never glued into the body); the footer only falls
back into the text for the rare plain-text fallback when a client refuses the interactive payload.

Optional environment variables:

| Variable             | Default     | Purpose                                                           |
| -------------------- | ----------- | ----------------------------------------------------------------- |
| `WA_SESSION_DIR`      | `wasession` | multi-file auth state folder                                       |
| `WA_QUICK_REPLY`      | `true`      | set to `false` to send list buttons instead of quick replies       |
| `WA_BRAND_IMAGE_URL`  | *(empty)*   | public https image used as the header of interactive cards         |

---

<<<<<<< ours
=======
## Operator safety, owner numbers & per-well moisture

### Rain and fuel — the server reacts, it does not just report

| Trigger (app, robot or WhatsApp) | What chrserver does |
| --- | --- |
| rain drop detected — `report_rain` / `.rain` | **pump OFF**, `return_to_base` sent to the rover, every owner number alerted, the rain latch is set |
| rain cleared — `rain_clear` / `.rain clear` | latch released, auto-irrigation is allowed again |
| tank empty — `report_fuel_empty` / `.fuel` | owners get the fuel report (run minutes + note), `deploy_mission` is refused until refilled |
| refilled — `fuel_refilled` / `.fuel refilled` | missions are allowed again |

The rain decision uses `RAIN_THRESHOLD_PERCENT` (default **60 %**) with 15 % hysteresis, and a
`RAIN_SEQUENCE_THROTTLE_MS` (5 min) throttle so one shower cannot turn into a storm of
messages. Repeat alerts do not stack: `raiseAlert` supersedes the previous one with the same
title (`db.acknowledgeSuperseded`). The whole state is kept in `safetyState` and reported by
`GET /api/safety`; `POST /api/safety/rain`, `/api/safety/fuel-empty` and `/api/safety/fuel-refilled`
drive it from outside the socket.

### Owner numbers — up to ten, in the database

`ownerNumbers: string[]` replaces the old single number (a stored single number is migrated on
read), duplicates are dropped, and the list can hold at most `MAX_OWNER_NUMBERS = 10` and can
never be emptied from the app. `.owners` lists them, `.owners add|remove <number>` (or
`.owners set a,b,c`) edits them from chat, and the app uses
`POST /api/whatsapp/owners` / `/api/whatsapp/owners/remove` / `/api/whatsapp/owners/set`.
Every alert in this section goes to **all** of them.

### Moisture threshold per well

`set_irrigation_threshold` now carries a target as well as a percentage —
`wellThresholds` is keyed by `pumpId`, `block:<blockId>` or `default`, so each pump/block can be
tuned separately; `.pump threshold 40 <pumpId>` does the same from chat. Note what the UI repeats:
**the rover has no soil-moisture sensor — only the water pump does**, so a threshold only ever
matches readings that came from a pump.

### Stop points and app updates

* The field map accepts a `stopPoints` list (`FieldStopPoint { id, label, latitude, longitude, order? }`,
  at most 200 per block) — the places where the robot must stop while scanning. They are stored
  with the block, so re-mapping a block reuses the same points.
* `GET /api/app/release` returns the newest `chrclient` release for the in-app updater
  (`UPDATE_REPO`, `UPDATE_TAG`, `GITHUB_API_BASE`, `GITHUB_TOKEN` override the defaults). The
  request asks for the release **tag** first: this project publishes its rolling build under the
  tag literally named `latest`, so GitHub has no “latest release” for it and
  `releases/latest` alone answers 404.

Run the regression suites in the repository root:

```bash
npm i --no-save socket.io-client
npx tsx chrserver-verify-task7.ts   # rain/fuel safety, owner numbers, thresholds, stop points, updater
```

---

>>>>>>> theirs
## Serving the web app (chrclient web build)

`AlexaInc/chrserver` also publishes the **web version of the dashboard**, so
`https://<your-domain>/` opens the same app the phone runs — no separate web
host, and the operator never has to copy a build anywhere.

**What happens at startup**

| Step | What the server does |
| ---- | ---- |
| 1 | asks GitHub for the release tag `latest` of `AlexaInc/chrclient` (`GET /repos/AlexaInc/chrclient/releases/tags/latest`) |
| 2 | fingerprints the `chrclient-web*.zip` asset by `asset.id + size + updated_at` |
| 3 | **fingerprint already on disk → nothing is downloaded**; the existing `public/` folder is served as it is |
| 4 | fingerprint differs (a new build was pushed) → downloads the asset, verifies `sha256` against GitHub's `digest`, unpacks it next to the live folder and swaps it in atomically |
| 5 | GitHub unreachable → the last good build keeps being served, and the reason is reported (never a blank page) |

Startup is never blocked: the server answers requests immediately and serves
whatever build is already in `public/` while the check runs in the background.

**URLs**

| URL | What it is |
| --- | --- |
| `/` (+ any path such as `/robot`) | the web app (SPA deep links fall back to `index.html`) |
| `/api/webapp` | release/status JSON: `serving`, `tag`, `assetName`, `sha256`, `downloadedAt`, `lastResult`, `lastError`, `checks`, `downloads` (client login required) |
| `POST /api/webapp/refresh` | force a check; `?force=1` re-downloads even when the fingerprint matches (client login required) |
| `/health` | now includes `webApp: { serving, release, asset, downloadedAt, lastResult, lastCheckAt }` (public) |

`/api`, `/auth`, `/health` and `/socket.io` are never swallowed by the web app —
the static mount is registered last and skips those prefixes, so a typo like
`/api/does-not-exist` still answers **404** instead of serving HTML.

**Settings** (`.env`, all optional apart from the defaults):

```env
WEBAPP_ENABLED=true                 # false = serve whatever is in public/, never check
WEBAPP_REPO=AlexaInc/chrclient      # where the web build is published
WEBAPP_RELEASE_TAG=latest           # the rolling release the CI keeps replacing
WEBAPP_ROOT=public                  # folder that gets served
WEBAPP_STATE_DIR=.webapp            # release.json (fingerprint) + unpack staging
WEBAPP_CHECK_INTERVAL_MS=0          # 0 = startup only, e.g. 3600000 = hourly
GITHUB_TOKEN=                       # only needed for a private app repository
WEBAPP_API_BASE=https://api.github.com   # override for tests / a GitHub proxy
```

`public/` and `.webapp/` are runtime folders and are git-ignored — the web build
is fetched from the release, never committed.

**Caching:** files under `/_expo/static/` and `/assets/` have content-hashed
names and are served `immutable` for a year; `index.html` is sent `no-cache`, so
after a new release a browser refresh is all it takes.

> Regression suite: `npx tsx chrserver-verify-webapp.ts` — 49 checks against a
> fake GitHub API and a real zip: download-once, no-download-when-current,
> atomic swap, offline fallback, checksum / zip-slip / missing-index guards and
> the express mount (deep links, cache headers, API paths untouched).

## Where This Fits in the Overall System

This backend is one component of the larger **AI Smart Crop Health Monitoring Robot**:

- **Robot (ESP32‑S3)** — collects soil moisture, pH, EC, temperature/humidity (DHT22),
  light (BH1750), rainfall, GPS, and crop images (OV5640 AI camera); performs edge AI
  disease detection and automated irrigation (water pump + solenoid valve).
- **This server (chrserver)** — receives images and telemetry, relays real-time messages,
  and forwards control commands to the robot.
- **Cloud / AI analysis** — (planned) stores sensor/image/alert data and runs disease
  classification (e.g. MobileNetV3 / TensorFlow Lite) for issues like leaf spot, powdery
  mildew, rust, blight, yellow mosaic, and nutrient deficiency.
- **Dashboard / mobile app** — (planned, Flutter / React Native) lets farmers view
  readings, receive alerts, and send commands.

---

## Known Issues / To Do

- **Port binding:** `src/index.ts` starts the Express server (`server.start()`) *and* the
  Socket.IO HTTP server (`wsServer.listen(server.port)`) on the **same port (8000)** using
  two separate HTTP servers. This can cause an `EADDRINUSE` error. Consider having the
  Socket.IO gateway attach to a single shared HTTP server instead of calling
  `server.start()` separately.
- **Authentication** is a placeholder — `/auth/login` accepts anything. Implement real
  credential checks and token issuance/verification.
- **Image handling** validates but does not yet persist images (no storage/cloud upload).
- **Configurable port/host** via environment variables.
- **Restrict CORS** origins for production.
- Add automated tests.

---

## Team

**Group 01 — SLIIT, BSc (Hons) in Information Technology (IT Late Intake July, Kurunegala)**

Maintained and written by **Hansaka (Alexainc)**.

| Role                | Member                                                                                                                    |
| ------------------- |---------------------------------------------------------------------------------------------------------------------------|
| 💻 **Development**  | Hansaka [IT26101404]  — [github.com/AlexaInc](https://github.com/AlexaInc) · [github.com/it26101404](https://github.com/it26101404) |

**Full team:**

| IT Number   | Name                    |
| ----------- | ----------------------- |
| IT26101404  | P.G. Hansaka Rasanjana  |
| IT26101824  | T.D. Avishka Dewinda    |
| IT26101774  | P.G. Amalka Sandanayani |
| IT26102072  | N.D. Maddumage          |
| IT26100283  | M.K.M. Raamy Khaleel    |

---

## License & Usage

**© 2026 Group 01 (SLIIT IT Late Intake July, Kurunegala). All rights reserved.**

This project — including its concept, idea, design, and source code — is the original work
and intellectual property of Group 01. It is **not** open source and is **not** released
under any permissive license (no MIT, Apache, or similar).

**You may:**

- View and inspect the code and **architecture** for **educational and reference purposes only**.

**You may NOT:**

- Use, copy, reuse, or redistribute this project or any part of it for **commercial use**.
- Use it for **any other purpose** beyond educational inspection.
- Reproduce, adapt, or build upon the **underlying idea/concept** — the idea is not open to
  everyone and remains the exclusive property of the authors.
- Claim, submit, or present this work (or the idea behind it) as your own.

Any use beyond educational inspection of the architecture requires the **prior written
permission** of the project authors.
