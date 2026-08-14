# Organization Identity — the customer's own mark inside the product

**Status: ◐ PARTIAL — OI-1 (logo) BUILT 2026-08-14 on
`claude/multi-tenancy-ai-metering-nr8zbj`, unmerged. OI-2…OI-5 SPEC ONLY.
Verified against code on 2026-08-14.**

> **This spec was written AFTER OI-1 was built, which is backwards and is
> recorded as such.** The owner asked for the logo upload mid-session; it was
> built, and two independent passes (verify + adversarial review) both flagged
> that no ACTIVE spec owned it — so the verifier had no acceptance contract and
> had to check the implementer's own claims, which is the one thing that role
> exists to avoid. This document exists to close that gap and to give OI-2…OI-5
> a contract *before* they are dispatched. Its §4 acceptance criteria were
> written from the shipped behaviour and are therefore weaker evidence than
> criteria written first; treat OI-1's row as "needs re-verification against
> this spec", not as verified.

---

## 1. Scope

A tenant is a company, and a company has an identity: a mark, a name, and
eventually a domain and a letterhead. **Organization Identity is where that
lives.** It is one surface (Settings → Organization), admin-gated, tenant-owned.

| # | Item | Gate | State |
|---|---|---|---|
| **OI-1** | **Logo upload + the shell lockup.** Admin uploads a raster logo; it replaces our mark top-left in every member's shell, above "powered by CommandCenter". | 🟢 AGENT-SAFE | ◐ built, unmerged |
| **OI-2** | **Tenant-scope the store.** `org_settings` must carry `organization_id`, widen its PK, and bind through the seam before a second customer shares a database. | 🔴 **BLOCKED on MT-1b** | 🔴 |
| **OI-3** | **First-paint branding.** The customer's mark must render on first paint, not after a fetch. | 🟢 AGENT-SAFE | 🔴 |
| **OI-4** | **Organization display name** — shown beside/instead of the logo, in the operator console, and on invoices (D38). | 🟢 AGENT-SAFE | 🔴 |
| **OI-5** | **Logo on billing documents** — the customer's mark on their own tax invoice. | 🔴 depends on D38's invoice renderer | 🔴 |

### Non-goals

- **Not a theme.** A customer picks a *theme* in Settings → Appearance, from
  our four. They do not get a custom palette, a custom font, or CSS. The
  theming engine is one product themed centrally (owner directive 2026-08-10);
  a per-tenant palette is the exact thing that directive forbids.
- **Not white-labelling.** "Powered by CommandCenter" is not removable. If a
  reseller SKU is ever sold, that is a commercial decision (a D-number), not a
  settings toggle.
- **Not vector art.** SVG is refused — see §3.
- **Not per-Center or per-user branding.** One mark per organization.

---

## 2. Where it lives, and the defect that placement carries

Logo bytes are stored in the **tenant** plane, in `org_settings` (key
`branding`), not in the Control Plane and not in object storage.

**The reasoning:** a logo is a single small org-wide document, read on every
page load, written twice in a company's life. That is the `org_settings` shape.
An object store would mean a bucket per tenant, a signing path, a lifecycle
policy and a second place tenant data can be left behind at deletion — for one
row. The Control Plane is the wrong plane: it holds *commercial* facts about a
customer (seats, credits, placement), not the customer's own content.

> ### ⚠️ OI-2 — `org_settings` is NOT tenant-scoped, and this row will collide
>
> An earlier version of this argument claimed tenancy came free because
> `org_settings` sat behind RLS like everything else. **That was false**, and it
> was load-bearing. The facts, each re-derived from the tree on 2026-08-14:
>
> - `infra/postgres/151_org_settings.sql:33` — PK is `key TEXT PRIMARY KEY`,
>   and its own comment says *"there is no per-tenant key namespace because
>   this deployment is one organisation."*
> - `tests/unit/test_tenancy_boundary.py:191` — `org_settings` is in
>   `BASELINE_UNSCOPED`, one of the 114 tables with no tenant key today.
> - `packages/acb_common/acb_common/org_settings.py:58,81` — a raw
>   `psycopg.connect()` binding no `app.tenant_id`, allow-listed in
>   `tests/unit/test_psycopg_seam.py:63` as *"a binding site the RLS work must
>   convert, not a permanent exemption."*
> - `infra/postgres/generated/03_constraints.sql:998-1008` adds
>   `organization_id` + FK + index but **never widens the PK**.
>
> **Two failure modes.** Before MT-1b promotion: tenant B's upload overwrites
> the one global `branding` row and tenant A's members render tenant B's logo.
> After promotion: the unbound connection reads zero rows under FORCE RLS, so
> every org's logo silently vanishes, and the write raises.
>
> **This is inherited, not introduced** — the `appearance` neighbour has the
> same shape. But branding is the first *content* placed in this table rather
> than a preference, and it is the most visible cross-tenant artifact the
> product has. **OI-2 is a hard prerequisite for customer #2**, not for
> customer #1 (CP-0: today the product can onboard exactly one customer, us).

---

## 3. The format rules, and why each one

Authority is the gateway. The frontend copy in `src/lib/orgBranding.ts` is
**advisory** — immediate feedback on an obviously-wrong file — and says so.

| Rule | Value | Why |
|---|---|---|
| Formats | PNG, JPEG, WebP | Raster only. |
| **SVG** | **refused, by name** | An SVG is a document that can carry script and external references, stored by one tenant and rendered in every colleague's shell. A 28px header slot does not need vector art enough to take that on. The refusal message says "export a PNG", because SVG is what a designer hands over and it is the likeliest rejection. |
| Max bytes | 128 KiB raw | Keeps the row a row rather than a file in a column — which is what §2's placement argument depends on. Also bounds what every member downloads on load. |
| Edge | 32–2048 px, longer side | Below is a favicon; above is a print asset. |
| Aspect | 0.5–8.0 (w/h) | Size alone does not stop a 1:20 sliver that renders as a 2px smear. |
| Type detection | **magic bytes only** | The declared content type is caller-controlled. The stored `data:` URI is *rebuilt* from the sniffed type — an echoed URI is a stored-XSS sink wearing an image's clothes. |

Header parsing is `apps/services/gateway/gateway/image_probe.py`: fixed offsets
and length-prefixed chunk walks, **no pixel decoding**, no dependency. The
trade is explicit — we verify the header, not the body, so a corrupt payload
renders broken in the browser rather than running a decoder over hostile input
on the server.

---

## 4. Acceptance

> ⚠️ Written from shipped behaviour (see the banner). OI-1 needs
> re-verification against these, not credit for having produced them.

**OI-1 — done when:**
1. An admin uploads a PNG/JPEG/WebP at `/settings/organization`; it renders
   top-left in the desktop sidebar and the mobile menu, above the attribution.
2. An org with no logo renders our own mark and a fallback caption —
   deliberately, not as an empty box.
3. A file whose declared type disagrees with its bytes is judged on the bytes,
   and the stored URI carries the sniffed type.
4. Every bound in §3 rejects with a message naming the actual problem.
5. `GET` is readable by any member; `PUT`/`DELETE` require
   `admin:settings:manage`, **asserted by a test that reads the route's
   dependency closure** (the idiom is `test_settings_appearance.py::_required_permissions`).
6. The settings preview renders the shell's own component, in a box width-matched
   to the rail — not a copy, and not in a roomier box.

**OI-2 — done when:** `org_settings` carries `organization_id`, its PK is
`(organization_id, key)`, the write path binds the tenant through the seam,
`test_tenancy_boundary.py` no longer lists it in `BASELINE_UNSCOPED`, and a
**two-org live-Postgres test** proves org A cannot read or overwrite org B's
branding row (R8 — a hermetic fake cannot show this).

**OI-3 — done when:** the server-rendered HTML for a member of an org with a
logo contains that logo, and does not contain the fallback caption. The pattern
already exists: `src/lib/theme/storage.ts`'s `STORAGE_KEYS.orgTheme` is cached
so a member "gets the company look on first paint instead of a flash of the
built-in default", and `boot.ts` reads it pre-paint.

---

## 5. Current file paths *(re-verify at dispatch — R4/§1.4)*

| Path | Role |
|---|---|
| `apps/services/gateway/gateway/image_probe.py` | header-only format + dimension probe |
| `apps/services/gateway/gateway/routes/settings.py` (`_BRANDING_KEY` onward) | `GET`/`PUT`/`DELETE /settings/branding` |
| `packages/acb_common/acb_common/org_settings.py` | the store — **the OI-2 conversion site** |
| `infra/postgres/151_org_settings.sql` | the table |
| `workbench/control_plane/src/lib/orgBranding.ts` | advisory pre-check, lockup decision, aspect maths |
| `workbench/control_plane/src/components/OrgBrandLockup.tsx` | `BrandMark` (presentational) + the linked lockup; one lockup for both shells |
| `workbench/control_plane/src/app/settings/organization/page.tsx` | the surface |
| `workbench/control_plane/src/app/api/settings/branding/route.ts` | BFF |
| `tests/unit/test_settings_branding.py` | probe + route tests |
| `workbench/control_plane/scripts/theme-check.mjs` | ⚠️ advisory theme harness — see §7 |

---

## 6. Verification commands

```bash
uv run pytest tests/unit/test_settings_branding.py -q
uv run ruff check . --select F821,F601,F602,F502,F7,B006      # the blocking CI gate

cd workbench/control_plane
npx tsc --noEmit
npx vitest run src/lib/orgBranding.test.ts
npx vitest run src/lib/theme/                                  # 8 conformance rules

# The theme pass (advisory — §7). Needs a dev server on :3001.
npm run dev &
node scripts/theme-check.mjs
```

---

## 7. Gate labels and standing warnings

- **OI-1, OI-3, OI-4 — 🟢 AGENT-SAFE.**
- **OI-2 — 🔴 BLOCKED**, not owner-gated: it is dispatchable the moment MT-1b's
  promotion lands, and not before.
- **OI-5 — 🔴** until D38's invoice renderer exists.

> ⚠️ **`scripts/theme-check.mjs` is ADVISORY and must not be described as
> coverage.** Nothing runs it in CI; putting a browser in the PR job is an
> owner decision. It also has two open defects of its own, recorded here rather
> than in a commit message nobody re-reads: it is a **second Playwright seam**
> beside `e2e/` + `playwright.config.ts` + `scripts/run-e2e.mjs` (CLAUDE.md §4:
> extend the shared seam, never add a parallel one), and it hardcodes a POSIX
> browser path that breaks the Windows primary dev box — which is the exact
> reason `run-e2e.mjs` resolves the browser instead. Folding it into `e2e/` is
> owed.
>
> Its own history is the argument for R7: the first version's `clipped`
> assertion **could not fail in the case it was written for** (it matched the
> outer flex container, which is never truncated) and was reported as a working
> fence. It is honest now only because a mutation test was run against it.
