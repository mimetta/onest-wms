# Architectural Decisions — Onest WMS

Every architectural decision, why it was made, and what it costs. Newest at the bottom.
When a decision is reversed, the original entry stays and a superseding entry is added —
this file is append-only in spirit, like the ledger it describes.

**Format:** context → decision → reasoning → consequences.

---

## D-01 — On-hand stock is derived, never stored

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Context.** The company's current system (AccCloud) stores stock as an editable number.
When it drifts from physical reality there is no way to find out why.

**Decision.** No table has a `quantity_on_hand` column. On-hand is the sum of an
append-only `stock_movements` ledger, exposed through views.

**Reasoning.** A stored quantity has no explanation attached to it. A ledger gives audit
trail, per-location and per-lot accuracy, and FIFO/FEFO traceability as a by-product rather
than as three more features to build. It also makes every discrepancy answerable: the
question "why is this 40 and not 45?" always has an answer.

**Consequences.** Every read of stock is an aggregate query, so indexing matters more than
it otherwise would. Opening balances have to enter as movements rather than as an initial
value (see D-05). Any future "recalculate stock" support script is impossible by
construction — which is the point.

---

## D-02 — Movements carry positive quantity with from/to direction

**Date:** 2026-08-10 · **Status:** Accepted (approved by owner) · **Phase:** 0

**Context.** The original brief specified `qty (+/-)` on each movement row — the
double-entry style where a transfer is two rows, one negative and one positive.

**Decision.** `qty` is always positive. Direction is carried by `from_location_id` and
`to_location_id`, either of which may be `NULL` to represent stock entering or leaving the
company. A transfer is one row, not two.

**Reasoning.** One physical hop equals one row. Movement history then reads as a path —
which is exactly what the "movement path" drill-down needs to show — rather than as a
sequence of half-entries the reader has to pair up mentally. It also makes a half-recorded
transfer structurally impossible, where the signed model needs a constraint to guarantee
the two legs agree.

**Consequences.** Anything expecting the signed form needs the `stock_ledger_entries` view,
which expands each row into `+`/`-` legs. On-hand is a `GROUP BY` over that expansion. The
check constraint `from_location_id IS NOT NULL OR to_location_id IS NOT NULL` is what stops
a movement that goes nowhere.

---

## D-03 — Corrections are reversing movements; the ledger is append-only

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** `stock_movements` rejects `UPDATE` and `DELETE` via a `BEFORE` trigger that
raises unconditionally, *and* has those privileges revoked from every role including
`service_role`. Corrections post a new opposing movement.

**Reasoning.** An audit trail that can be edited is not an audit trail. Belt and braces —
the trigger catches application mistakes, the revoked grant catches anyone connecting with
elevated credentials. Neither alone is enough: a superuser bypasses the grant, a `TRUNCATE`
bypasses the row trigger.

**Consequences.** Mistakes stay visible in history. This is a feature for auditability and
occasionally an annoyance for operators, who will ask to "just delete that line". The answer
is always a reversing document, and the UI should make that easy rather than hidden.

---

## D-04 — The QC gate lives on the lot, not the location

**Date:** 2026-08-10 · **Status:** Accepted, amended by D-14 · **Phase:** 0

**Decision.** `lots.qc_status` determines whether stock may be consumed. It is not inferred
from which location the stock is sitting in.

**Reasoning.** A lot that fails QC must become unavailable *everywhere at once*, including
any quantity already put away into storage before the result came back. Tying the gate to
location would leave that stock quietly issuable.

**Consequences.** `stock_available` filters on lot status at every location. See D-14 for
where the gate is enforced during posting — this decision says *what* the rule is, D-14 says
*when* it applies.

---

## D-05 — `in_transit` and `opening` are real locations

**Date:** 2026-08-10 · **Status:** Accepted (approach approved by owner) · **Phase:** 0

**Decision.** Two virtual location types beyond the brief's list: `in_transit` (for the
two-step transfer) and `opening` (for go-live balances).

**Reasoning.** Both are otherwise "states" that would have to be inferred by joining
documents to movements. As locations, in-transit stock is simply a ledger balance you can
query, chart and count like any other, and opening stock arrives through the same audited
path as everything else — so day one already has a clean trail instead of a magic starting
number nobody can explain later.

**Consequences.** `locations.is_virtual` marks them so they never appear in a bin picker or
get a printed label. Reports must decide whether to include in-transit in warehouse totals —
the default is yes, shown as a separate line.

---

## D-06 — Only `post_document()` writes to the ledger

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** `stock_movements` has no `INSERT` policy at all. One `SECURITY DEFINER`
function inserts movements, and every document type routes through it.

**Reasoning.** Concentrating the writes means the invariants — sufficiency, QC, tracking
discipline, locking, audit — are written once and cannot be forgotten by the eighth document
type or by a future developer in a hurry.

**Consequences.** `post_document()` is the highest-risk function in the system and needs the
heaviest test coverage. It bypasses RLS by design, so it must check permissions itself.
That is a deliberate, single, audited hole rather than a diffuse one.

---

## D-07 — Concurrency uses per-bin advisory locks

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** `pg_advisory_xact_lock(hashtext(product_id || '/' || from_location_id))`,
taken in sorted order across all lines of a document.

**Reasoning.** There is no stock row to lock — on-hand is derived (D-01), so `SELECT … FOR
UPDATE` has nothing to grab. The thing needing mutual exclusion is the *concept* of a
product-at-a-bin, which is what advisory locks are for. Sorted acquisition prevents two
concurrent posts touching the same pair of bins from deadlocking.

**Consequences.** Locks are transaction-scoped and release automatically. Hash collisions
between different product/bin pairs are possible and harmless — the cost is occasional
unnecessary serialisation, never incorrectness.

---

## D-08 — Document numbers are Gregorian and assigned at post time

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** Format `GR-2026-00001`. Gregorian year in the stored number; Buddhist era
appears only on printed Thai documents. Numbers are assigned when a document posts, not when
a draft is created.

**Reasoning.** Buddhist-era years in a stored key make sorting, range queries and any future
migration painful, and mixed BE/CE data is a classic source of silent off-by-543 errors.
Assigning at post time means an abandoned draft doesn't burn a number and leave a gap that
accounting has to explain.

**Consequences.** A draft has no document number, so the UI must identify drafts some other
way. Users who expect to see the number while drafting will need a visible "assigned when
posted" cue.

---

## D-09 — Permissions are data, not hard-coded role checks

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** A `role_permissions` table maps roles to permission strings
(`issue.approve`, `lot.set_qc_status`, `lot.dispose_unpassed`, …). Policies and functions
check `has_perm('…')`, never `role = 'admin'`.

**Reasoning.** The real approval chain is not yet known, and it will change as the company
reorganises. Configuration changes should be seed edits, not migrations.

**Consequences.** One extra lookup per check — negligible, and the helper is `STABLE`. It is
possible to configure a nonsensical permission set, so the seed is the documented baseline.

---

## D-10 — UOM conversions are per product

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** `product_uom_conversions` is keyed by product, not a global UOM conversion
table.

**Reasoning.** Drum → litre is a container size; litre → kg is density. Both vary per
product. A global table would be wrong for every solvent after the first.

**Consequences.** Each product needing conversions carries its own rows, and the importer
must populate them. A validation function checks that a path to the product's base UOM
exists.

---

## D-11 — Views start plain, not materialised

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** `stock_on_hand` and friends are ordinary views over an indexed ledger.

**Reasoning.** Correctness first. A plain view cannot go stale. At under 500 SKUs and the
expected volume, an indexed aggregate should be comfortably fast, and the decision is cheap
to reverse — a materialised view can replace a plain one behind the same name without
touching callers.

**Consequences.** Revisit in Phase 3 with real volume data. Pending answer on daily line
volume (Phase 1 question 12).

---

## D-12 — `tracking_mode` is immutable once a product has movements

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0

**Decision.** Trigger-enforced: a product's `tracking_mode` cannot change after its first
movement.

**Reasoning.** Switching a product from `none` to `lot` retroactively would leave historic
movements with no lot, making the ledger unreadable and lot balances wrong from the start.

**Consequences.** Getting the tracking mode wrong at setup requires creating a new SKU and
transferring the balance. The product form must make the choice prominent and explain that
it is permanent.

---

## D-13 — Posting checks on-hand at the source bin, not `stock_available`

**Date:** 2026-08-10 · **Status:** Accepted (correction from owner) · **Phase:** 0
**Supersedes:** the posting design in PLAN.md rev 1 §9

**Context.** Rev 1 had `post_document()` read `stock_available` for its sufficiency check.
`stock_available` excludes locations where `counts_as_available = false`.

**Decision.** The sufficiency check reads `stock_on_hand` for the exact
`(product, lot, serial, from_location)` tuple. `counts_as_available` drives pick
suggestions, dashboards and line-entry validation only — it is not a posting control.

**Reasoning.** The rev 1 design made four legitimate operations impossible, because each
sources from a location that is deliberately not "available":

| Operation | Sources from | Was refused because |
|---|---|---|
| Scrap or write off a failed lot | `qc_hold`, `quarantine` | not available |
| Settle consignment stock | `consignment_site` | not available |
| Ship a delivery note | `staging`, `shipping` | not available |
| Confirm a transfer receive leg | `in_transit` | not available |

The two ideas had been conflated. "Is there physically enough stock here to move?" and "may
this stock be picked for an order?" are different questions with different answers, and only
the first one is a posting invariant.

**Consequences.** Sufficiency is strictly per-bin — stock in `A-01-01` never satisfies a
movement out of `A-01-02`. Availability semantics move entirely into the UI and reporting
layer, which means a pick screen that ignores `stock_available` could suggest something
silly; that is a UI bug, not a data-integrity one.

---

## D-14 — The QC gate applies per movement class

**Date:** 2026-08-10 · **Status:** Accepted (correction from owner) · **Phase:** 0
**Amends:** D-04

**Context.** Rev 1 applied `qc_status = 'passed'` to every outbound movement. That means a
failed lot can never be scrapped — it is locked in the warehouse forever, which is the
opposite of what QC control is for.

**Decision.** Each movement is classified and the gate applied accordingly:

| Class | Rule |
|---|---|
| **Inbound** (`from_location_id IS NULL`) | No QC rule. Receiving is how lots enter `pending_qc`. |
| **Internal** (both endpoints internal) | No QC rule. Putaway out of `qc_hold`, moves to `quarantine` or `scrap`, transfers — all unrestricted. |
| **Consumption** (`issues`, `delivery_notes`, `consignment_settlements` where stock leaves our control) | `qc_status = 'passed'` required. Hard failure, no override. |
| **Disposal** (`adjustments` with an `is_disposal` reason, return to supplier) | Non-passed lots permitted, caller must hold `lot.dispose_unpassed` — seeded to `qc` and `admin`. |

Untracked products have no lot and so no QC status; they are guarded by location instead —
a consumption movement may not source from `qc_hold`, `quarantine` or `scrap`.

**Reasoning.** QC status controls whether stock may be *consumed or sold*, not whether it
may be *moved*. Internal relocation is safe without a gate because `stock_available` filters
on lot status at every location (D-04) — moving a failed lot from `qc_hold` to `storage`
does not make it available, it just puts it somewhere else. Disposal is the genuinely
sensitive case, because stock is leaving the building while not passed, so it is
permission-gated rather than blocked.

**Consequences.** `adjustment_reasons.is_disposal` becomes load-bearing: mis-flagging a
reason changes who may post it. The QC exemption keys off *why* stock is leaving rather than
a hard-coded list of reason codes, which is what keeps it configurable.

**Open interpretation.** The correction said QC-controlled moves "must be allowed for
qc/admin roles". This is implemented as *permitting* those moves for everyone, not
*restricting* them to qc/admin, since an internal relocation changes nothing about
availability. If the intent was to narrow internal moves of non-passed lots to qc/admin,
that is a `role_permissions` seed change behind a `lot.move_unpassed` permission, not a
migration. **Flagged to the owner; awaiting confirmation.**

---

## D-15 — `department_id` is stored on both requisitions and issues

**Date:** 2026-08-10 · **Status:** Accepted (correction from owner) · **Phase:** 0

**Decision.** Both `requisitions` and `issues` carry a `NOT NULL` `department_id` FK to
`departments`. The issue does not read it through its requisition.

**Reasoning.** An issue can be raised directly without a requisition, so
`issues.requisition_id` is nullable — and a department's consumption report must not depend
on a nullable join. Denormalising one FK is cheap; a consumption report that silently drops
direct issues is not.

**Consequences.** The two can disagree if an issue is edited after conversion. The
conversion copies the requisition's department, and any later change is captured in
`audit_log`.

---

## D-16 — Inter-warehouse `movement.warehouse_id` semantics are deferred

**Date:** 2026-08-10 · **Status:** Deferred (owner instruction) · **Phase:** 0

**Context.** `stock_movements.warehouse_id` is unambiguous while every movement stays inside
one warehouse. For a genuine warehouse-to-warehouse transfer it is not: the dispatch leg
belongs to the source, the receive leg to the destination, and a single column cannot
describe a row that spans both.

**Decision.** Not resolved now. The column stays, `NOT NULL`, and is populated from the
location involved. Single-warehouse operation makes the ambiguity unreachable in practice.

**Reasoning.** Deciding it now means guessing at requirements that do not exist yet. The
schema is already multi-warehouse-capable everywhere else, and the `in_transit` location
(D-05) already gives each leg a real endpoint — so when the question becomes live, both legs
are already modelled correctly and only this denormalised column needs a rule.

**Consequences.** Before a second warehouse goes live, this must be resolved. The likely
answer is that `warehouse_id` is derived from `from_location` for outbound legs and
`to_location` for inbound, or is dropped in favour of always joining through the location.
Any report grouping by `movement.warehouse_id` should be re-checked at that point.

---

## D-17 — AccCloud: CSV is the item-master path, the API is for reconciliation

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0 (recorded), Phase 4 (built)

**Context.** One AccCloud endpoint is confirmed:
`POST /api/support/Product/getProductRemain`, returning quantity on hand per product per
warehouse. Company code `MMT2025`. Authentication method and the existence of a full
item-master endpoint are still unknown.

**Decision.** CSV/Excel import remains the primary path for item master and opening
balances. The API is used for a read-only reconciliation report. Both sit behind one
`ErpAdapter` interface. Direction stays inbound-only — nothing is written back to AccCloud.

**Reasoning.** `getProductRemain` returns balances only — no lot, expiry, serial, UOM or
barcode — so it cannot populate an item master however convenient it would be. Treating it
as reconciliation plays to what it actually provides, and keeps the guaranteed-to-work CSV
path as the one the business depends on.

**Consequences.** Reconciliation compares at product+warehouse granularity; WMS lot detail
is drill-down, not part of the match. Three adapter requirements follow, all recorded in
PLAN.md §18:

1. The response field for the product name is documented inconsistently — `prodTName` in
   the spec table, `productName` in the example. The adapter accepts either and fails loudly
   if neither is present, rather than importing blank names.
2. `searchAll = 'N'` caps results at 1000. The adapter pages by `whCode` /
   `productGroupCode` and **raises if a response returns exactly the cap** — a silently
   truncated reconciliation reporting "no variances" is worse than one that fails.
3. Auth is injected, so the scheme can be settled later without reshaping the adapter.

`ACCCLOUD_COMPANY_CODE` lives in env, never in code.

---

## D-18 — `acccloud_master_id` is the preferred sync key

**Date:** 2026-08-10 · **Status:** Accepted (owner instruction) · **Phase:** 0

**Decision.** `products.acccloud_master_id` (numeric, unique, nullable) is added alongside
`acccloud_item_code`. Matching prefers `masterId` when present and falls back to `prodCode`.

**Reasoning.** `prodCode` is a human-facing code and can be renamed; `masterId` is
AccCloud's internal identifier and should not be. Matching on the stable one avoids an
import creating a duplicate product the day someone tidies up a product code.

**Consequences.** Nullable, because CSV exports may not include it and existing rows
pre-date it. The importer records which key it matched on in `erp_import_rows.mapped`, so a
fallback match is visible in the diff preview rather than silent.

**Verified:** `productGroupCode` needs no new table — the generic `erp_sync_map` with
`entity_type = 'category'` covers it. `whCode` did require adding `warehouse` to the
`entity_type` enum.

---

## D-19 — RLS is enabled but not forced

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0
**Amends:** PLAN.md rev 1 §10, which said `FORCE ROW LEVEL SECURITY` on every table

**Context.** `FORCE ROW LEVEL SECURITY` makes policies apply to the table owner as well as
to ordinary roles. That sounds strictly safer, and it is what rev 1 of the plan specified.

**Decision.** Every table gets `ENABLE ROW LEVEL SECURITY`. None get `FORCE`.

**Reasoning.** The whole write model depends on `SECURITY DEFINER` routines reading and
writing past the policies they exist to implement:

- `post_document()` inserts into `stock_movements`, which by design has **no** INSERT
  policy at all (D-06). Under FORCE, the only writer to the ledger could not write.
- `has_perm()` reads `user_profiles`. Under FORCE, the policy on `user_profiles` — which
  is written in terms of `has_perm()` — would recurse into itself.
- `audit_trigger()` inserts into `audit_log`, which is deliberately not writable by
  `authenticated`.

FORCE would not add protection here, because it only constrains the table owner, and the
owner is `postgres` — reachable solely through these audited functions or through a
service-role connection that never leaves the server. What actually protects the data is
unchanged: `anon` has no grants at all, `authenticated` gets only what the policies allow,
and the ledger's INSERT privilege is revoked from `authenticated` outright.

**Consequences.** A future `SECURITY DEFINER` function is implicitly trusted, so each one
must check permissions itself with `require_perm()` — `post_document()` does this on its
first line. If a later phase adds a definer function that skips that check, it becomes a
privilege-escalation hole with nothing behind it. Worth a review checklist item.

---

## D-20 — The QC role can post its own write-offs

**Date:** 2026-08-10 · **Status:** Accepted · **Phase:** 0
**Amends:** D-14

**Context.** Found by a test, not by reading. `qc` was seeded with `lot.dispose_unpassed`
and `adjustment.create` but not `adjustment.post`, so the scrap-a-failed-lot test failed
with `permission denied: adjustment.post is required`.

**Decision.** `qc` also holds `adjustment.post`. It does **not** hold `adjustment.approve`.

**Reasoning.** `qc` is the only role holding `lot.dispose_unpassed`. Without the ability to
post its own write-off, a failed lot could be raised for scrapping and then never actually
scrapped — the exact trap D-14 exists to remove, reintroduced one layer down in the
permission seed. Withholding `adjustment.approve` keeps the two-person check: QC raises and
posts the write-off, a manager approves it in between.

**Consequences.** A write-off of unpassed stock needs two people. If that proves too slow
in practice, granting `warehouse_manager` the `lot.dispose_unpassed` permission is a seed
change, not a migration (D-09).

**Note for the owner:** this interacts with a case worth deciding explicitly. A cycle-count
variance that *decreases* a `pending_qc` lot is classified as disposal, so it also requires
`lot.dispose_unpassed` — meaning a warehouse manager cannot post a count variance against
stock that is still awaiting QC. That is arguably correct (removing unpassed stock from the
record should involve QC) but it is a real operational constraint, not an accident.
