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
- **Centralized error handling** with environment-aware error messages.
- Written in **TypeScript** with a class-based, chainable server setup.

---

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

---

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
