# Xianyu Monitor

[中文 README](README.zh-CN.md)

An open-source monitoring workspace for public Goofish (Xianyu) listings and seller data. The project combines a local Electron collector, user and admin web applications, and cloud APIs for search monitoring, competitor seller tracking, market data, silent uploads, and AI-assisted analysis.

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" />
  <img src="https://img.shields.io/badge/TypeScript-5.9-blue.svg" alt="TypeScript 5.9" />
  <img src="https://img.shields.io/badge/Electron-43-47848F.svg" alt="Electron 43" />
</p>

## Screenshots

| User dashboard | My monitors |
| --- | --- |
| ![User dashboard](screenshots/user-dashboard.png) | ![My monitors](screenshots/user-monitors.png) |

## Features

### Local collector

- Windows Electron client for system-account login, device binding, and collection control.
- Uses a dedicated local Chrome profile for Xianyu login. Xianyu cookies, tokens, and browser profiles are not uploaded to the cloud.
- Search monitoring rules support keywords, categories, sorting, price ranges, regions, inclusion terms, and exclusion terms.
- Public seller monitoring records public listings, new listings, price changes, delistings, sold states, and seller-profile changes.
- Local SQLite stores tasks, logs, cache data, and an outbox for retrying uploads after a network outage.
- System-tray operation supports hiding, starting, pausing, and exiting the collector.

### User Web

The standalone React/Vite user application includes:

- Dashboard
- My Monitors
- Competitor Sellers
- Market Items
- Market Discovery
- Event Center
- Activity Log
- AI Analysis
- Settings

It uses demo data by default and can connect to the User API when configured.

### Admin Web

The Admin Web application has its own login and API. It provides operations overview, user and device management, plans and usage, market data, upload batches, AI configuration, queue capacity, and audit views.

### Cloud services

The cloud process starts three Fastify APIs:

| Service | Default port | Purpose |
| --- | ---: | --- |
| User API | `3101` | User accounts, monitoring tasks, market data, and AI results |
| Admin API | `3102` | Users, devices, plans, data quality, AI, and auditing |
| Collector API | `3103` | Device heartbeats, task sync, collection batches, and silent uploads |

The cloud services use PostgreSQL. Database migrations are in [`infra/postgres/migrations`](infra/postgres/migrations). User, admin, and collector access use separate authentication domains and token settings.

## Architecture

```text
Public Xianyu pages
        │
        ▼
Local Chrome + Electron collector
        │ task sync / heartbeat / silent upload
        ▼
Collector API ───── PostgreSQL ───── User API ───── User Web
        │                  │
        └──────────── Admin API ───── Admin Web
                           │
                       AI Worker
```

The local collector and cloud workspace are separate deployment units. The cloud services do not log in to Xianyu directly, and the user-facing application does not expose upload controls, upload batches, or cloud AI keys.

## Technology stack

- TypeScript
- Electron 43 + electron-vite
- React 19 + Vite
- Fastify 5
- PostgreSQL
- SQLite for local Electron data
- Playwright Core
- PGlite for integration tests

## Quick start

### Requirements

Use a current LTS version of Node.js and npm. Cloud scripts use Node's `--experimental-strip-types`, and the desktop client uses Electron's built-in `node:sqlite`.

Install dependencies:

```bash
npm install
```

### Run the desktop collector

```bash
npm run dev
```

The client can register or sign in to a system account, open local Chrome, bind a device, and start collection. Xianyu login remains in the local Chrome profile.

Build desktop resources:

```bash
npm run build
```

Build a Windows installer:

```bash
npm run package:win
```

### Run the User Web demo

```powershell
Copy-Item apps/user-web/.env.example apps/user-web/.env
npm --prefix apps/user-web install
npm --prefix apps/user-web run dev
```

The default address is `http://127.0.0.1:5174`. `VITE_USER_WEB_MODE=demo` uses local demo data and does not call the cloud API.

### Run the Admin Web demo

```powershell
Copy-Item apps/admin-web/.env.example apps/admin-web/.env
npm --prefix apps/admin-web install
npm --prefix apps/admin-web run dev
```

The default address is `http://127.0.0.1:5175`. `VITE_ADMIN_DEMO_MODE=true` uses local demo data.

### Run the cloud services

The cloud services require PostgreSQL. Create an environment file first:

```powershell
Copy-Item services/cloud/.env.example services/cloud/.env
```

Set the database connection, the three authentication-domain secrets, and the allowed web origins in `services/cloud/.env`. Replace every `*_TOKEN_SECRET` with a random secret of at least 32 bytes; do not use the example values.

Apply the SQL migrations in [`infra/postgres/migrations`](infra/postgres/migrations) in order, then start the services:

```bash
npm run serve:cloud
```

The default API addresses are:

- User API: `http://127.0.0.1:3101`
- Admin API: `http://127.0.0.1:3102`
- Collector API: `http://127.0.0.1:3103`

To connect User Web to the cloud API, set:

```dotenv
VITE_USER_WEB_MODE=api
VITE_USER_API_BASE_URL=http://127.0.0.1:3101
```

To connect Admin Web to the cloud API, set:

```dotenv
VITE_ADMIN_DEMO_MODE=false
VITE_ADMIN_API_BASE_URL=http://127.0.0.1:3102
```

`.env` files are ignored; only `.env.example` files are committed.

## Verification

Common build and type checks:

```bash
npm run build
npm --prefix apps/user-web run build
npm --prefix apps/admin-web run build
npm run check:cloud
```

Selected integration tests:

```bash
npm run test:phase0:contract
npm run test:phase0:stress
npm run test:phase2:cloud
npm run test:phase3:desktop
npm run test:phase5:cloud
npm run test:phase6:cloud
npm run test:phase7:cloud
```

Desktop tests build Electron and use isolated test data and mock APIs. They do not replace acceptance testing with real Xianyu accounts, live networks, production databases, or production deployments.

## Data and privacy boundaries

- Xianyu login state remains in the dedicated Chrome profile on the collector machine.
- The cloud receives only the agreed public listing and seller data, image metadata, snapshots, events, and collection summaries.
- System users, admins, and collector devices belong to separate authentication domains.
- User Web does not expose Admin APIs, upload controls, model keys, or prompt configuration.
- Do not commit `.env` files, real passwords, tokens, cookies, browser profiles, production database backups, or personal data.
- Follow Xianyu platform rules, applicable laws, and data-subject rights. Confirm collection frequency and data usage for your deployment.

## Current boundaries

This repository provides a runnable local client, standalone workspaces, and a cloud API foundation. Production deployment still requires:

- Production domains, TLS, reverse proxy, and CORS configuration
- PostgreSQL high availability, backups, recovery, and migration release procedures
- Object storage, message queues, search services, and capacity scaling
- Production monitoring, alerts, rate limiting, and secret rotation
- Long-running validation with real Xianyu accounts and platform rules
- Full multi-user, multi-device, offline-recovery, and rollback acceptance

Database contracts and phase integration tests are in [`infra/postgres/migrations`](infra/postgres/migrations) and [`tools`](tools).

## Repository layout

```text
apps/
  user-web/                 User Web
  admin-web/                Admin Web
src/
  main/                     Electron main process, collector, and SQLite
  preload/                  Electron IPC boundary
  renderer/                 Electron client UI
  shared/                   Shared types
services/cloud/             User, Admin, Collector APIs, and AI Worker
infra/postgres/migrations/  PostgreSQL migrations
tools/                      Integration and runtime tests
```

## Contact and support

<table border="1" cellpadding="12" cellspacing="0" width="100%">
  <tr>
    <td align="center" width="50%" style="border: 1px solid #d9d9d9; padding: 16px;">
      <strong>WeChat</strong><br />
      <img src="wx.jpg" alt="WeChat contact" width="280" />
    </td>
    <td align="center" width="50%" style="border: 1px solid #d9d9d9; padding: 16px;">
      <strong>Support the project</strong><br />
      <img src="zhanshang.png" alt="Support QR code" width="280" />
    </td>
  </tr>
</table>

## License

This project is released under the [MIT License](LICENSE). You must still follow Xianyu platform rules and applicable laws, and confirm collection frequency and data usage for your deployment.

Please use Issues or Pull Requests for feedback. Redact accounts, cookies, tokens, personal data, and production addresses before sharing diagnostic information.
