# Email App — Feature Review & Gap Analysis

> **Date:** 2026-06-20 · **Scope:** `workbench/control_plane/src/app/email`,
> `apps/gateway/gateway/routes/email.py`, `apps/email_ingestion`,
> `infra/postgres/17_email_accounts.sql`
> **Related plan:** `spec_email_ai_assistant.md`

This document reviews the email client against the goal of a *fully-featured,
two-way-synced* inbox (parity with the Outlook/Gmail experience) and records the
fixes made in this pass plus what remains for later phases.

---

## 1. What was broken (and is now fixed)

### 1.1 Clicking an email showed a blank reading pane (the headline bug)
**Root cause (two compounding issues):**
1. **Outlook sync never stored a body.** `OutlookProvider.list_messages` selected
   only `bodyPreview`, so synced messages had empty `body_text`/`body_html`.
   Because the body was empty (not over the size cap), `body_truncated` was
   `false`, so even the "Load full message" affordance never appeared.
2. **`EmailDetail` only rendered plain text** (`email.bodyText`) and never fetched
   the full message — HTML-only emails (most of Gmail) also rendered blank.

**Fix:**
- New **`MessageContent`** component renders HTML in a **sandboxed `<iframe srcDoc>`**
  (no script execution, links open in new tab, auto-sized height) and falls back
  to pre-wrapped plain text.
- **`EmailDetail` now lazily fetches the full message** (`GET /email/messages/{id}`)
  on selection when the list row lacks a body/attachments, with a loading state.
- **Gateway `get_message` hydrates the body on demand**: when the stored body is
  empty it fetches the full message from the provider, persists body + attachment
  metadata, and returns it — so the first open is correct and subsequent opens are
  instant.

### 1.2 No two-way sync — actions stayed local
**Before:** `PATCH /messages/{id}` (read/star/flag/move) and `DELETE` only mutated
the local Postgres cache; nothing was pushed to Gmail/Outlook. Marking read or
flagging in CommandCenter did **not** reflect in the real mailbox.

**Fix — provider write-back:**
- New high-level provider methods on `BaseEmailProvider`:
  `apply_flags(is_read, is_starred, is_flagged)` and `move_to_folder(canonical)`
  (default no-ops so IMAP degrades gracefully).
- **Gmail** translates to label mutations (`UNREAD`/`STARRED`/`IMPORTANT`,
  archive = remove `INBOX`, trash, spam).
- **Outlook** PATCHes `isRead`/`flag` and uses `/move` to well-known folders;
  `trash_message` moves to Deleted Items.
- `update_message` and `delete_message` now call these **best-effort** after the
  local commit (local state is authoritative for UX; provider write failures are
  logged, not surfaced as user errors). Opening an email marks it read on the
  provider too.

### 1.3 Folders were not really pulled from the mailbox
**Before:** the sidebar was hardcoded to 7 system folders; `mergeFolders` mapped
provider folders **onto** those keys and dropped everything else, so user-created
Outlook folders / Gmail labels never appeared. Worse, `fetchEmails` rebuilt the
folder list from the *currently loaded page*, clobbering the provider folder tree
and zeroing every other folder's count.

**Fix:**
- `mergeFolders` now emits **canonical system folders + the provider's own user
  folders/labels** (keyed by canonical name, sorted, with a generic folder icon),
  filtering out Gmail's reserved system labels. The sidebar mirrors the real
  mailbox structure.
- `fetchEmails`/`updateEmail`/`deleteEmail` **no longer clobber** the provider
  folder list.
- Added **`Junk`** as a first-class system folder (replacing the non-functional
  "Labels" pseudo-folder).

### 1.4 Only Inbox + Sent were ever synced
**Before:** initial sync fetched inbox + sent only, so Archive/Drafts/Junk/Trash
always looked empty.

**Fix:** initial sync now iterates the standard folders —
Outlook: `inbox, sent, drafts, archive, junk, trash`;
Gmail: `INBOX, SENT, DRAFT, SPAM, TRASH` — normalizing each to its canonical key.

### 1.5 Outlook statuses (importance/categories) were dropped
**Before:** `importance` was never captured; Outlook categories were flattened
into `labels` with no surfacing in the detail view.

**Fix:**
- New `importance` (`high|normal|low`) and `categories` fields end-to-end:
  provider → `EmailMessage` → sync upserts → `email_messages` columns
  (migration `18_email_message_status.sql`) → API model → TS types.
- UI surfaces: **importance** (red ⚠ in list + "Important" badge in detail),
  **flag** (amber flag in list + "Flagged" badge), **categories** (chips in list
  and detail). Read/unread already worked and is preserved.

### 1.6 Sidebar search did nothing
The search box held local state only. It is now wired to the store's debounced
full-text search (`onSearch` → `setSearchQuery`).

---

## 2. Files touched

| Area | File | Change |
|------|------|--------|
| Frontend | `components/MessageContent.tsx` | **New** — sandboxed HTML/plain-text body renderer |
| Frontend | `components/EmailDetail.tsx` | Lazy full-message fetch, HTML render, importance/flag/category badges |
| Frontend | `components/EmailList.tsx` | Importance/flag indicators, category chips |
| Frontend | `components/AccountSidebar.tsx` | User-folder icons, wired search |
| Frontend | `lib/emailStore.ts` | Provider folder tree (system + user), stop clobbering folders |
| Frontend | `lib/api.ts` / `lib/types.ts` | `importance` + `categories` mapping/types |
| Backend | `routes/email.py` | Lazy body hydration, two-way write-back, importance/categories plumbing, provider helpers |
| Backend | `providers/base.py` | `apply_flags` / `move_to_folder`, `importance`/`categories` on `EmailMessage` |
| Backend | `providers/gmail.py` | Flag/move translation, multi-folder initial sync, importance |
| Backend | `providers/outlook.py` | Flag/move via Graph, multi-folder sync, importance/categories, body select |
| Backend | `email_ingestion/scheduler.py` | Persist importance/categories on background sync |
| Schema | `infra/postgres/17_email_accounts.sql`, `18_email_message_status.sql` | `importance`, `categories` columns + index |

---

## 3. Known limitations / next phase

- **Incremental sync is inbox-only.** Outlook delta + Gmail history watch the
  inbox; mail that arrives in other folders refreshes on the next *full* sync
  (reconnect) rather than instantly. Next: per-folder delta or lazy folder sync
  on selection.
- **Outlook `/move` returns a new message id.** After a move, the stored
  `provider_message_id` can go stale until the next sync re-keys it. Low impact
  (local folder is already correct) but should be reconciled.
- **Gmail user-label names** aren't resolved to display chips yet (only system
  importance is surfaced); needs a label-id→name map fetched alongside folders.
- **"Star" on Outlook** has no provider equivalent — kept as a local-only marker
  (flag is the synced analogue).
- **Move / Label toolbar buttons** in the list/detail are still placeholders
  (no folder/label picker UI yet); the underlying `move_to_folder` API exists.
- **Drafts** aren't composed/saved server-side yet; compose → send works, but
  there's no draft autosave.
- **Threading/conversation view** — messages carry `thread_id` but the UI is flat.

These map to Phases 3–4 of `spec_email_ai_assistant.md`.
