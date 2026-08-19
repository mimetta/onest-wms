import { describe, expect, it } from "vitest";
import { withRollback } from "./helpers/db";
import { giveStock, makeLot, seedWorld } from "./helpers/fixtures";

/**
 * Adjustment reason codes, and the QC gate they do NOT control.
 *
 * Both facts here were wrong in the codebase until 19 Aug 2026, and both were
 * wrong quietly:
 *
 *   - the codes lived only in seed.sql, so a fresh production project would have
 *     applied migrations, skipped the seed (GO-LIVE.md D1), and produced an
 *     adjustment screen with nothing to pick
 *   - a schema comment claimed is_disposal drives the disposal class, which sent
 *     the screen's "needs QC" warning to the wrong field
 */

describe("adjustment reason codes are schema, not seed", () => {
  it("exist after migrations alone, with the codes the owner confirmed", async () => {
    await withRollback(async (db) => {
      const rows = (await db.query(
        "select code from adjustment_reasons order by code",
      )) as unknown as { code: string }[];
      const codes = rows.map((r) => r.code);

      // The nine confirmed by the business, plus the two directed pairs.
      for (const expected of [
        "DAMAGE",
        "SPILL",
        "EVAP",
        "EXPIRED",
        "SCRAP",
        "RETURN_SUP",
        "SAMPLE",
        "FOUND",
        "OPENING",
        "COUNT_VAR_UP",
        "COUNT_VAR_DOWN",
        "SYS_CORR_UP",
        "SYS_CORR_DOWN",
      ]) {
        expect(codes, expected).toContain(expected);
      }
    });
  });

  it("has no ACTIVE code without a direction", async () => {
    await withRollback(async (db) => {
      // A 'both' code is refused for lines by the screen (D-61), so an active one
      // is a code nobody can use — the failure mode that put a red banner in
      // front of anyone opening the screen cold.
      const rows = await db.query(
        "select code from adjustment_reasons where is_active and direction = 'both'",
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("keeps the superseded codes readable rather than deleting them", async () => {
    await withRollback(async (db) => {
      // Adjustments reference their reason code. Deleting master data a document
      // points at would make the history stop meaning what it meant.
      const rows = (await db.query(
        `select code, is_active from adjustment_reasons
          where code in ('COUNT_VAR', 'SYS_CORR')`,
      )) as unknown as { code: string; is_active: boolean }[];

      // On a fresh database they never existed, which is fine; where they do
      // exist they must be present and inactive, never removed.
      for (const r of rows) expect(r.is_active).toBe(false);
    });
  });
});

describe("the QC gate follows the movement, not the reason flag", () => {
  it("refuses a NON-disposal decrease of an unpassed lot", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);

      // SAMPLE: direction decrease, is_disposal FALSE. The comment used to claim
      // the flag governed the gate, which would make this post cleanly.
      const reason = await db.value(
        "select id from adjustment_reasons where code = 'SAMPLE'",
      );
      const lot = await makeLot(db, w.products.lotTracked, `L-PEND-${w.tag}`);
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.storage,
        qty: 100,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.manager,
      });

      await db.setupAs(w.users.manager);
      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, reason, w.users.manager],
      );
      await db.query(
        `insert into adjustment_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 10, $4, $5)`,
        [adj, w.products.lotTracked, lot, w.uoms.kg, w.locations.storage],
      );

      const msg = await db.expectError(() => db.post("adjustment", adj));
      expect(msg).toContain("lot.dispose_unpassed");
    });
  });

  it("allows the same decrease once the lot has passed", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const reason = await db.value(
        "select id from adjustment_reasons where code = 'SAMPLE'",
      );
      const lot = await makeLot(
        db,
        w.products.lotTracked,
        `L-OK-${w.tag}`,
        "passed",
        w.users.qc,
      );
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.storage,
        qty: 100,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.manager,
      });

      await db.setupAs(w.users.manager);
      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, reason, w.users.manager],
      );
      await db.query(
        `insert into adjustment_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 10, $4, $5)`,
        [adj, w.products.lotTracked, lot, w.uoms.kg, w.locations.storage],
      );

      // The gate is about QC status, not about being an adjustment — so a
      // manager can take a passed sample without QC involvement.
      const docNo = await db.post("adjustment", adj);
      expect(docNo).toMatch(/^AJ-\d{4}-\d{5}$/);
      expect(await db.onHand(w.products.lotTracked, w.locations.storage, lot)).toBe(90);
    });
  });

  it("posts an increase without QC involvement, since nothing is leaving", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const reason = await db.value(
        "select id from adjustment_reasons where code = 'FOUND'",
      );
      // Found stock, lot still awaiting QC — the state resolveLot() leaves it in.
      const lot = await makeLot(db, w.products.lotTracked, `L-FOUND-${w.tag}`);

      await db.setupAs(w.users.manager);
      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, reason, w.users.manager],
      );
      await db.query(
        `insert into adjustment_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, to_location_id)
         values ($1, 1, $2, $3, 25, $4, $5)`,
        [adj, w.products.lotTracked, lot, w.uoms.kg, w.locations.storage],
      );

      // Classifies as inbound, so no disposal permission is needed — finding a
      // drum must not require the QC role, or nobody will record finding drums.
      const docNo = await db.post("adjustment", adj);
      expect(docNo).toMatch(/^AJ-\d{4}-\d{5}$/);
      expect(await db.onHand(w.products.lotTracked, w.locations.storage, lot)).toBe(25);
    });
  });
});
