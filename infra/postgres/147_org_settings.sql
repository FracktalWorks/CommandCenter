-- ============================================================================
-- 147_org_settings.sql — organisation-wide preference blobs
-- ============================================================================
-- A generic key → JSON store for settings that belong to the ORGANISATION
-- rather than to a person or a subsystem. First consumer is the theming
-- engine's org default (key 'appearance'), which decides what every member
-- sees before they choose a theme for themselves.
--
-- Why a new table rather than reusing `model_config` (35_model_config.sql):
-- that table is the LLM subsystem's store — its name, its migration and every
-- caller are about tier overrides and enabled models. Appearance is not model
-- configuration, and filing it there would make `model_config` mean "any
-- config we happened to need a row for", which is how a table stops being
-- searchable. Same shape, different subject.
--
-- Why blobs rather than typed columns: these are small, read-whole,
-- written-whole preference documents whose shape is owned by the frontend
-- (the set of themes lives in src/lib/theme/themes.ts). A typed column per
-- field would mean a migration every time a theme gains a knob, to buy
-- constraints the reader re-validates anyway — it treats an unknown theme id
-- as "use the default", because a theme can be removed from the app long
-- after a row naming it was written.
--
-- Bounded by construction: rows are keyed by a fixed vocabulary of setting
-- names written by admin-gated routes, so this table holds a handful of rows,
-- not one per user or per event.
--
-- Idempotent. Depends on: nothing (additive, standalone table).
-- ============================================================================

CREATE TABLE IF NOT EXISTS org_settings (
    -- Setting name, e.g. 'appearance'. A closed vocabulary defined by the
    -- routes that write it; there is no per-tenant key namespace because this
    -- deployment is one organisation.
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Who last changed it. Org-wide settings affect everybody, so "who set
    -- this" is the first question asked when the whole company's UI changes.
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
