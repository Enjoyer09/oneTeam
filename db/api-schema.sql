-- ============================================================================
-- oneTeam — application schema for the NestJS API
-- File: db/api-schema.sql
-- Target: plain PostgreSQL 16 (the Railway `postgres` service and the
--         `postgres` service in docker-compose.prod.yml)
-- ============================================================================
--
-- WHY THIS FILE EXISTS SEPARATELY FROM init_schema.sql
-- ---------------------------------------------------
-- The repository had two schemas that describe two different products, and
-- neither was wired to the running API:
--
--   init_schema.sql  Supabase-shaped: profiles / stores / tasks /
--                    task_assignments / submissions, plus RLS policies that
--                    reference auth.uid() and the `authenticated` role.
--                    That is the web portal's world. It is mounted into the
--                    database container and is what created the tables that
--                    exist on Railway today.
--
--   schema.prisma    The API's world: users / regions / stores / campaigns /
--                    task_templates / store_tasks / task_evidences /
--                    audit_logs, with uppercase enum labels.
--
-- The API's repository layer (packages/database) reads and writes the second
-- shape. Running it against the first produced nothing but errors, which is
-- why the API ignored the database entirely and kept everything in memory.
--
-- The two shapes cannot share one database: both want a table called `stores`
-- and they disagree about its columns. This file is therefore the schema for
-- the API's database. init_schema.sql stays in the repository for the Supabase
-- path, but it is no longer mounted into the Postgres container — see
-- Dockerfile.postgres and docker-compose.prod.yml.
--
-- Column names are snake_case, exactly as the repository layer queries them.
-- Identifiers are TEXT rather than UUID: the seed data uses readable ids such
-- as 'str-bravo-yasamal' and the services mint ids like
-- 'task-bulk-1757779200000-a1b2c3'. A uuid column would reject both.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Enumerated types
-- ----------------------------------------------------------------------------
-- Wrapped in a guard because PostgreSQL has no CREATE TYPE IF NOT EXISTS.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('ADMIN', 'SUPERVISOR', 'MERCHANDISER', 'STORE_STAFF');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_priority') THEN
        CREATE TYPE task_priority AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'task_state') THEN
        CREATE TYPE task_state AS ENUM (
            'DRAFT', 'PUBLISHED', 'DELIVERED', 'ACKNOWLEDGED',
            'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED'
        );
    END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE,
    full_name         TEXT NOT NULL,
    role              user_role NOT NULL DEFAULT 'MERCHANDISER',
    telegram_chat_id  TEXT UNIQUE,
    phone             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- regions
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS regions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    code        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- stores
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stores (
    id            TEXT PRIMARY KEY,
    store_code    TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    region_id     TEXT NOT NULL REFERENCES regions (id) ON DELETE RESTRICT,
    chain_name    TEXT NOT NULL DEFAULT 'Bravo',
    store_format  TEXT NOT NULL DEFAULT 'supermarket',
    address       TEXT NOT NULL,
    city          TEXT NOT NULL DEFAULT 'Bakı',
    latitude      DOUBLE PRECISION NOT NULL,
    longitude     DOUBLE PRECISION NOT NULL,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stores_store_code_idx ON stores (store_code);
CREATE INDEX IF NOT EXISTS stores_region_id_idx  ON stores (region_id);

-- ----------------------------------------------------------------------------
-- campaigns
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,
    start_date   TIMESTAMPTZ NOT NULL,
    end_date     TIMESTAMPTZ NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- task_templates
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_templates (
    id                          TEXT PRIMARY KEY,
    campaign_id                 TEXT REFERENCES campaigns (id) ON DELETE SET NULL,
    title                       TEXT NOT NULL,
    description                 TEXT NOT NULL,
    reference_image_url         TEXT NOT NULL,
    priority                    task_priority NOT NULL DEFAULT 'MEDIUM',
    planogram_rules             JSONB NOT NULL DEFAULT '[]'::jsonb,
    requires_before_after_photo BOOLEAN NOT NULL DEFAULT FALSE,
    checklist_schema            JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- store_tasks
-- ----------------------------------------------------------------------------
-- The six *_at columns are not bookkeeping: the state machine stamps one of
-- them on each transition (see updateTaskState in packages/database), and the
-- portal renders the task timeline from them.
CREATE TABLE IF NOT EXISTS store_tasks (
    id               TEXT PRIMARY KEY,
    template_id      TEXT NOT NULL REFERENCES task_templates (id) ON DELETE RESTRICT,
    store_id         TEXT NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,
    assigned_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    status           task_state NOT NULL DEFAULT 'DRAFT',
    deadline         TIMESTAMPTZ NOT NULL,
    published_at     TIMESTAMPTZ,
    delivered_at     TIMESTAMPTZ,
    acknowledged_at  TIMESTAMPTZ,
    submitted_at     TIMESTAMPTZ,
    reviewed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS store_tasks_status_idx  ON store_tasks (status);
CREATE INDEX IF NOT EXISTS store_tasks_store_id_idx ON store_tasks (store_id);
CREATE INDEX IF NOT EXISTS store_tasks_assigned_idx ON store_tasks (assigned_user_id);

-- ----------------------------------------------------------------------------
-- task_evidences
-- ----------------------------------------------------------------------------
-- ai_score and ai_summary are nullable on purpose. Three states are meaningful
-- and distinct: NULL means the AI pass produced no verdict yet, a value means
-- it did. The repository layer models the same three cases.
CREATE TABLE IF NOT EXISTS task_evidences (
    id                 TEXT PRIMARY KEY,
    store_task_id      TEXT NOT NULL REFERENCES store_tasks (id) ON DELETE CASCADE,
    submitted_by_id    TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    photo_url          TEXT NOT NULL,
    photo_type         TEXT NOT NULL DEFAULT 'standard',
    checklist_answers  JSONB NOT NULL DEFAULT '[]'::jsonb,
    latitude           DOUBLE PRECISION NOT NULL,
    longitude          DOUBLE PRECISION NOT NULL,
    gps_distance_meters DOUBLE PRECISION NOT NULL DEFAULT 0,
    ai_score           INTEGER,
    ai_detections      JSONB NOT NULL DEFAULT '[]'::jsonb,
    ai_summary         TEXT,
    reviewer_feedback  TEXT,
    submitted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_evidences_task_idx ON task_evidences (store_task_id);

-- ----------------------------------------------------------------------------
-- audit_logs
-- ----------------------------------------------------------------------------
-- Append-only. Nothing in the application ever updates or deletes a row here,
-- and the table is what makes a state change explainable after the fact.
CREATE TABLE IF NOT EXISTS audit_logs (
    id          TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT,
    actor_id    TEXT REFERENCES users (id) ON DELETE SET NULL,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
