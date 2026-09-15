# oneTeam — Retail Shelf Monitoring Platform (FMCG Coca-Cola Distribution)

![oneTeam Logo](./logo.jpg)

**oneTeam** is a modern retail shelf monitoring and planogram compliance platform designed for FMCG operations (specifically Coca-Cola distribution in retail chains such as Bravo, Araz, Bazarstore, and Rahat).

The platform enables FMCG supervisors to dispatch visual merchandising tasks and planograms to stores, while merchandisers and store staff submit real-time shelf audit photos and telemetry via Telegram Bot or mobile apps.

---

## Tech Stack & Architecture

- **Backend / BaaS**: [Supabase](https://supabase.com) (PostgreSQL 15+, Supabase Storage, PostgREST API, Supabase Auth)
- **Language & Runtime**: TypeScript / Node.js
- **Bot Engine**: Telegram Bot API (webhook or polling with chat ID binding)
- **Object Storage**: Supabase Storage (`shelf-images` bucket with CDN caching)
- **Security**: PostgreSQL Row Level Security (RLS) policies + PostgreSQL triggers

---

## Database Architecture Overview

```
+-----------------------------------------------------------------------------------+
|                                 SUPABASE AUTH                                     |
|                                  auth.users                                       |
+-----------------------------------------------------------------------------------+
                                         | 1:1
                                         v
+-----------------------------------------------------------------------------------+
|                                    PROFILES                                       |
| id (PK, FK auth.users) | full_name | role (user_role) | telegram_chat_id (UK)      |
+-----------------------------------------------------------------------------------+
       | 1:N (created_by)                                | 1:N (submitted_by)
       v                                                 v
+------------------------+                     +------------------------------------+
|         TASKS          |                     |            SUBMISSIONS             |
| id (PK)                |                     | id (PK)                            |
| title, description     |                     | task_id (FK)                       |
| reference_image_url    |                     | store_id (FK)                      |
| priority, status       |                     | submitted_by (FK)                  |
| deadline               |                     | photo_url (Storage)                |
+------------------------+                     | status (pending_review/approved/..) |
       | 1:N                                   | metadata (JSONB: GPS, device, etc) |
       v                                       +------------------------------------+
+------------------------+                                       ^
|    TASK_ASSIGNMENTS    |                                       |
| id (PK)                |                                       |
| task_id (FK)           |                                       |
| store_id (FK)          |                                       |
+------------------------+                                       |
       | N:1                                                     |
       v                                                         |
+----------------------------------------------------------------+
|                                     STORES                                        |
| id (PK) | store_code (UK) | name | address | city | latitude | longitude | active |
+-----------------------------------------------------------------------------------+
```

### Domain Models

| Entity                 | Description                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`profiles`**         | Extends `auth.users`. Contains user display names, platform roles (`admin`, `supervisor`, `store_staff`, `merchandiser`), phone numbers, and unique `telegram_chat_id` for instant Telegram Bot association.                   |
| **`stores`**           | Physical retail store locations (e.g. Bravo 28 Mall, Araz Ganjlik) with GPS coordinates (`latitude`, `longitude`), unique store codes, and active flags.                                                                       |
| **`tasks`**            | Audit missions created by supervisors containing merchandising guidelines, sample planogram URLs, priority (`low`, `medium`, `high`, `urgent`), deadline, and status (`draft`, `published`, `completed`, `archived`).          |
| **`task_assignments`** | Many-to-many junction linking specific tasks to target retail stores with unique constraint `(task_id, store_id)`.                                                                                                             |
| **`submissions`**      | Shelf photos uploaded by field staff. Includes audit status (`pending_review`, `approved`, `rejected`), supervisor feedback, and rich `metadata` (JSONB) storing GPS coordinates, capture timestamp, and Telegram message IDs. |

### Enums

- **`user_role`**: `'admin'`, `'supervisor'`, `'store_staff'`, `'merchandiser'`
- **`task_priority`**: `'low'`, `'medium'`, `'high'`, `'urgent'`
- **`task_status`**: `'draft'`, `'published'`, `'completed'`, `'archived'`
- **`submission_status`**: `'pending_review'`, `'approved'`, `'rejected'`

---

## Storage & Security (RLS)

### Storage Bucket: `shelf-images`

- Stores high-resolution shelf audit photos submitted from the field.
- Public read access enabled for fast image loading on dashboards and mobile clients.
- Upload policy restricted to authenticated users.
- Max file size: 10MB (supports JPEG, PNG, WEBP, HEIC).

### Row Level Security (RLS) Summary

- **Profiles**: All authenticated users can view member profiles. Users can only update their own profile; admins have full management.
- **Stores**: All authenticated users can view active retail stores. Supervisors/admins can create or edit stores.
- **Tasks**: Merchandisers see published tasks. Supervisors and admins can see drafts and manage all tasks.
- **Task Assignments**: Read-accessible to authenticated users; manageable by supervisors and admins.
- **Submissions**: Field staff view their own submissions; supervisors and admins can review, approve, or reject submissions and add audit feedback.

---

## Setup & Deployment Instructions

### 1. Environment Configuration

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

Required variables:

- `SUPABASE_URL`: Your Supabase Project URL (`https://xyzcompany.supabase.co`)
- `SUPABASE_ANON_KEY`: Supabase anon/public key (client-side calls)
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service_role key (server-side/Telegram bot calls)
- `DATABASE_URL`: Direct PostgreSQL connection string
- `TELEGRAM_BOT_TOKEN`: Field bot token from `@BotFather`

---

### 2. Executing the Database Migration (`init_schema.sql`)

You can run the schema migration using any of the following methods:

#### Option A: Supabase Web Dashboard (Easiest)

1. Open your project on [database.new](https://database.new) or [Supabase Dashboard](https://app.supabase.com).
2. Go to the **SQL Editor** tab on the left navigation bar.
3. Click **New Query**.
4. Copy the entire contents of [`init_schema.sql`](./init_schema.sql) and paste it into the editor.
5. Click **Run** (or `Cmd + Enter`).
6. The tables, enums, triggers, storage bucket, and RLS policies will be created.

#### Option B: Supabase CLI (Recommended for Development)

If using Supabase CLI locally:

```bash
# Initialize and start local Supabase instance
npx supabase start

# Apply migrations
npx supabase db reset
# or
npx supabase migration up
```

#### Option C: Direct PostgreSQL CLI (`psql`)

```bash
psql "$DATABASE_URL" -f init_schema.sql
```

---

### 3. Loading Seed Data (`seed.sql`)

Once `init_schema.sql` has executed successfully, apply the sample data:

#### Via Supabase SQL Editor:

1. In the **SQL Editor**, open a new query.
2. Paste the contents of [`seed.sql`](./seed.sql).
3. Click **Run**.

#### Via `psql`:

```bash
psql "$DATABASE_URL" -f seed.sql
```

#### What gets seeded:

- **Supervisor Profile**: Default system supervisor account (`supervisor@oneteam.az`).
- **2 Retail Stores**:
  - `BRAVO_28MAY_01`: Bravo Supermarket - 28 Mall (Nasimi, Baku)
  - `ARAZ_GENJLIK_02`: Araz Superstore - Ganjlik (Narimanov, Baku)
- **1 Audit Task**: _"Coca-Cola 0.5L Cooler Placement Check"_ with planogram criteria, temperature requirements, and facing rules.
- **Task Assignments**: The audit task is assigned to both sample stores.

---

## TypeScript Type Safety

Strongly-typed database interfaces are available in [`types/database.types.ts`](./types/database.types.ts).

To update types automatically from your live Supabase project:

```bash
npx supabase gen types typescript --project-id <your-project-id> > types/database.types.ts
```

Example usage in TypeScript:

```typescript
import { createClient } from '@supabase/supabase-js';
import { Database } from './types/database.types';

const supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);

// Fully type-safe query
const { data: stores, error } = await supabase.from('stores').select('*').eq('is_active', true);
```

---

## Telegram Bot Service (`src/bot/`)

A TypeScript-first Telegram bot built with **grammY** for field merchandisers and retail store staff.

### Capabilities & Commands

1. **`/start` — Registration & Store Binding**:
   - Greets staff in Azerbaijani (`👋 oneTeam — Rəf Monitorinq Sisteminə Xoş Gəlmisiniz!`).
   - Requests and validates store code (e.g. `BRAVO_28MAY_01`).
   - Binds `telegram_chat_id` to user profile and saves store context in session.
   - Provides an interactive Azerbaijani keyboard (`📋 Tapşırıqlar`, `📊 Statusum`).

2. **`/tasks` or `📋 Tapşırıqlar` — Planogram Retrieval**:
   - Queries active published audit tasks assigned to the store.
   - Displays task title, priority, deadline, facing instructions, and sends planogram reference image.
   - Provides an inline button: `"📸 Rəf Şəklini Göndər"`.

3. **Photo Upload & Storage Submission**:
   - Downloads highest-resolution image from Telegram servers.
   - Uploads to Supabase Storage bucket `shelf-images` at `audits/<store_id>/<task_id>_<timestamp>.jpg`.
   - Records audit in `submissions` with status `pending_review` and telemetry metadata (GPS, Telegram ID, device).
   - Confirms receipt in Azerbaijani: _"Təşəkkür edirik! Rəf şəkli supervayzer yoxlaması üçün qeydə alındı."_

4. **`/mystatus` or `📊 Statusum` — Audit History & Feedback**:
   - Shows recent submissions, review statuses (`pending_review`, `approved`, `rejected`), and supervisor comments.

---

## Supervisor & Admin Web Portal (`web/`)

A modern, responsive React + TypeScript web application built with **Vite** and **Tailwind CSS** featuring custom Coca-Cola branding and Azerbaijani localization.

### Modules & Capabilities

1. **Dashboard Overview (Metrics & Analytics)**:
   - Real-time KPI Cards: Total Stores, Active Tasks, Pending Reviews, and Compliance Rate (% of approved shelf photos).
   - Live stream of recent shelf photo submissions with status indicators and quick-review actions.

2. **Shelf Audit Review & Approval Center (Core Feature)**:
   - Filterable gallery/grid view: All (`Bütün`), Pending (`Gözləyən`), Approved (`Təsdiqlənmiş`), Rejected (`İmtina Edilmiş`).
   - Search by store name, store code, or planogram title.
   - **Side-by-Side Comparison Modal**:
     - **Left**: Reference Planogram photo (Ideal Layout) with instruction checklist.
     - **Right**: Field staff's uploaded shelf photo with submitter identity and timestamp.
   - **Action Controls**:
     - `"✅ Təsdiq Et"` (Approve): Instantly updates status to `approved`.
     - `"❌ İmtina Et"` (Reject): Opens feedback input drawer, records supervisor comment (e.g. _"Coca-Cola 1L facing missing on bottom shelf"_), and sets status to `rejected`.

3. **Task & Planogram Management**:
   - List of all published, draft, or completed merchandising missions.
   - **"Yeni Təlimat Yarat" (Create New Task) Modal**:
     - Planogram title, facing & cooling instructions.
     - Priority selector (`low`, `medium`, `high`, `urgent`).
     - Baku-time deadline picker.
     - Reference photo URL / planogram uploader.
     - Multi-store assignment selector (assign to "Bütün Mağazalar" or select specific stores like Bravo, Araz, etc.).

4. **Store Directory**:
   - Comprehensive partner retail chain directory (Bravo, Araz, Bazarstore, Rahat Gourmet).
   - Displays unique Store Codes, Baku addresses, total audits count, and live compliance percentage progress bars.

---

## iOS Field Audit Mobile Client (`mobile/`)

An iOS-ready mobile field application designed for Coca-Cola in-store merchandisers and retail auditors.

### Key Modules & Technical Capabilities

1. **Anti-Fraud GPS Geofencing (100m Perimeter)**:
   - Verifies field auditor's real-time Core Location GPS coordinates against the target retail store's coordinates (`latitude`, `longitude`) using the **Haversine formula**.
   - If distance > 100 meters, audit submission is strictly blocked with an anti-fraud warning:
     ```
     ⚠️ Siz mağaza ərazisində deyilsiniz (Məsafə: Xm). Rəf auditi yalnız mağaza daxilində (100m radius) təsdiqlənə bilər.
     ```

2. **Active Tasks & Planogram Visualizer**:
   - Visualizes assigned planograms for the active store with priority flags (`urgent`, `high`, etc.).
   - Displays clear shelf layout instructions, SKU facing numbers (e.g. 3 facings), and strict cooling requirements (`≤ 4°C`).

3. **Smart Camera & Ghost Overlay (AR Guide)**:
   - Semi-transparent "Ghost View" planogram overlay directly over the live camera viewfinder.
   - Allows field merchandisers to align bottle angles, shelf tiers, and brand labels accurately.
   - **Anti-Fraud Gallery Restriction**: Strictly restricts selecting photos from the device camera roll or gallery — enforces 100% live in-app camera capture.
   - Stamps rich telemetry onto every capture: GPS coordinates, accuracy, distance from store center, timestamp, and device model.

4. **In-Store Offline Queue & Background Sync**:
   - Resilient offline capability for basement supermarkets with zero cellular connectivity.
   - Submissions are queued on the device in `AsyncStorage`, written before the capture is reported as saved, and read back on the next launch.
   - Reconnection drains the queue automatically, in order, one audit at a time, using the same acknowledgement-then-upload path a manual sync uses.
   - The queue holds 50 MB. A new audit that would exceed that is **refused with a message**, never silently swapped in for an older one — the oldest item is somebody's work.
   - Two things it does **not** do, stated here because this section used to claim otherwise: there is no background retry timer (retries follow a reconnection, or a worker pressing sync), and `AsyncStorage` is not encrypted — a queued audit is protected by the iOS app sandbox, not by a key. See `mobile/src/services/queueStorage.ts`.

5. **iOS Native Configuration**:
   - [`mobile/app.json`](./mobile/app.json) is the single source of truth: bundle identifier, icon, splash, the three Expo config plugins (`expo-camera`, `expo-location`, `expo-secure-store`) and the Azerbaijani privacy strings (`NSCameraUsageDescription`, `NSLocationWhenInUseUsageDescription`).
   - `mobile/ios/` is **generated**, not committed — `npx expo prebuild --platform ios` writes it from `app.json`. Regenerate it after any config change; do not hand-edit it, because the next prebuild overwrites it.
   - The icon and splash mark are built from the repo's `logo.jpg` by [`scripts/dev/make-mobile-assets.py`](./scripts/dev/make-mobile-assets.py), which pads the non-square logo onto a square canvas of its own measured background colour.

---

## Running Automated Tests Across All Platforms

### Run Complete Platform Test Suite (Bot + Web + Mobile):

```bash
npm run test:all
```

### Run Individual Test Suites:

```bash
# 1. Telegram Bot E2E User Journey (7 steps)
npm run bot:test

# 2. Supervisor Web Portal Service & Data Test
npm run web:test

# 3. iOS Mobile Field Client (Geofence, Camera, Offline Queue)
npm run mobile:test

# 4. Device credential policy (identity minted once, survives a restart)
npm run test:credentials

# 5. Offline queue policy (durability, the 50 MB limit, reconnection drain)
npm run test:queue
```

### Prove the suites actually guard what they claim:

```bash
npm run test:break
```

This is not a test suite — it is the tool that decides whether the suites are
evidence. It deliberately reintroduces each defect the queue suite claims to catch,
one at a time, and checks that **the matching check** goes red. A case counts only
if the patch landed **and** the target reached its summary line; a patch that
silently failed to apply, or a target killed by a syntax error, is reported as
**not evidence** rather than as a pass. It restores every file afterwards and
re-runs both suites to prove the restore was clean, then exits non-zero if any
break failed to redden its own check.

It is kept out of `npm run quality` on purpose: it **writes to source files**, so it
is a deliberate, supervised action, not something a build step should trigger.

---

## Complete Repository Architecture

```
oneTeam/
├── .env                                              # Local environment variables
├── .env.example                                      # Environment variables template
├── init_schema.sql                                   # Primary SQL migration script
├── seed.sql                                          # Sample stores, tasks, & assignments seed
├── package.json                                      # Dependencies & scripts (bot, web, mobile, tests)
├── tsconfig.json                                     # Root TypeScript configuration
├── logo.jpg                                          # oneTeam platform branding
├── README.md                                         # Project setup & architecture documentation
├── src/                                              # Telegram Bot Service (Task 2)
│   ├── bot/
│   │   ├── index.ts                                  # Grammy Bot entrypoint & command router
│   │   ├── types.ts                                  # Grammy context & session types
│   │   ├── test-runner.ts                            # Automated E2E test runner
│   │   └── handlers/
│   │       ├── start.ts                              # /start & store code binding
│   │       ├── tasks.ts                              # /tasks & planogram view
│   │       ├── submission.ts                         # Photo download, storage upload, audit DB insert
│   │       └── status.ts                             # /mystatus & supervisor review feedback
│   └── services/
│       └── supabase.ts                               # Supabase client & offline fallback layer
├── web/                                              # Supervisor & Admin Web Portal (Task 3)
│   ├── index.html                                    # Web portal HTML entrypoint
│   ├── package.json                                  # Web dependencies (React, Vite, Tailwind)
│   ├── vite.config.ts                                # Vite configuration
│   ├── tailwind.config.js                            # Coca-Cola brand theme configuration
│   ├── tsconfig.json                                 # Web TypeScript configuration
│   └── src/
│       ├── App.tsx                                   # Main dashboard application
│       ├── main.tsx                                  # React DOM entrypoint
│       ├── index.css                                 # Tailwind styling & custom scrollbars
│       ├── smoke-test.ts                             # Automated web service smoke test
│       ├── components/
│       │   ├── Sidebar.tsx                           # Navigation sidebar with pending badges
│       │   ├── Header.tsx                            # Header with Baku clock & quick actions
│       │   ├── DashboardOverview.tsx                 # KPI cards & recent submissions feed
│       │   ├── AuditReviewCenter.tsx                 # Side-by-side planogram comparison modal
│       │   ├── TaskManager.tsx                       # Task catalog & creation modal
│       │   └── StoreDirectory.tsx                    # Retail stores & compliance progress
│       ├── lib/
│       │   └── supabase.ts                           # Supabase web client & mock fallback
│       └── types/
│           └── index.ts                              # Web data models & TypeScript interfaces
├── mobile/                                           # iOS Field Audit Mobile Client (Task 4)
│   ├── package.json                                  # Mobile dependencies & test scripts
│   ├── tsconfig.json                                 # Mobile TypeScript configuration
│   ├── app.json                                      # Mobile app descriptor & iOS permissions
│   ├── ios/
│   │   ├── Podfile                                   # iOS CocoaPods platform configuration
│   │   └── oneTeam/
│   │       └── Info.plist                            # iOS Camera & Location permission descriptors
│   └── src/
│       ├── App.tsx                                   # Mobile application coordinator
│       ├── types/index.ts                            # Mobile interfaces & geofence types
│       ├── utils/geofence.ts                         # Haversine distance & 100m geofence validator
│       ├── services/
│       │   ├── portalApi.ts                          # Core API data layer (device-credentialled)
│       │   ├── credentialStore.ts                    # Identity + credential policy (storage is a seam)
│       │   ├── keychain.ts                           # The iOS keychain, as that seam (native import)
│       │   ├── offlineQueue.ts                       # Offline queue policy (storage is a seam)
│       │   ├── queueStorage.ts                       # AsyncStorage, as that seam (native import)
│       │   ├── credentialStore.test.ts               # 37 checks over the credential policy
│       │   └── offlineQueue.test.ts                  # 83 checks over the queue policy
│       ├── components/
│       │   └── SmartCameraOverlay.tsx                # Ghost overlay & live camera capture
│       ├── screens/
│       │   ├── LoginScreen.tsx                       # Store code login & GPS verification
│       │   ├── TaskListScreen.tsx                    # Active planograms view
│       │   ├── CameraAuditScreen.tsx                 # Smart camera capture & submission
│       │   └── AuditHistoryScreen.tsx                # Submissions history & reviewer notes
│       └── tests/
│           └── mobile-test-runner.ts                 # Automated mobile verification suite
├── supabase/
│   ├── migrations/
│   │   └── 20260912000001_init_schema.sql            # Versioned migration for Supabase CLI
│   └── seed.sql                                      # Versioned seed file for Supabase CLI
└── types/
    └── database.types.ts                             # Auto-generated & typed database models
```
