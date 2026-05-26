-- AI Company Brain — Phase-0 graph schema v0 (WBS 0.2).
-- Aligned with ai-company-brain/system_architecture.md §4.

-- 1. Required extensions ----------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;          -- pgvector
-- Apache AGE (property-graph) is deferred to Phase 2 when multi-hop traversals
-- start to matter. Phase 0 + 1 are fine with plain relational joins. To enable
-- later, switch the image in infra/docker-compose.yml to a build that ships
-- both pgvector AND age, and re-run this script with the AGE bits uncommented.
-- CREATE EXTENSION IF NOT EXISTS age;
-- LOAD 'age';
-- SET search_path = ag_catalog, "$user", public;

-- 2. Canonical entity tables ------------------------------------------------
CREATE TABLE IF NOT EXISTS person (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    canonical_name  TEXT NOT NULL,
    aliases         TEXT[] NOT NULL DEFAULT '{}',
    clickup_id      TEXT UNIQUE,
    zoho_id         TEXT UNIQUE,
    odoo_id         TEXT UNIQUE,
    email           TEXT UNIQUE,
    whatsapp_e164   TEXT,
    role            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,
    zoho_id     TEXT UNIQUE,
    odoo_id     TEXT UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          TEXT NOT NULL,
    clickup_id    TEXT UNIQUE,
    customer_id   UUID REFERENCES customer(id),
    status        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title             TEXT NOT NULL,
    clickup_id        TEXT UNIQUE,
    owner_id          UUID REFERENCES person(id),
    project_id        UUID REFERENCES project(id),
    stage             TEXT,
    stage_entered_at  TIMESTAMPTZ,
    days_in_stage     INT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_stage_idx       ON task (stage);
CREATE INDEX IF NOT EXISTS task_owner_idx       ON task (owner_id);
CREATE INDEX IF NOT EXISTS task_project_idx     ON task (project_id);

CREATE TABLE IF NOT EXISTS deal (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name              TEXT NOT NULL,
    zoho_id           TEXT UNIQUE,
    customer_id       UUID REFERENCES customer(id),
    owner_id          UUID REFERENCES person(id),
    stage             TEXT,
    last_activity_at  TIMESTAMPTZ,
    value_inr         NUMERIC(14,2),
    deal_type         TEXT CHECK (deal_type IN ('product','service','software')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel     TEXT NOT NULL CHECK (channel IN ('email','whatsapp','meeting','other')),
    author_id   UUID REFERENCES person(id),
    thread_id   TEXT,
    body        TEXT NOT NULL,
    sent_at     TIMESTAMPTZ,
    embedding   vector(1024),               -- pgvector; dimension TBD per chosen embedder
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_thread_idx ON message (thread_id);

CREATE TABLE IF NOT EXISTS meeting (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    platform            TEXT NOT NULL CHECK (platform IN ('meet','zoom','teams','other')),
    start_at            TIMESTAMPTZ NOT NULL,
    end_at              TIMESTAMPTZ,
    attendee_ids        UUID[] NOT NULL DEFAULT '{}',
    transcript          TEXT,
    transcript_source   TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_item (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id        UUID NOT NULL REFERENCES meeting(id) ON DELETE CASCADE,
    assignee_id       UUID REFERENCES person(id),
    description       TEXT NOT NULL,
    confidence        DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','created','rejected')),
    resulting_task_id UUID REFERENCES task(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Append-only audit log (WBS 0.5; consumed by Annealer in Phase 4) -------
CREATE TABLE IF NOT EXISTS audit_event (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_event (actor);
CREATE INDEX IF NOT EXISTS audit_at_idx    ON audit_event (at DESC);

-- 4. Apache AGE graph (Phase 2+) ------------------------------------------
-- Re-introduce when multi-hop graph traversals start to pull weight:
--   SELECT create_graph('acb_graph');
