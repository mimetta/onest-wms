import { describe, expect, it } from "vitest";
import { withRollback } from "./helpers/db";
import { giveStock, makeLot, seedWorld } from "./helpers/fixtures";

describe("the ledger is append-only", () => {
  it("refuses UPDATE on a posted movement", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.storage,
        qty: 10,
        uomId: w.uoms.pcs,
        actor: w.users.admin,
      });

      const msg = await db.expectError(() =>
        db.query("update stock_movements set qty = 999"),
      );
      expect(msg).toContain("append-only");
    });
  });

  it("refuses DELETE on a posted movement", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.storage,
        qty: 10,
        uomId: w.uoms.pcs,
        actor: w.users.admin,
      });

      const msg = await db.expectError(() => db.query("delete from stock_movements"));
      expect(msg).toContain("append-only");
    });
  });

  it("refuses TRUNCATE", async () => {
    await withRollback(async (db) => {
      const msg = await db.expectError(() => db.query("truncate stock_movements"));
      expect(msg).toContain("append-only");
    });
  });
});

describe("on-hand arithmetic", () => {
  it("sums receipts, moves and issues per bin", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.untracked;

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 100,
        uomId: w.uoms.pcs,
        actor: w.users.admin,
      });
      expect(await db.onHand(p, w.locations.storage)).toBe(100);

      // Move 30 to a second bin.
      const tr = await db.value(
        `insert into transfers
           (warehouse_id, from_warehouse_id, to_warehouse_id, status, created_by)
         values ($1, $1, $1, 'approved', $2) returning id`,
        [w.wh, w.users.admin],
      );
      await db.query(
        `insert into transfer_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, 30, $3, $4, $5)`,
        [tr, p, w.uoms.pcs, w.locations.storage, w.locations.storage2],
      );
      await db.post("transfer", tr); // dispatch leg
      await db.post("transfer", tr); // receive leg

      expect(await db.onHand(p, w.locations.storage)).toBe(70);
      expect(await db.onHand(p, w.locations.storage2)).toBe(30);
      expect(await db.onHand(p, w.locations.inTransit)).toBe(0);
    });
  });

  it("makes in-transit stock visible between the two transfer legs", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.untracked;
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 50,
        uomId: w.uoms.pcs,
        actor: w.users.admin,
      });

      const tr = await db.value(
        `insert into transfers
           (warehouse_id, from_warehouse_id, to_warehouse_id, status, created_by)
         values ($1, $1, $1, 'approved', $2) returning id`,
        [w.wh, w.users.admin],
      );
      await db.query(
        `insert into transfer_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, 20, $3, $4, $5)`,
        [tr, p, w.uoms.pcs, w.locations.storage, w.locations.storage2],
      );

      await db.post("transfer", tr);

      // Stock exists, is real, and is sitting in the virtual in_transit bin.
      expect(await db.onHand(p, w.locations.inTransit)).toBe(20);
      expect(await db.onHand(p, w.locations.storage)).toBe(30);
      expect(
        await db.value("select status::text from transfers where id = $1", [tr]),
      ).toBe("dispatched");
    });
  });

  it("converts document units into base units on the way in", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(db, w.products.lotTracked, "L-001", "passed", w.users.qc);

      // One drum, entered as 1 DRUM, must land as 200 KG.
      await db.actAs(w.users.admin);
      const gr = await db.value(
        `insert into goods_receipts (warehouse_id, status, created_by)
         values ($1, 'approved', $2) returning id`,
        [w.wh, w.users.admin],
      );
      await db.query(
        `insert into goods_receipt_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, to_location_id)
         values ($1, 1, $2, $3, 1, $4, $5)`,
        [gr, w.products.lotTracked, lot, w.uoms.drum, w.locations.receiving],
      );
      await db.post("goods_receipt", gr);

      expect(await db.onHand(w.products.lotTracked, w.locations.receiving, lot)).toBe(
        200,
      );
    });
  });
});

describe("tracking discipline", () => {
  it("rejects a lot-tracked product moving without a lot", async () => {
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
         values ($1, 1, $2, 5, $3, $4)`,
        [adj, w.products.lotTracked, w.uoms.kg, w.locations.storage],
      );

      const msg = await db.expectError(() => db.post("adjustment", adj));
      expect(msg).toContain("must carry a lot");
    });
  });

  it("rejects a lot belonging to a different product", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      // A lot on the serial-tracked product, misapplied to the solvent.
      const foreignLot = await makeLot(
        db,
        w.products.serialTracked,
        "X-1",
        "passed",
        w.users.qc,
      );
      await db.actAs(w.users.admin);

      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.reasons.found, w.users.admin],
      );
      await db.query(
        `insert into adjustment_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, to_location_id)
         values ($1, 1, $2, $3, 5, $4, $5)`,
        [adj, w.products.lotTracked, foreignLot, w.uoms.kg, w.locations.storage],
      );

      const msg = await db.expectError(() => db.post("adjustment", adj));
      expect(msg).toContain("does not belong to product");
    });
  });

  it("rejects a lot on an untracked product", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const msg = await db.expectError(() =>
        makeLot(db, w.products.untracked, "NOPE", "passed", w.users.qc),
      );
      expect(msg).toContain("cannot have lots");
    });
  });

  it("refuses to change tracking_mode once movements exist", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.storage,
        qty: 1,
        uomId: w.uoms.pcs,
        actor: w.users.admin,
      });

      const msg = await db.expectError(() =>
        db.query("update products set tracking_mode = 'lot' where id = $1", [
          w.products.untracked,
        ]),
      );
      expect(msg).toContain("tracking_mode");
    });
  });
});

describe("stock_available applies the QC gate everywhere", () => {
  it("hides a pending lot from availability but not from on-hand", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(db, w.products.lotTracked, "L-PEND");
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.storage,
        qty: 40,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.admin,
      });

      expect(await db.onHand(w.products.lotTracked, w.locations.storage, lot)).toBe(40);

      const available = await db.query(
        "select qty from stock_available where lot_id = $1",
        [lot],
      );
      expect(available).toHaveLength(0);

      const onHandRows = await db.query(
        "select qty from stock_on_hand where lot_id = $1",
        [lot],
      );
      expect(onHandRows).toHaveLength(1);
    });
  });

  it("keeps a non-passed lot unavailable even after putaway into storage", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const lot = await makeLot(
        db,
        w.products.lotTracked,
        "L-FAIL",
        "failed",
        w.users.qc,
      );
      await giveStock(db, w, {
        productId: w.products.lotTracked,
        locationId: w.locations.qcHold,
        qty: 25,
        lotId: lot,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      // Internal relocation of a failed lot: permitted, and changes nothing
      // about its availability (D-14).
      const tr = await db.value(
        `insert into transfers
           (warehouse_id, from_warehouse_id, to_warehouse_id, status, created_by)
         values ($1, $1, $1, 'approved', $2) returning id`,
        [w.wh, w.users.staff],
      );
      await db.query(
        `insert into transfer_lines
           (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, $3, 25, $4, $5, $6)`,
        [
          tr,
          w.products.lotTracked,
          lot,
          w.uoms.kg,
          w.locations.qcHold,
          w.locations.storage,
        ],
      );
      await db.post("transfer", tr);
      await db.post("transfer", tr);

      expect(await db.onHand(w.products.lotTracked, w.locations.storage, lot)).toBe(25);
      expect(
        await db.query("select qty from stock_available where lot_id = $1", [lot]),
      ).toHaveLength(0);
    });
  });
});
