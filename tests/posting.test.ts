import { describe, expect, it } from "vitest";
import { withRollback } from "./helpers/db";
import { giveStock, makeLot, seedWorld } from "./helpers/fixtures";

/**
 * These are the cases that the first design got wrong. Every one of them
 * sources from a location where counts_as_available is false, and every one
 * of them must nonetheless post (D-13).
 */
describe("sufficiency is checked at the source bin, not at 'available' stock", () => {
  it("ships a delivery note out of staging", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.staging,
        qty: 12,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      const dn = await db.value(
        `insert into delivery_notes (warehouse_id, partner_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.partners.customer, w.users.staff],
      );
      await db.query(
        `insert into delivery_note_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 12, $3, $4)`,
        [dn, w.products.untracked, w.uoms.pcs, w.locations.staging],
      );

      const docNo = await db.post("delivery_note", dn);
      expect(docNo).toMatch(/^DN-\d{4}-\d{5}$/);
      expect(await db.onHand(w.products.untracked, w.locations.staging)).toBe(0);
    });
  });

  it("settles consignment stock from a customer site", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.consignment,
        qty: 8,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      const cs = await db.value(
        `insert into consignment_settlements
           (warehouse_id, partner_id, location_id, status, created_by)
         values ($1, $2, $3, 'approved', $4) returning id`,
        [w.wh, w.partners.customer, w.locations.consignment, w.users.staff],
      );
      await db.query(
        `insert into consignment_settlement_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 5, $3, $4)`,
        [cs, w.products.untracked, w.uoms.pcs, w.locations.consignment],
      );

      await db.actAs(w.users.admin);
      const docNo = await db.post("consignment_settlement", cs);
      expect(docNo).toMatch(/^CS-\d{4}-\d{5}$/);
      expect(await db.onHand(w.products.untracked, w.locations.consignment)).toBe(3);
    });
  });

  it("scraps a failed lot out of qc_hold", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(db, w.products.lotTracked, "L-BAD", "failed", w.users.qc);
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.qcHold,
        qty: 200,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.qc,
      });

      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.reasons.disposal, w.users.qc],
      );
      await db.query(
        `insert into adjustment_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 200, $4, $5)`,
        [adj, w.products.lotTracked, lot, w.uoms.kg, w.locations.qcHold],
      );

      // qc holds lot.dispose_unpassed, so this must succeed.
      await db.actAs(w.users.qc);
      const docNo = await db.post("adjustment", adj);
      expect(docNo).toMatch(/^AJ-\d{4}-\d{5}$/);
      expect(await db.onHand(w.products.lotTracked, w.locations.qcHold, lot)).toBe(0);
    });
  });

  it("refuses to scrap a failed lot without lot.dispose_unpassed", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(
        db,
        w.products.lotTracked,
        "L-BAD2",
        "failed",
        w.users.qc,
      );
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.qcHold,
        qty: 50,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.manager,
      });

      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.reasons.disposal, w.users.manager],
      );
      await db.query(
        `insert into adjustment_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 50, $4, $5)`,
        [adj, w.products.lotTracked, lot, w.uoms.kg, w.locations.qcHold],
      );

      await db.actAs(w.users.manager);
      const msg = await db.expectError(() => db.post("adjustment", adj));
      expect(msg).toContain("lot.dispose_unpassed");
    });
  });

  it("does not let stock in one bin satisfy a movement out of another", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.storage,
        qty: 100,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.staff],
      );
      // Sourcing from storage2, which is empty, while storage holds 100.
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 1, $3, $4)`,
        [iss, w.products.untracked, w.uoms.pcs, w.locations.storage2],
      );

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() => db.post("issue", iss));
      expect(msg).toContain("insufficient stock");
    });
  });
});

describe("the QC gate applies by movement class", () => {
  it("blocks issuing a pending_qc lot", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(db, w.products.lotTracked, "L-PEND2");
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.picking,
        qty: 100,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.staff],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 10, $4, $5)`,
        [iss, w.products.lotTracked, lot, w.uoms.kg, w.locations.picking],
      );

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() => db.post("issue", iss));
      expect(msg).toContain("QC status");
    });
  });

  it("cannot be overridden, even by admin", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(db, w.products.lotTracked, "L-PEND3");
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.picking,
        qty: 100,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.admin,
      });

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.admin],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 10, $4, $5)`,
        [iss, w.products.lotTracked, lot, w.uoms.kg, w.locations.picking],
      );

      await db.actAs(w.users.admin);
      const msg = await db.expectError(() =>
        db.post("issue", iss, { overrideNegative: true, reason: "please" }),
      );
      expect(msg).toContain("QC status");
    });
  });

  it("blocks an untracked product being issued out of quarantine", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.quarantine,
        qty: 10,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.staff],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 5, $3, $4)`,
        [iss, w.products.untracked, w.uoms.pcs, w.locations.quarantine],
      );

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() => db.post("issue", iss));
      expect(msg).toContain("not cleared for issue");
    });
  });

  it("lets warehouse staff put a pending lot away without QC rights", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(db, w.products.lotTracked, "L-PUTAWAY");
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.qcHold,
        qty: 200,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      const tr = await db.value(
        `insert into transfers
           (warehouse_id, from_warehouse_id, to_warehouse_id, status, created_by)
         values ($1, $1, $1, 'approved', $2) returning id`,
        [w.wh, w.users.staff],
      );
      await db.query(
        `insert into transfer_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, $3, 200, $4, $5, $6)`,
        [
          tr,
          w.products.lotTracked,
          lot,
          w.uoms.kg,
          w.locations.qcHold,
          w.locations.storage,
        ],
      );

      await db.actAs(w.users.staff);
      await db.post("transfer", tr);
      await db.post("transfer", tr);

      expect(await db.onHand(w.products.lotTracked, w.locations.storage, lot)).toBe(200);
    });
  });
});

describe("negative stock", () => {
  it("is blocked by default", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.admin);

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.admin],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 5, $3, $4)`,
        [iss, w.products.untracked, w.uoms.pcs, w.locations.picking],
      );

      const msg = await db.expectError(() => db.post("issue", iss));
      expect(msg).toContain("insufficient stock");
    });
  });

  it("is permitted with the right role and a reason, and is audited", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.admin);

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.admin],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 5, $3, $4)`,
        [iss, w.products.untracked, w.uoms.pcs, w.locations.picking],
      );

      await db.post("issue", iss, {
        overrideNegative: true,
        reason: "urgent production line stop",
      });

      expect(await db.onHand(w.products.untracked, w.locations.picking)).toBe(-5);

      const overrides = await db.query(
        "select note from audit_log where action = 'override'",
      );
      expect(overrides).toHaveLength(1);
      expect(String(overrides[0].note)).toContain("urgent production line stop");
    });
  });

  it("refuses an override without a reason", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.admin);

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.admin],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 5, $3, $4)`,
        [iss, w.products.untracked, w.uoms.pcs, w.locations.picking],
      );

      const msg = await db.expectError(() =>
        db.post("issue", iss, { overrideNegative: true }),
      );
      expect(msg).toContain("reason is required");
    });
  });

  it("refuses an override from a role that lacks the permission", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.staff);

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.staff],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 5, $3, $4)`,
        [iss, w.products.untracked, w.uoms.pcs, w.locations.picking],
      );

      const msg = await db.expectError(() =>
        db.post("issue", iss, { overrideNegative: true, reason: "because" }),
      );
      expect(msg).toContain("stock.negative_override");
    });
  });
});

describe("document workflow and numbering", () => {
  it("allocates sequential numbers per type per year", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.admin);

      const numbers: string[] = [];
      for (let i = 0; i < 3; i++) {
        const adj = await db.value(
          `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
           values ($1, $2, 'approved', $3) returning id`,
          [w.wh, w.reasons.found, w.users.admin],
        );
        await db.query(
          `insert into adjustment_lines
             (header_id, line_no, product_id, qty, uom_id, to_location_id)
           values ($1, 1, $2, 1, $3, $4)`,
          [adj, w.products.untracked, w.uoms.pcs, w.locations.storage],
        );
        numbers.push(await db.post("adjustment", adj));
      }

      // Assert the numbers are consecutive rather than pinning them to a
      // starting value, so the test does not depend on what the seed consumed.
      const year = new Date().getFullYear();
      for (const n of numbers) {
        expect(n).toMatch(new RegExp(`^AJ-${year}-\\d{5}$`));
      }
      const counters = numbers.map((n) => Number(n.slice(-5)));
      expect(counters[1]).toBe(counters[0] + 1);
      expect(counters[2]).toBe(counters[1] + 1);
    });
  });

  it("refuses to post a document that is not approved", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.admin);

      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'draft', $3) returning id`,
        [w.wh, w.reasons.found, w.users.admin],
      );

      const msg = await db.expectError(() => db.post("adjustment", adj));
      expect(msg).toContain("status is draft");
    });
  });

  it("refuses to cancel a posted document", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.admin);

      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.reasons.found, w.users.admin],
      );
      await db.query(
        `insert into adjustment_lines
           (header_id, line_no, product_id, qty, uom_id, to_location_id)
         values ($1, 1, $2, 1, $3, $4)`,
        [adj, w.products.untracked, w.uoms.pcs, w.locations.storage],
      );
      await db.post("adjustment", adj);

      const msg = await db.expectError(() =>
        db.query("update adjustments set status = 'cancelled' where id = $1", [adj]),
      );
      expect(msg).toContain("posted");
    });
  });

  it("rejects an illegal status jump", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.admin);

      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'draft', $3) returning id`,
        [w.wh, w.reasons.found, w.users.admin],
      );

      const msg = await db.expectError(() =>
        db.query("update adjustments set status = 'approved' where id = $1", [adj]),
      );
      expect(msg).toContain("illegal status transition");
    });
  });
});

describe("serials", () => {
  it("refuses to move a serial from a bin it is not in", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const serial = await db.value(
        `insert into serials (product_id, serial_no) values ($1, 'SN-0001') returning id`,
        [w.products.serialTracked],
      );
      await giveStock(db, w, {
        productId: w.products.serialTracked,
        locationId: w.locations.storage,
        qty: 1,
        serialId: serial,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.staff],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, serial_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 1, $4, $5)`,
        [iss, w.products.serialTracked, serial, w.uoms.pcs, w.locations.storage2],
      );

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() => db.post("issue", iss));
      expect(msg).toMatch(/insufficient stock|is not at location/);
    });
  });
});

describe("the whole loop", () => {
  it("receives, passes QC, puts away, issues and lands on the right balances", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.lotTracked;

      // 1. Receive two drums into qc_hold, lot pending.
      await db.actAs(w.users.staff);
      const lot = await makeLot(db, p, "L-2026-001");
      const gr = await db.value(
        `insert into goods_receipts (warehouse_id, partner_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.partners.supplier, w.users.staff],
      );
      await db.query(
        `insert into goods_receipt_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, to_location_id)
         values ($1, 1, $2, $3, 2, $4, $5)`,
        [gr, p, lot, w.uoms.drum, w.locations.qcHold],
      );
      const grNo = await db.post("goods_receipt", gr);
      // Format only, not the counter: the demo seed has already posted its
      // opening-balance receipt, so GR-…-00001 is taken.
      expect(grNo).toMatch(/^GR-\d{4}-\d{5}$/);
      expect(await db.onHand(p, w.locations.qcHold, lot)).toBe(400);

      // 2. QC passes the lot.
      await db.actAs(w.users.qc);
      await db.query("update lots set qc_status = 'passed' where id = $1", [lot]);

      // 3. Put away into picking.
      await db.actAs(w.users.staff);
      const tr = await db.value(
        `insert into transfers
           (warehouse_id, from_warehouse_id, to_warehouse_id, status, created_by)
         values ($1, $1, $1, 'approved', $2) returning id`,
        [w.wh, w.users.staff],
      );
      await db.query(
        `insert into transfer_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, $3, 400, $4, $5, $6)`,
        [tr, p, lot, w.uoms.kg, w.locations.qcHold, w.locations.picking],
      );
      await db.post("transfer", tr);
      await db.post("transfer", tr);

      // Now it is genuinely available.
      const avail = await db.one("select qty from stock_available where lot_id = $1", [
        lot,
      ]);
      expect(Number(avail.qty)).toBe(400);

      // 4. Issue 150 kg to production -- a partial draw from the drum stock.
      const iss = await db.value(
        `insert into issues (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.staff],
      );
      await db.query(
        `insert into issue_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, $3, 150, $4, $5)`,
        [iss, p, lot, w.uoms.kg, w.locations.picking],
      );
      await db.post("issue", iss);

      expect(await db.onHand(p, w.locations.picking, lot)).toBe(250);
      expect(await db.onHand(p, w.locations.qcHold, lot)).toBe(0);

      // 5. The movement path shows every hop, in order.
      const path = await db.query(
        `select from_location_code, to_location_code
           from stock_movement_path where lot_id = $1 order by movement_id`,
        [lot],
      );
      expect(path).toEqual([
        { from_location_code: null, to_location_code: w.codes.qcHold },
        { from_location_code: w.codes.qcHold, to_location_code: w.codes.inTransit },
        { from_location_code: w.codes.inTransit, to_location_code: w.codes.picking },
        { from_location_code: w.codes.picking, to_location_code: null },
      ]);
    });
  });
});
