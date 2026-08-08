"""The tenant boundary, as a ratchet (WS-29).

⚠️ **CommandCenter is becoming multi-tenant, and today 120 of its 143 tables
carry no tenant key.** That is not a bug list — it is the honest state of a
system built for one organisation. The bug would be adding the 144th.

**137 → 120 on 2026-08-08 (WS-29a).** Migration 158 gave all 17 `pm_*` tables
`organization_id`, while they were still empty enough to make it a one-line
default rather than a backfill (`specs/multi_tenancy.md` §2). The ratchet is
what made that a required edit rather than an optional one: the
"gained a key, leave the baseline" rule below went red the moment the migration
landed, and stayed red until this docstring and the count agreed with it.

Tenancy was started and not carried through: `organization` exists with a
single seeded row (`slug='default'`), `app_user` gained `organization_id` in
migration 130, the CRM scoped three of its tables, and `org_group`/`org_role`
scoped themselves. Everything since — Projects, GTD, Email, WhatsApp,
Workflows, Apps, Chat — did not.

This test does not demand the retrofit. It demands that the number stop
growing, on the model of the frontend's `conformance.test.ts`:

  * a table **not** in the baseline must carry `organization_id` — this is the
    case that matters, because it is every table nobody has written yet;
  * a baselined table may stay as it is;
  * a baselined table that **gained** a tenant key fails until it is removed
    from the baseline, so the debt figure below is always the real one.

That last rule is what makes the other two credible. A baseline only ever
edited downward when somebody happens to notice is a baseline that quietly
becomes fiction.

**Scope note.** `organization_id` on the table is the *shape*, not the
enforcement. Which of RLS, an application clause, or a schema per tenant does
the enforcing is D-MT-2 in `specs/multi_tenancy.md` and is deliberately not
decided here — every one of them wants the column.
"""

from __future__ import annotations

import glob
import os
import re

#: `LiteLLM_*` is a vendored product with its own tenancy model; it is not ours
#: to scope and its tables never reach our code.
FOREIGN_PREFIX = "LiteLLM"

#: Tables that carry a tenant key today. Not a baseline — the goal state.
EXPECTED_SCOPED = {
    "app_user",
    "crm_activities",
    "crm_contacts",
    "crm_deals",
    "org_group",
    "org_role",
    # WS-29a — the whole Projects app, keyed while it was empty.
    "pm_activities", "pm_custom_fields", "pm_notifications",
    "pm_project_grants", "pm_projects", "pm_recurrences", "pm_tags",
    "pm_task_assignees", "pm_task_attachments", "pm_task_counters",
    "pm_task_links", "pm_task_personal", "pm_task_statuses", "pm_task_types",
    "pm_tasks", "pm_view_task_positions", "pm_views",
}

#: ⚠️ FROZEN 2026-08-08 at 137, now 120 (WS-29a took the 17 `pm_*` out).
#: Every table predating the multi-tenant decision.
#: Adding a name here is allowed and must come with a reason in the PR; adding
#: one *silently* is how a 137 becomes a 160 without anybody choosing it.
BASELINE_UNSCOPED = {
# access_*
    "access_request",
# action_*
    "action_item",
# agent_*
    "agent_avatars", "agent_blob", "agent_file_history", "agent_run",
    "agent_skill_setting",
# app_*
    "app_audit", "app_data", "app_files", "app_grants", "app_pins",
    "app_tool_grants", "app_versions",
# apps_*
    "apps",
# audit_*
    "audit_event",
# chat_*
    "chat_message", "chat_session", "chat_session_agent",
    "chat_session_participant",
# copilot_*
    "copilot_config", "copilot_event",
# crm_*
    "crm_deal_contacts", "crm_deal_statuses", "crm_lead_statuses",
    "crm_leads", "crm_lost_reasons", "crm_organizations",
    "crm_status_changes", "crm_sync_cursors", "crm_zoho_tombstones",
# custom_*
    "custom_api_definitions",
# customer_*
    "customer",
# deal_*
    "deal",
# dynamic_*
    "dynamic_agents",
# email_*
    "email_accounts", "email_actions", "email_ai_drafts",
    "email_assistant_settings", "email_attachments", "email_cold_senders",
    "email_contacts", "email_embeddings", "email_executed_rules",
    "email_folders", "email_knowledge", "email_learned_patterns",
    "email_messages", "email_newsletters", "email_rule_guidance",
    "email_rule_patterns", "email_rules", "email_senders", "email_sync_log",
    "email_thread_status", "email_voice_profiles",
# feature_*
    "feature_catalog",
# gtd_*
    "gtd_attachments", "gtd_contexts", "gtd_day_state", "gtd_folders",
    "gtd_horizons", "gtd_items", "gtd_people", "gtd_person_resumes",
    "gtd_projects", "gtd_reviews", "gtd_rollover_log", "gtd_settings",
    "gtd_spaces", "gtd_waiting",
# live_*
    "live_session",
# mcp_*
    "mcp_servers",
# meeting_*
    "meeting", "meeting_bot", "meeting_note", "meeting_recording",
# message_*
    "message",
# model_*
    "model_config",
# notes_*
    "notes_glossary",
# org_*
    "org_group_member", "org_role_permission", "org_settings",
# organization_*
    "organization",
# pending_*
    "pending_actions", "pending_commit",
# person_*
    "person",
# plugins_*
    "plugins",
# pm_*
#   — all 17 left this baseline in WS-29a (migration 158). They are asserted
#     as scoped by `EXPECTED_SCOPED` below, so their absence here is checked
#     rather than merely assumed.
# project_*
    "project",
# provider_*
    "provider_keys",
# schema_*
    "schema_migrations",
# summary_*
    "summary_run",
# task_*
    "task", "task_accounts",
# transcript_*
    "transcript_segment",
# user_*
    "user_permission_override", "user_role",
# wa_*
    "wa_accounts", "wa_ai_drafts", "wa_categories", "wa_chat_avatars",
    "wa_chat_labels", "wa_chat_status", "wa_chats", "wa_commitments",
    "wa_contacts", "wa_group_summaries", "wa_labels", "wa_media",
    "wa_message_embeddings", "wa_messages", "wa_saved_replies",
    "wa_sync_log", "wa_templates",
# workflow_*
    "workflow_modules", "workflow_run_pauses", "workflow_runs",
    "workflow_triggers", "workflow_versions",
# workflows_*
    "workflows",}


def _scan() -> tuple[set[str], set[str]]:
    """Every table the migrations define, and which of them are tenant-scoped.

    Read from the migrations rather than from `schema.generated.sql`, which is
    stale (it predates migration 146 and knows about none of the `pm_*`
    tables), and rather than from a live connection, which this suite does not
    have.

    **`ALTER TABLE … ADD COLUMN organization_id` counts.** That is how
    `app_user` got its tenant key in migration 130, so a `CREATE TABLE`-only
    scan reports the one table that matters most as unscoped — it did, in the
    first version of this file, and the answer was checked against a real
    Postgres before this was written.
    """
    tables: set[str] = set()
    scoped: set[str] = set()
    for path in sorted(glob.glob("infra/postgres/*.sql")):
        if os.path.basename(path) == "schema.generated.sql":
            continue
        with open(path, encoding="utf-8") as handle:
            src = handle.read()
        for match in re.finditer(
            r"CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\((.*?)\n\);",
            src,
            re.S,
        ):
            tables.add(match.group(1))
            if re.search(r"\borganization_id\b", match.group(2)):
                scoped.add(match.group(1))
        for match in re.finditer(r"ALTER TABLE\s+([a-z_][a-z0-9_]*)(.*?);", src, re.S):
            if re.search(r"ADD COLUMN[^;]*\borganization_id\b", match.group(2)):
                scoped.add(match.group(1))
    return tables, scoped


def test_the_scan_finds_the_migrations_at_all() -> None:
    """The failure that would make every other assertion here vacuous: a glob
    matching nothing gives an empty set, which satisfies every `not new` below."""
    tables, scoped = _scan()
    assert len(tables) > 100, f"only found {len(tables)} tables — the glob is wrong"
    assert scoped <= tables


def test_the_baseline_names_no_table_that_no_longer_exists() -> None:
    """A baseline naming a dropped table overstates the debt, and the count in
    the docstring stops meaning anything.

    Written after the first version of this file asserted that every table is
    in one of the two literal sets — which failed a NEW, correctly-scoped
    table for not being listed as expected-scoped. That is friction with no
    benefit: `EXPECTED_SCOPED` pins that the six known ones are real, it is not
    a register every future table must join.
    """
    tables, _ = _scan()
    stale = sorted(BASELINE_UNSCOPED - tables)
    assert not stale, f"BASELINE_UNSCOPED names tables that do not exist: {stale}"


def test_a_new_table_must_carry_a_tenant_key() -> None:
    """⚠️ THE rule. Everything else here is bookkeeping.

    A table added from now on is a table added while the system is knowingly
    becoming multi-tenant, and backfilling a tenant key onto live rows costs
    orders of magnitude more than declaring one on an empty table.
    """
    tables, scoped = _scan()
    unscoped = tables - scoped - {t for t in tables if t.startswith(FOREIGN_PREFIX)}
    new = sorted(unscoped - BASELINE_UNSCOPED)
    assert not new, (
        f"{new} has no `organization_id`. CommandCenter is becoming "
        f"multi-tenant (specs/multi_tenancy.md): give it one, or add it to "
        f"BASELINE_UNSCOPED with the reason in your PR."
    )


def test_a_table_that_gained_a_tenant_key_leaves_the_baseline() -> None:
    """⚠️ The rule that keeps the debt figure honest.

    Without it the baseline only shrinks when somebody remembers, and the
    number in this file drifts from the truth in the direction that flatters.
    """
    _, scoped = _scan()
    fixed = sorted(scoped & BASELINE_UNSCOPED)
    assert not fixed, (
        f"{fixed} now carries `organization_id` — remove it from "
        f"BASELINE_UNSCOPED and lower the count in this file's docstring."
    )


def test_the_expected_scoped_set_is_real_not_aspirational() -> None:
    """A name in `EXPECTED_SCOPED` that is not actually scoped would make this
    file claim coverage it does not have."""
    _, scoped = _scan()
    missing = sorted(EXPECTED_SCOPED - scoped)
    assert not missing, f"{missing} is listed as scoped but carries no key"


def test_the_frozen_count_matches_the_baseline() -> None:
    """The docstring quotes 120. A baseline whose stated size and real size
    disagree is a baseline nobody trusts."""
    assert len(BASELINE_UNSCOPED) == 120
