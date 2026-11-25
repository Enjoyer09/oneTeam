# oneTeam — Retail Shelf Monitoring Platform (FMCG / oneTeam Retail Distribution)

![oneTeam Logo](./logo.jpg)

**oneTeam** is a retail shelf-monitoring and planogram-compliance platform for
FMCG operations (oneTeam Retail distribution across chains such as Bravo, Araz,
Bazarstore and Rahat). Supervisors dispatch merchandising tasks and planograms
to stores; field merchandisers submit shelf-audit photos and telemetry from a
Telegram bot or an iOS app; supervisors review and approve them from a web
portal.

> **Architecture note (read this if you knew the old README).** oneTeam is
> **not** a Supabase / BaaS application. Every client talks to a first-party
> **NestJS API** (`apps/api`). Supabase — PostgREST, Supabase Auth/Storage, RLS
> — has been fully removed; nothing reads `SUPABASE_*`. The database is plain
> **PostgreSQL 16**.

---

## Architecture

```
        ┌─────────────┐   ┌─────────────┐   ┌──────────────┐
        │  Web portal │   │ Telegram bot│   │  iOS mobile  │
        │  (React/Vite)│  │  (grammY)   │   │  (Expo/RN)   │
        └──────┬──────┘   └──────┬──────┘   └──────┬───────┘
               │ HTTPS /api/*    │ HTTPS /api/*    │ HTTPS /api/*
               └─────────────────┼─────────────────┘
                                 ▼
                    ┌───────────────────────────┐
                    │   NestJS Core API (apps/api)│
                    │   in-memory replica +       │
                    │   write-through persistence │
                    └──────────────┬──────────────┘
                                   ▼
                        ┌────────────────────┐
                        │   PostgreSQL 16     │
                        │   db/api-schema.sql │
                        │   db/migrations/*   │
                        └────────────────────┘
```

- **The API is the only component that touches the database.** The web portal,
  the bot and the mobile app are all API clients — none of them opens a database
  connection of its own.
- **In-memory-first with write-through.** On start-up the API hydrates in-memory
  arrays from PostgreSQL; reads are served from that snapshot, and every mutation
  is written through to the database. If more than one API replica runs, a poll
  of a change counter (`ONETEAM_REFRESH_MS`) bounds how stale a replica can be.
- **Self-applying schema.** On boot the API applies `db/api-schema.sql` and every
  file in `db/migrations/*.sql` through a transactional migration runner
  (`packages/database/src/migrations.ts`), tracked in a `schema_migrations`
  table. A fresh managed database becomes usable without a manual migration step.
- **Runs without a database too.** With `DATABASE_URL` unset the API serves its
  built-in in-memory seed — which is what the local demo and the `test:all`
  suite use. `GET /api/health` reports which persistence mode is active.

---

## Repository layout

```
oneTeam/
├── apps/api/                 # NestJS Core API — the only DB client
│   ├── src/modules/          #   health, tasks, portal, evidences, storage, notifications
│   ├── src/common/auth/      #   bearer-token AuthGuard (see "Authentication")
│   ├── test/*.spec.ts        #   DB-backed HTTP integration suites (test:live)
│   └── Dockerfile            #   multi-stage production image
├── packages/
│   ├── types/                # @oneteam/types — shared domain types
│   └── database/             # @oneteam/database — replica, write-through, migration runner
├── src/                      # Telegram bot worker (grammY)
│   ├── bot/                  #   entrypoint, router, handlers, session storage
│   └── services/             #   API client used by the bot
├── web/                      # Supervisor web portal (React + Vite + Tailwind); own lockfile
├── mobile/                   # iOS field client (Expo / React Native); own lockfile
├── db/
│   ├── api-schema.sql        # API schema (the schema the API actually uses)
│   ├── api-seed.sql          # Seed rows (users, region, stores, campaign, tasks)
│   └── migrations/*.sql      # Ordered migrations applied at boot
├── scripts/
│   ├── ops/db-backup.sh      # pg_dump backup with retention
│   ├── dev/                  # break detectors, mobile/ios helpers
│   └── quality/              # secret scanner, UI-test-id guard
├── docker-compose.prod.yml   # Postgres + API + web + bot
├── Dockerfile.bot            # bot worker image (multi-stage)
├── Dockerfile.postgres       # Postgres image that seeds schema+data on first boot
└── .github/workflows/        # ci, codeql, deploy
```

> `init_schema.sql` / `seed.sql` / the `supabase/` tree describe the **old**
> Supabase product (profiles / tasks / submissions with RLS). They are kept for
> history only; the API does not use them, and they cannot share a database with
> `db/api-schema.sql` (both define an incompatible `stores` table).

---

## Prerequisites

- **Node.js 22** (pinned in `.nvmrc`). `nvm use` picks it up.
- **npm** (the repo uses npm workspaces for `apps/*` and `packages/*`).
- **PostgreSQL 16** — optional for local dev (the API falls back to in-memory),
  required for `test:live` and production. Docker is the easy way to get one.
- **Xcode + CocoaPods** — only to build/run the iOS mobile client.

---

## Install

`web` and `mobile` are **not** workspace members (each has its own lockfile), so
they are installed separately.

```bash
nvm use                 # Node 22
npm ci                  # root workspaces: apps/api, packages/*, the bot
cd web && npm ci && cd ..     # web portal (only if you work on it)
cd mobile && npm ci && cd ..  # mobile client (only if you work on it)
```

---

## Environment variables

Copy `.env.example` to `.env` (local) or `.env.production.example` to
`.env.production` (deploy) and fill in values. Names only below — never commit
real secrets; the platform dashboard is the place for them.

| Variable                    | Used by     | Purpose                                                                          |
| --------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`              | API, bot    | PostgreSQL connection string. Empty ⇒ API runs on in-memory seed.                |
| `NODE_ENV`                  | all         | `development` / `production`.                                                    |
| `PORT` / `API_PORT`         | API         | API listen port (defaults to 3001; `PORT` wins).                                 |
| `TELEGRAM_BOT_TOKEN`        | API, bot    | Bot token from @BotFather. Treat as a password.                                  |
| `TELEGRAM_WEBHOOK_SECRET`   | API         | Verifies inbound Telegram webhooks; API returns 503 for webhooks if unset.       |
| `ONETEAM_API_URL`           | bot         | Where the bot finds the API (`http://localhost:3001` locally).                   |
| `ONETEAM_API_TOKEN`         | bot         | Bot's service credential, `oneteam-user:<userId>` form.                          |
| `CORS_ALLOWED_ORIGINS`      | API         | Comma-separated exact origins. No `*`. Empty ⇒ no browser origin allowed.        |
| `VITE_API_BASE_URL`         | web (build) | Baked into the SPA at build time. Empty ⇒ portal calls `/api` on its own origin. |
| `GEOFENCE_RADIUS_METERS`    | API/mobile  | Anti-fraud geofence radius (default 100).                                        |
| `STORAGE_DRIVER` + `S3_*`   | API         | Optional. `s3` uploads photos to a bucket; default stores them inline.           |
| `ONETEAM_ENROLLMENT_SECRET` | API         | Optional. Turns a store code into username+password for device enrolment.        |
| `ONETEAM_AUTO_MIGRATE`      | API         | `1` (default) applies schema+migrations on boot; `0` to manage manually.         |
| `ONETEAM_REFRESH_MS`        | API         | Replica staleness poll interval; `0` disables (single-replica only).             |

---

## Running

### Everything at once (local demo)

```bash
npm start        # builds+starts the API, then the web portal and the bot
```

### Individually

```bash
# Core API (compiled, NestJS)
npm run api:dev              # build + start on :3001
#   or: npm run api:build && npm run api:start

# Telegram bot worker (grammY) — needs the API reachable at ONETEAM_API_URL
npm run bot

# Web portal (Vite dev server)
npm run web:dev              # from ./web deps; build with: npm run web:build

# iOS mobile client (device/simulator; needs Xcode)
npm run mobile:ios
npm run mobile:config        # static config guard (no Expo tree needed)
npm run mobile:check         # mobile type-check
```

The API exposes routes under `/api/*`: `api/health`, `api/tasks`,
`api/portal`, `api/portal/field`, `api/panel`, `api/evidences`, `api/webhooks`.
The bot handles `/start`, `/tasks`, `/mystatus`, `/help`.

---

## Authentication

The API uses **bearer tokens**, distinguished by prefix — each carries different
authority (`apps/api/src/common/auth/auth.guard.ts`):

- `oneteam-user:<userId>` — **service credential.** Names the user the caller
  acts as. The bot holds one and identifies the real person by Telegram chat id;
  nginx injects one at the edge for the panel before any panel key exists.
- `otd_<random>` — **device credential.** A mobile install enrols with its
  store code and is issued one; it resolves to exactly one user.
- `otp_<random>` — **panel key.** A supervisor's own key. Once any panel key
  exists, the edge service credential is **refused** on the supervisor routes, so
  the login becomes the only door.

There is no Supabase Auth and no RLS; authorisation is enforced in the API guard.

---

## Testing

```bash
npm run test:all     # in-memory tier: secrets, API core/phase2/storage, AI, mobile units
npm run test:live    # DB-backed HTTP suites — needs a running API + PostgreSQL
npm run quality      # format:check + mobile guards + lint + type-check + test:all
```

- **`test:all`** opens no sockets — it is the fast, in-memory tier the `test` CI
  job runs.
- **`test:live`** drives a compiled API over HTTP against a real PostgreSQL
  (panel/stores/tasks/roles/device/revoke/replica/flow/notify/router + bot/web/
  mobile). Provide `DATABASE_URL` and start the API first (`npm run api:dev`);
  some suites spawn their own API on their own port. The CI `live-tests` job
  wires this up against a Postgres service container.
- **Break detectors** (`npm run test:break`, `test:break:credentials`,
  `test:break:device-revoke`) prove the suites still bite: each reintroduces a
  defect and insists the matching check goes red. They write to source files and
  restore them, so they are kept out of `quality` on purpose.

---

## Docker & deployment

### Local / self-hosted stack

```bash
cp .env.production.example .env.production   # fill in required secrets
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

Four services: `postgres`, `api`, `web`, `bot`. Compose refuses to start without
`POSTGRES_PASSWORD`, `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_WEBHOOK_SECRET` (no insecure defaults). The Postgres port is **not**
published to the host by default; each service has memory/CPU caps. Images run as
non-root where the runtime allows it.

Images:

| Image              | Dockerfile            | Notes                                                       |
| ------------------ | --------------------- | ----------------------------------------------------------- |
| API                | `apps/api/Dockerfile` | multi-stage; runs as `node`; ships `db/`                    |
| Bot                | `Dockerfile.bot`      | multi-stage; compiled JS, `--omit=dev`, `node`              |
| Web                | `web/Dockerfile`      | Vite build → nginx; workers run as `nginx`                  |
| Postgres (seeding) | `Dockerfile.postgres` | seeds `db/api-schema.sql` + `db/api-seed.sql` on first boot |

### Managed platform (Railway)

The deploy target is **Railway** with managed PostgreSQL (no in-repo Railway
config). On a managed database the API's boot-time migration runner is the only
mechanism that creates the schema — `ONETEAM_AUTO_MIGRATE` defaults on precisely
for this. Point the bot at the API over the private network
(`ONETEAM_API_URL=http://api.railway.internal:3001`).

### CI / CD

GitHub Actions under `.github/workflows/`:

- **`ci.yml`** — verify (secrets/types/lint/format), test (`test:all`), build
  (web bundle), UI tests (iOS), a non-blocking dependency `audit`, and a gated
  DB-backed `live-tests` job (Postgres service + `test:live` + break detectors).
- **`codeql.yml`** — CodeQL static analysis (javascript-typescript), push/PR to
  main + weekly.
- **`deploy.yml`** — builds the API/bot/web images and pushes them to GHCR on
  push to `main` and on `v*` tags. The Railway release step is a documented,
  commented-out block gated on a `RAILWAY_TOKEN` secret.

> Nightly database backups are **not** a GitHub Actions job. The production
> database is a Railway service on a private network, unreachable from hosted
> runners, so backups run as a **Railway cron service** (`db-backup`, image
> `scripts/ops/Dockerfile.backup`) that runs `scripts/ops/db-backup.sh` at
> 03:00 UTC and uploads the dump to object storage. See `docs/BACKUP-RESTORE.md`.

---

## Operations docs

- **Backup & restore:** [`docs/BACKUP-RESTORE.md`](./docs/BACKUP-RESTORE.md)
- **Observability (recommendations):** [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md)
- **Engineering standards:** [`docs/ENGINEERING-STANDARDS.md`](./docs/ENGINEERING-STANDARDS.md)

---

## License

UNLICENSED — proprietary. See `package.json`.
