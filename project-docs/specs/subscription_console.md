# Subscription Console — the customer-facing billing surface (WS-30)

**Status:** SPEC — nothing built · **Date:** 2026-08-09 · verified against code
2026-08-09 (repo-wide grep: zero hits for `module_catalog`, `org_module_entitlement`,
`user_module_seat`, `ModuleGate`, `entitlement_mask` — MT-2's substrate does not
exist yet, so nothing here is dispatchable before MT-2's tables land) ·
**Owner:** WS-30 (this spec) · **Decisions:** **D23 + D24** (work_plan.md §3,
2026-08-10 — Center packages are the governing pricing shape, carrying D19's
credit/seat rules; D24 closed every customer-framing question: ₹600 headline
stays, all-Centers seat ₹1,800, Complete ₹3,000, role presets in SC-2). None may
be re-litigated here; purchase-flow copy is buildable. Standing page rules: a
typical-month credit anchor, and no internal vocabulary (atoms/slices/modules)
customer-facing.

> ⚠️ **Substrate moved — D32.2 (2026-08-12).** The tables this console reads
> (`org_module_entitlement`, `user_module_seat`, `credit_ledger`, `usage_rollup`,
> `invoice`) now live in the **central Control Plane service**, not in each
> CommandCenter deployment: **`specs/platform_control_plane.md` (WS-31)**. This
> console becomes a **client** of that service rather than a reader of CC-local
> tables. **Nothing about its scope, its surfaces or its access rules changes** —
> SC-1/SC-2/SC-3 read exactly as written, and D19.3's hard cap, D23's Center
> framing and D24's customer framing are all carried unchanged. Update the data
> source, not the design. The seat vocabulary it renders (purchased / assigned /
> available) is defined once in WS-31 §3.3 — do not recompute it here.

**What this is.** The console a **customer's org admin** uses to manage their
Command Center subscription: see what **Centers and add-ons** they own (modules
are internal atoms, never the customer frame — D23), assign seats, watch AI
credit burn, and request changes. It is the customer-side complement of the
**Operator Console** (`saas_multitenancy.md` §4.1a, `/operator`, MT-4) — the two
share tables and must never share routes: the Operator Console is staff-only and
cross-org; this console is one org, admin-gated, tenant-scoped.

**Launch posture (D19.4): manage-only.** View + assign within purchased caps +
request changes fulfilled manually (Phase-2 "invoice by hand" per
`saas_multitenancy.md` §5). Online checkout, card/UPI payment and credit top-up
arrive with MT-4 and are **SC-4**, deliberately last.

---

## 1. Scope and non-goals

**In scope:** the `/settings/billing` surface in the workbench (the URL already
promised by `NotEntitled.upgrade_url`, `saas_multitenancy_implementation.md` §4.2);
its gateway endpoints; seat assign/unassign writes under the D19.3 rules; a
change-request flow that lands in the operator's inbox.

**Non-goals:** payment processing (MT-4/SC-4) · the Operator Console (MT-4) · the
entitlement tables and enforcement seam themselves (MT-2) · metering and the rate
card (MT-3) · dunning, invoicing, tax (the processor's job, §4.3) · any surface a
non-admin member sees (members get the `ModuleGate` upsell fallbacks, not this
console).

## 2. The surfaces (each is an acceptance unit)

### SC-1 — Read views *(after MT-2 tables + MT-3 ledger exist)*
- **SC-1a Centers & add-ons panel** *(re-shaped by D23, 2026-08-10)*. **Center
  packages are the primary purchase framing** (per-user counts on each Center,
  ₹600 app-bearing / ₹300 slices-only), with the org-wide add-ons (Builder,
  Workflows) and the Complete bundle beside them; `module_catalog` rows are the
  internal atoms and never the customer-facing frame. Each shows the org's
  entitlement state (`active | trial(expiry) | locked`), price, and seats
  purchased vs assigned.
  Locked modules render as upsell cards (the §2.4 rule 1 lever), never hidden.
  When a user's stacked a-la-carte seats cost more than the covering tier, the
  panel surfaces the swap as a savings prompt (§2.4a rule 2). **Done when:** a
  two-org fixture shows org A its own entitlements and never org B's; a locked
  module renders its card with a request-CTA; the savings prompt is pinned by a
  test case where a-la-carte sum > tier price; the panel is driven entirely by
  `/auth/me`'s `modules` + one `GET /billing/summary` call.
- **SC-1b Credit monitor.** Balance (credits + ₹), burn this cycle, per-module
  burn chart from `usage_rollup`, the 80% alert state, BYOK orgs see consumption
  with "not billed — your key" labelling (§3.4). **Done when:** the displayed
  balance equals `SUM(credit_ledger.delta)` for the org in the fixture; a
  `usage_event` written for module X moves only X's bar.
- **SC-1c Invoice list.** Read-only mirror of the `invoice` table (§4.1b). **Done
  when:** rows render from the mirror with no provider round-trip on the request
  path.

### SC-2 — Seat writes *(the D19.3 rules, verbatim)*
`POST /billing/seats` assign/unassign — the primary surface is the **users ×
Centers grid** (D23): assigning a Center package is ONE act creating the billing
seat + `org_group` membership + module entitlements + D12 slice grants
(`source='center'`), and unassignment reverses all four. Add-ons are a per-user
column (`source='alacarte'`); the **all-Centers seat (₹1,800, D24.3)** and the
Complete bundle (₹3,000) expand as `source='plan'`. **Role presets are launch
scope (D24.5):** named presets ("Sales rep", "Field staff", "Founder") generate
a member's row in the grid, adjustable after — the first-purchase flow is
"assign roles", never "fill a matrix". **Done when (presets):** applying a
preset writes exactly its packages/add-ons in the one-assignment act;
re-applying is idempotent; adjusting after never re-applies the preset.
**Hard cap:** assignment beyond
`seats_purchased` returns a 409 with a buy-more payload — never auto-upgrades.
Core seats are **not managed here**: membership is the Core seat (D19.3), so the
member admin surface is the only place Core count changes. **Done when:** the
cap 409 is pinned by a test; unassignment frees the seat immediately; every write
lands an audit row; the pushed processor quantity (once MT-4 exists) equals
`COUNT(user_module_seat)` — until then the count is the invoice input the operator
reads.

### SC-3 — Change requests *(the manual-fulfilment bridge)*
`POST /billing/requests` (add module / change seat count / cancel). Creates a
durable request row + notifies the operator; the customer sees request status.
Fulfilment is the operator editing entitlements — **🔴 OWNER-GATE to execute**
during the silo phase, exactly like every live entitlement change. **Done when:**
a request round-trips to visible status; nothing in the request path mutates
entitlements directly.

### SC-4 — Checkout + top-up *(with MT-4; not before)*
Razorpay-only (D19.5) behind the `payment_provider` seam. Not specced further
here until MT-4's ticket contract is written.

## 3. Access

The console requires the customer-admin capability (`admin:members:read` floor —
same floor as `/admin`, `routes/admin/_common.py`), inside the `core` module, on
the org resolved by the session — never from request input
(`user_management_contract.md` R11/R3). All queries run through the tenant-bound
seam (R5); the console must be impossible to render cross-org by construction.

## 4. Open design items (engineering, not owner)

1. **`usage_event.module_slug` attribution rule** — a chat agent that reads Email
   and writes CRM burns credits under which module? Owned by **MT-3** (the metering
   hook decides at write time); SC-1b consumes whatever rule MT-3 records. The rule
   must be written into `saas_multitenancy.md` §3.2 when MT-3's contract is drafted.
2. **Seat↔identity join** — `user_module_seat.user_id` (control plane UUID) vs the
   email-keyed tenant plane; the console needs the hop for the assignment picker.
   Owned by MT-1a's identity model (`user_identity`/`org_membership`, migration 159).

## 5. Verification

`uv run pytest tests/unit/test_billing_console*.py` (to be created per slice) ·
`cd workbench/control_plane && npx tsc --noEmit && npx vitest run` · the two-org
fixture from MT-1i reused for every SC-1 read test.

## 6. Sequencing

MT-2 tables → SC-1a → (SC-1b after MT-3's ledger) → SC-2 → SC-3 → (SC-4 with
MT-4). SC-3's *flow* can be built against MT-2 alone — it is the piece that lets
you sell before billing automation exists.

## Gate labels

Building every surface: **AGENT-SAFE**. Fulfilling a change request, editing any
live org's entitlements, granting the console to a real customer admin:
**OWNER-GATE** (work_plan.md §6).
