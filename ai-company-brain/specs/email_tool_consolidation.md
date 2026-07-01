# Email agent tool consolidation — plan (63 → ~40)

**Status:** proposed (not yet implemented). Authored 2026-07-01.
**Why:** the email-assistant is a native MAF `Agent(tools=list(_TOOLS))` with **63
tools, all injected every request** — a ~30× outlier vs every other agent
(task-manager 2, apis-config 1, coding orchestrator ~16 + Copilot built-ins) and
the only agent that bypasses the platform's existing `tool_scope` filter
(`executor._inject_agent_tools`, added explicitly to fight BFCL "too many tools"
degradation). Goal: cut the static set to ~40 by merging trivial variants and CRUD
groups behind an `action=`/`preset=` param, with **no capability loss** and
**endpoints unchanged** (tools just branch internally).

Target after this pass: **40 tools** (‑23). A more aggressive pass (merging the
three sender *reads*) reaches ~38; not recommended — clarity cost outweighs it.

---

## The 13 merges (exact before → after)

### M1 · Email search/find → `find_emails` (5 → 1, ‑4)
`query_inbox` is already the rich superset; fold the specialised finders in as a
`preset`.
- **Remove:** `search_emails`, `query_inbox`, `get_important_emails`, `find_urgent`, `find_needs_reply`
- **Add:**
  ```py
  find_emails(account_id: str, query: str | None = None, preset: str | None = None,
              folder: str = "inbox", days: int | None = None,
              sender_category: str | None = None, from_email: str | None = None,
              unread_only: bool = False, starred_only: bool = False,
              has_attachments: bool | None = None, importance: str | None = None,
              sort: str = "newest", limit: int = 25) -> str
  ```
  `preset ∈ {urgent, needs_reply, important}` routes internally to the existing
  specialised backends (`/email/reply-zero` for needs_reply, the canned urgent
  query, the importance scorer); `preset=None` → the current query_inbox path.
- **Card:** all 5 are in `LIST_TOOLS` → replace with `find_emails` (same EmailListCard;
  rows already carry `id=`).

### M2 · Read → `read_email` absorbs full body (2 → 1, ‑1)
- **Remove:** `get_full_body_email`
- **Change:** `read_email(email_id: str, full: bool = False)` — `full=True` fetches the
  untruncated body (12k cap). `read_thread` stays separate (whole conversation).
- **Card:** unchanged (`read_email` folds into the read group; get_full_body was cardless).

### M3 · Account status → `accounts` (3 → 1, ‑2)
- **Remove:** `list_accounts`, `get_unread_count`, `get_account_overview`
- **Add:** `accounts(account_id: str | None = None, detail: str = "list")` —
  `detail ∈ {list, unread, overview}` (overview requires account_id).
- **Card:** was INFO ×3 → one INFO entry `accounts`.

### M4 · Send → `send_message` (2 → 1, ‑1)
- **Remove:** `send_email`, `send_reply`
- **Add:**
  ```py
  send_message(account_id: str, body: str, to: list[str] | None = None,
               subject: str | None = None, cc: list[str] | None = None,
               bcc: list[str] | None = None, reply_to_email_id: str | None = None,
               attachments: list[str] | None = None) -> str
  ```
  `reply_to_email_id` set → reply (to/subject inferred); else new mail (to/subject
  required). Keep `draft_reply` (creates draft) and `send_draft` (sends existing draft).
- **Card:** `send_email` + `send_reply` (ACTION_META) → `send_message`. Still confirm-gated.

### M5 · Sender categories fold into `list_senders` (2 → 1, ‑1)
- **Remove:** `get_sender_categories`
- **Change:** `list_senders(account_id=None, folder="inbox", limit=25, by_category=False)`
  — `by_category=True` returns the category grouping. `categorize_senders` (the action
  that *runs* categorisation) stays.
- **Card:** `get_sender_categories` (INFO) removed; `list_senders` (INFO) stays.

### M6 · Rule execution resolution → `resolve_execution` (3 → 1, ‑2)
- **Remove:** `approve_execution`, `reject_execution`, `undo_execution`
- **Add:** `resolve_execution(execution_id: str, action: str)` — `action ∈ {approve, reject, undo}`.
- **Card:** 3 ACTION_META → 1.

### M7 · Rule lifecycle → `manage_rule` (2 → 1, ‑1)
- **Remove:** `update_rule_state`, `delete_rule`
- **Add:** `manage_rule(account_id: str, rule_id: str, action: str)` — `action ∈ {enable, disable, delete}`.
  Keep `create_rule`, `create_rules_from_prompt`, `update_rule` (edits conditions/actions),
  `reset_rules`, `run_rules_now`, `install_default_rules` distinct.
- **Card:** `update_rule_state` + `delete_rule` (ACTION) → `manage_rule`.

### M8 · Knowledge CRUD → `manage_knowledge` (4 → 1, ‑3)
- **Remove:** `list_knowledge`, `add_knowledge`, `update_knowledge`, `delete_knowledge`
- **Add:**
  ```py
  manage_knowledge(account_id: str, action: str, knowledge_id: str | None = None,
                   title: str | None = None, content: str | None = None) -> str
  ```
  `action ∈ {list, add, update, delete}`.
- **Card:** `action=list` → InfoResultCard; add/update/delete → confirmation. Route on `args.action`.

### M9 · Learned patterns → `manage_patterns` (4 → 1, ‑3)
- **Remove:** `list_learned_patterns`, `delete_learned_pattern`, `list_rule_patterns`, `delete_rule_pattern`
- **Add:**
  ```py
  manage_patterns(account_id: str, kind: str = "writing", action: str = "list",
                  pattern_id: str | None = None) -> str
  ```
  `kind ∈ {writing, rule}`, `action ∈ {list, delete}`. Internally hits
  `/email/learned-patterns` vs `/email/rules/patterns`.
- **Card:** this touches the just-shipped **PatternListCard**. It must now route on
  `manage_patterns` + read `args.kind` to pick the delete endpoint and `args.action`
  (list → editable card, delete → confirmation). Replaces the `list_learned_patterns` /
  `list_rule_patterns` keys in `PATTERN_META`.

### M10 · Sender actions → `sender_action` (3 → 1, ‑2)
- **Remove:** `unsubscribe_sender`, `keep_newsletter`, `set_cold_sender`
- **Add:**
  ```py
  sender_action(account_id: str, email: str, action: str,
                unsubscribe_link: str | None = None) -> str
  ```
  `action ∈ {unsubscribe, keep_newsletter, mark_cold, mark_warm}`. Keep the two *reads*
  (`suggest_unsubscribes`, `list_cold_senders`) separate.
- **Card:** 3 ACTION_META → 1.

### M11 · Digest → `digest` (2 → 1, ‑1)
- **Remove:** `get_digest`, `send_digest`
- **Add:** `digest(account_id: str, period: str = "day", send: bool = False)` — `send=True` emails it.
- **Card:** `send=False` → INFO; `send=True` → confirmation. Route on `args.send`.

### M12 · Sync → `sync_account` absorbs resync (2 → 1, ‑1)
- **Remove:** `resync_account`
- **Change:** `sync_account(account_id: str, full: bool = False, purge: bool = False)` —
  `full=True` → complete resync; `purge=True` → delete local first (confirm).
- **Card:** both ACTION → one.

### M13 · Labels management → `manage_labels` (2 → 1, ‑1) — OPTIONAL
- **Remove:** `list_labels`, `create_label`
- **Add:** `manage_labels(account_id: str, action: str = "list", name: str | None = None)` — `action ∈ {list, create}`.
- **Card:** `list` → INFO, `create` → confirmation. (Lowest-value merge; skip if minimising card churn.)

---

## Resulting set (40 tools)

Read/triage (4): `find_emails`, `read_email`, `read_thread`, `accounts`
Inbox actions (4): `manage_inbox`, `apply_labels`, `move_to_folder`, `manage_labels`
Drafting/sending (3): `draft_reply`, `send_message`, `send_draft`
Attachments (2): `list_artifacts`, `import_artifact`
Senders (2): `categorize_senders`, `list_senders`
Rules+history (13): `get_rules_and_settings`, `create_rule`, `create_rules_from_prompt`,
  `update_rule`, `manage_rule`, `reset_rules`, `run_rules_now`, `test_rule_match`,
  `learn_rule_pattern`, `install_default_rules`, `list_rule_history`, `resolve_execution`,
  `process_past_emails`
Config/knowledge/patterns (4): `update_assistant_settings`, `manage_knowledge`,
  `generate_writing_style`, `manage_patterns`
Follow-ups/reply-zero (3): `find_follow_ups`, `mark_thread_done`, `reclassify_reply_zero`
Unsubscribe/cold (3): `suggest_unsubscribes`, `list_cold_senders`, `sender_action`
Digest (1): `digest`
Sync (1): `sync_account`

---

## Card-router changes (`workbench/.../components/email/EmailToolCards.tsx`)

The router currently keys purely on tool **name**. Merged multi-action tools need it
to also read one arg (`action` / `kind` / `send`) to choose info-vs-confirmation:

- `LIST_TOOLS`: `{query_inbox, get_important_emails, search_emails, find_urgent, find_needs_reply}` → `{find_emails}`.
- `INFO_META`: drop `list_accounts, get_unread_count, get_account_overview, get_sender_categories, list_labels, list_knowledge, get_digest`; add `accounts`, keep `list_senders`, `list_rule_history`, `list_cold_senders`, `suggest_unsubscribes`, `list_artifacts`, `get_rules_and_settings`, `create_rules_from_prompt`, `test_rule_match`, `generate_writing_style`.
- `ACTION_META`: replace `{send_email, send_reply}`→`send_message`; `{approve,reject,undo}_execution`→`resolve_execution`; `{update_rule_state, delete_rule}`→`manage_rule`; `{unsubscribe_sender, keep_newsletter, set_cold_sender}`→`sender_action`; `{sync_account, resync_account}`→`sync_account`.
- `PATTERN_META`: `{list_learned_patterns, list_rule_patterns}` → `manage_patterns` (route by `args.kind` for the delete endpoint).
- New **action-aware** cards: `manage_knowledge` (list→info / else confirm), `digest` (send flag), `manage_labels` (list→info / create→confirm), `manage_patterns` (list→PatternListCard / delete→confirm). Add a tiny helper: `isListAction = args.action === "list" || args.send === false`.

---

## Compatibility / coordination (do NOT skip)

1. **Gateway quick-action callers.** `_register_agent_tools()` maps tool name → fn for
   direct importlib calls (runner.py, drafting.py, etc.). Any caller referencing a
   removed name breaks. Grep `agents\.(send_email|send_reply|list_knowledge|…)` and the
   `_register` lookups; update or add thin name aliases.
2. **INSTRUCTIONS** (203 lines) names tools throughout — rewrite references to the merged
   names/params. This also trims the ~3k-token system prompt.
3. **Docstrings** — the merged tools need one crisp docstring each documenting the
   `action`/`preset` enum. Net docstring tokens should *drop* (fewer tools) even though
   each is slightly longer.
4. **Frontend AG-UI cards** must land in the SAME PR as the tool rename or cards go blank
   for the renamed tools (the router keys on names).

## Risks / tradeoffs

- `action=` tools move part of the selection problem from tool-choice to param-choice.
  Mitigate by keeping enums small (≤4) and documenting them in the docstring. Net still a
  clear win for CRUD/variants; that's why semantically-distinct tools (create_rule vs
  create_rules_from_prompt, draft_reply vs send_*) are kept separate.
- Coordinated agent+FE change; ship behind the existing green-deploy gates, verify each
  merged card renders (tsc/eslint + a manual pass in the chat).

## Rollout order (suggested)

1. Land the pure-win merges first (no card ambiguity): M12 sync, M11 digest, M6
   resolve_execution, M7 manage_rule, M10 sender_action, M4 send_message. (‑8, all ACTION.)
2. Then the read merges: M1 find_emails, M2 read full, M3 accounts, M5 list_senders. (‑8.)
3. Then the CRUD/pattern cards (most FE work): M8 manage_knowledge, M9 manage_patterns,
   M13 manage_labels. (‑7.)
4. Trim INSTRUCTIONS + docstrings; re-measure fixed overhead (expect ~9.5k → ~6–7k tokens).
