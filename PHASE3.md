# Phase 3 — closing the loop

**Written 19 Aug 2026. Go-live is 31 Aug 2026: 12 calendar days, 9 weekdays.**

Phase 0 built the ledger. Phase 1 got stock in and inspected. Phase 2 got it out. Phase 3 is
everything needed to keep the record *true over time* — counting, correcting, settling, and
noticing.

---

## 0. The schedule problem, before the plan

Phase 3 as originally scoped, plus the Phase 4 item-master importer that `GO-LIVE.md` D2
depends on, does not fit into 9 weekdays at the standard this project has held so far. Saying
so now is cheaper than discovering it on 30 August.

So this plan is split by what go-live actually *requires*, rather than by feature area.
The reasoning for each call is given, because the ranking is a judgement and you may disagree
with parts of it.

### Must exist on 31 Aug

| # | Item | Why it cannot wait |
|---|---|---|
| 3.1 | **ใบปรับปรุงสต๊อก · adjustment screen** | Today there is **no way to correct anything**. The ledger is append-only by design (D-03), so a correction *is* a new adjustment document — and no screen raises one except the QC write-off. A day-one miscount currently has no remedy at all. This is the single most go-live-critical gap. |
| 3.2 | **Opening balances for real stock** | The demo's opening balances were seeded. Real ones need entering and posting through `OPENING-WH01` (D-05, D-21). Nothing else in Phase 3 matters if day-one balances are wrong. |
| 3.3 | **Item master import** (Phase 4's importer, pulled forward) | `GO-LIVE.md` D2 assumes it. <500 SKUs *can* be typed by hand, which is the fallback if the importer slips — see question 3. |

### Should exist soon after, not necessarily on day one

| # | Item | Why it can follow |
|---|---|---|
| 3.4 | **ใบตรวจนับ · cycle count** | The schema is complete and good — `expected_qty_snapshot`, generated `variance_qty`, `recount_of_line_id`, blind/informed modes. But the *first* count is the opening balance (3.2), and routine cycle counting starts once there is history worth checking. A month of operating without it is survivable; a day without adjustments is not. |
| 3.5 | **Consignment settlement** | Two customer sites are live day one, but settlement is a monthly reconciliation, not a daily operation. Stock moves out correctly via delivery notes already (`is_consignment`); settling it can be a few weeks later. |
| 3.6 | **Alerts engine** | Min/max, expiry and QC-ageing rules. `alert_rules` and `alerts` exist and the dashboard has the panel; only the engine is missing. Genuinely valuable, genuinely not blocking — a warehouse that has run on a whiteboard can run one more month without automated reorder nudges. Needs an Edge Function and therefore the first legitimate use of `SUPABASE_SERVICE_ROLE_KEY` (`GO-LIVE.md` I1). |
| 3.7 | **Admin / user management screen** | Deferred since 1.2. Eight users, changing rarely. Until this exists, users are managed by SQL — which works, but only I or you can do it. Low risk, low urgency, small screen. |

### Carry-over defects and polish

| Item | Source | Size |
|---|---|---|
| Orphan empty draft requisitions when the department is changed | walkthrough, 19 Aug | small |
| `"bin holds 0"` where the truth is `"wrong lot"` — the sufficiency guard fires before the tracking check (D-58) | walkthrough, 19 Aug | small |
| ZPL label driver | deferred by design; only if a label printer is bought | medium |
| Hardware field reports against the three watch-points | ongoing | unknown |

---

## 1. 3.1 — ใบปรับปรุงสต๊อก · adjustments

The most important screen in Phase 3, because it is the system's only eraser — and it is
deliberately not an eraser at all, but a new movement in the opposite direction.

**Shape.** Reason code first, then scan-first lines: scan a bin, pick what's there (or name a
product not there, for a found-stock increase), enter the counted quantity, and the line records
the *difference* as a movement in or out of `OPENING`-style virtual space.

**Direction comes from the reason code.** `adjustment_reasons` already carries `direction`
(`increase` / `decrease`) and `is_disposal`. The screen never asks the operator for a sign;
picking "พบสินค้าเพิ่ม" (found) versus "ตัดจำหน่าย" (write-off) determines it. A sign the
operator can get backwards is a sign that will be got backwards.

**Approval stays with a manager**, and `is_disposal` reasons additionally require
`lot.dispose_unpassed` when the lot has not passed QC (D-14, D-39). That combination is why the
QC screen's one-click write-off adapts rather than self-approving.

**Not negotiable:** no edit, no delete, no "fix the number". Corrections are new documents all
the way down, and the reversing document links to what it reverses.

## 2. 3.2 — opening balances

Same mechanism the seed uses: a goods receipt sourcing from `OPENING-WH01`, so go-live stock
arrives through the identical audited path as every later receipt, and `OPENING` ends up holding
the exact negative of everything that predates the system (D-05, D-21).

Two possible routes, and the choice is question 2 below:

- **Trust AccCloud's balances**, import them, and let the first cycle count find the differences.
  Fast; wrong on day one by exactly however wrong AccCloud is.
- **Count the warehouse first**, enter counted quantities as the opening balance. Slower and
  needs bodies, but day one is then true by construction.

For lot-tracked chemicals this matters more than for fittings: an opening balance with no lot
numbers cannot support a recall, and lot numbers are not in AccCloud.

## 3. 3.4 — ใบตรวจนับ · cycle count

Design already settled by the schema, which is worth restating because it is unusually careful:

- **`expected_qty_snapshot`** is captured when the sheet is generated, so a movement during the
  count cannot retroactively change what the counter was measured against.
- **`variance_qty`** is a generated column — it cannot drift from its inputs.
- **`recount_of_line_id`** makes a recount a new line pointing at the old one, not an edit.
- **blind vs informed** — blind hides the expected quantity from the counter.

**A count does not post.** `cycle_count` has `posts: false`: counting is measurement, and
measurement moves nothing. Accepting a variance *generates an adjustment*, which then walks the
normal approval chain. That keeps one writer to the ledger and means a count cannot quietly
become a stock change.

**The known constraint** (`GO-LIVE.md`, `PHASE1.md`): a variance that *decreases* a `pending_qc`
lot classifies as disposal, so a warehouse manager cannot post it alone — only `qc` holds
`lot.dispose_unpassed`. Defensible, and it will be met the first time somebody counts the QC
hold area. Question 4.

## 4. 3.6 — alerts engine

Rules already modelled in `alert_rules`. The engine evaluates on a schedule and writes `alerts`
rows; the dashboard panel and acknowledge action already exist from Phase 1.

- **Min/max** — `product_min_max` per product/warehouse is already in the schema and joined by
  `stock_by_product`.
- **Expiry** — lots approaching `expiry_date`, at a per-product or global horizon.
- **QC ageing** — the `lot_qc_queue` view already computes `waiting_days` (D-40).

Runs as a Supabase Edge Function on a cron. This is the first thing in the project that needs
`SUPABASE_SERVICE_ROLE_KEY`, which was deliberately removed from Vercel until code read it
(`GO-LIVE.md` I1) — it goes back in the *same change* as the function, never before.

Delivery is question 5: in-app only, or email as well.

---

## 5. Consolidated questions

One list, as usual. Answers 1 and 2 change the shape of the plan; the rest change details.

1. **Scope for 31 Aug.** Do you accept the split above — adjustments, opening balances and the
   item master by go-live, with cycle count, consignment settlement, alerts and admin following
   after? If you want cycle count on day one too, something in the "must" list has to give, and
   I would rather you choose which than have me pick silently.

2. **Opening balances: count first, or import and reconcile?** My recommendation is **count
   first for lot-tracked raw materials** (the chemicals — where a missing lot number is
   unrecoverable) and **import-then-reconcile for finished goods, packaging and spares**. That
   splits the effort where it buys the most.

3. **Item master: importer or hand entry?** If the AccCloud export is available in the next day
   or two, the importer is better and reusable. If it slips, <500 SKUs is roughly a day of
   typing and removes a dependency from the critical path. Which do you want me to build
   against? (The export file is still outstanding — `PHASE1.md` question 5.)

4. **Count variance on unpassed stock.** A decrease against a `pending_qc` lot needs
   `lot.dispose_unpassed`, which only `qc` holds — so a manager cannot close such a variance
   alone. Keep it (QC gets pulled into count reconciliation), or grant managers the permission
   for count-generated variances specifically?

5. **Alerts delivery.** In-app panel only, or email as well? Email means an Edge Function with
   mail credentials and a decision about who receives what.

6. **Adjustment reason codes.** I need the real list the business uses — the seed has two
   placeholders (`FOUND`, `WRITE_OFF`). Wrong reason codes make the adjustment history useless
   for asking *why* stock moved, which is the whole point of recording a reason.

7. **Admin screen, or SQL until later?** Eight users, rarely changing. I lean SQL until after
   go-live; say if you'd rather have the screen.

8. **Consignment settlement timing** — confirm it can follow go-live. If either customer
   reconciles weekly rather than monthly, it moves up.

---

## 6. What I will not do without being asked

- Change the approval matrix further. D-56 was granted on request; the rest stands.
- Build the AccCloud *API* integration. Phase 4, and `PLAN.md` §18 still has open questions
  including the unresolved `prodConvFactor` direction (D-24).
- Add a reservation/allocation model. D-57 deliberately scoped pick-suggestion exclusion to the
  current document; treating every open document as a reservation hides real stock from a second
  picker and needs a release policy for abandoned drafts. That is a design decision for after
  go-live, informed by whether it actually bites.
