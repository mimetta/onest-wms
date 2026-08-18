import { describe, expect, it } from "vitest";
import { withRollback, type Db } from "./helpers/db";
import { giveStock, makeLot, seedWorld, type World } from "./helpers/fixtures";

/**
 * suggest_picks() — FEFO/FIFO pick suggestions.
 *
 * Advisory only. Every test here asserts what the operator is OFFERED; the
 * guards that actually protect the ledger are tested in posting.test.ts.
 */

type Pick = {
  location_code: string;
  lot_no: string | null;
  qty_suggested: string;
  qty_at_bin: string;
  strategy: string;
};

async function picks(db: Db, w: World, productId: string, qty: number, lotId?: string) {
  const rows = (await db.query(
    `select location_code, lot_no, qty_suggested, qty_at_bin, strategy
       from suggest_picks($1, $2, $3, $4)`,
    [productId, qty, w.wh, lotId ?? null],
  )) as unknown as Pick[];

  return rows.map((r) => ({
    code: r.location_code,
    lot: r.lot_no,
    qty: Number(r.qty_suggested),
    strategy: r.strategy,
  }));
}

/**
 * Lots created in one transaction all share a created_at, because now() is
 * transaction-start time — so FIFO order has to be set explicitly here. In
 * production each receipt is its own transaction and the timestamps differ
 * naturally, which is why the function orders on created_at rather than
 * carrying a sequence column that would exist only to make tests work.
 */
async function receivedAt(db: Db, lotId: string, daysAgo: number) {
  await db.asOwner();
  await db.query(
    `update lots set created_at = now() - ($2 || ' days')::interval where id = $1`,
    [lotId, daysAgo],
  );
}

/**
 * A lot-tracked product that does not expire.
 *
 * The fixture's lot product carries shelf_life_days, and a trigger derives
 * expiry_date from it on insert — so every lot of it is dated, and FIFO can
 * never be reached. A component tracked by batch purely for traceability, with
 * no shelf life, is the real case FIFO exists for.
 */
async function undatedProduct(db: Db, w: World) {
  await db.asOwner();
  return db.value(
    `insert into products (sku, name_th, base_uom_id, tracking_mode, requires_qc)
     values ($1, 'ข้อต่อโลหะ', $2, 'lot', false) returning id`,
    [`RM-FIT-${w.tag}`, w.uoms.kg],
  );
}

describe("suggest_picks · FEFO", () => {
  it("offers the earliest expiry first, regardless of where it sits", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.lotTracked;

      const june = await makeLot(db, p, `L-JUN-${w.tag}`, "passed", w.users.qc);
      const march = await makeLot(db, p, `L-MAR-${w.tag}`, "passed", w.users.qc);
      await db.asOwner();
      await db.query(`update lots set expiry_date = '2027-06-30' where id = $1`, [june]);
      await db.query(`update lots set expiry_date = '2027-03-31' where id = $1`, [march]);

      // The March lot is deliberately put in the FURTHER bin, so a result
      // ordered by location rather than expiry would come back the other way.
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.picking,
        qty: 100,
        lotId: june,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 100,
        lotId: march,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      const result = await picks(db, w, p, 60);

      expect(result).toEqual([
        { code: w.codes.storage, lot: `L-MAR-${w.tag}`, qty: 60, strategy: "fefo" },
      ]);
    });
  });

  it("splits across lots when the first cannot cover the whole request", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.lotTracked;

      const first = await makeLot(db, p, `L-A-${w.tag}`, "passed", w.users.qc);
      const second = await makeLot(db, p, `L-B-${w.tag}`, "passed", w.users.qc);
      await db.asOwner();
      await db.query(`update lots set expiry_date = '2027-01-31' where id = $1`, [first]);
      await db.query(`update lots set expiry_date = '2027-05-31' where id = $1`, [second]);

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 40,
        lotId: first,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.picking,
        qty: 100,
        lotId: second,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      // 40 from the expiring lot, the remaining 25 from the next one.
      expect(await picks(db, w, p, 65)).toEqual([
        { code: w.codes.storage, lot: `L-A-${w.tag}`, qty: 40, strategy: "fefo" },
        { code: w.codes.picking, lot: `L-B-${w.tag}`, qty: 25, strategy: "fefo" },
      ]);
    });
  });

  it("stops as soon as the request is covered", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.lotTracked;

      for (const [n, expiry] of [
        ["1", "2027-01-31"],
        ["2", "2027-02-28"],
        ["3", "2027-03-31"],
      ] as const) {
        const lot = await makeLot(db, p, `L-${n}-${w.tag}`, "passed", w.users.qc);
        await db.asOwner();
        await db.query(`update lots set expiry_date = $2 where id = $1`, [lot, expiry]);
        await giveStock(db, w, {
          productId: p,
          locationId: w.locations.storage,
          qty: 50,
          lotId: lot,
          uomId: w.uoms.kg,
          actor: w.users.staff,
        });
      }

      // 60 needs two lots, so the third must not be offered — a pick list that
      // shows a line the picker does not need is a line they might pick.
      const result = await picks(db, w, p, 60);
      expect(result.map((r) => r.qty)).toEqual([50, 10]);
      expect(result).toHaveLength(2);
    });
  });
});

describe("suggest_picks · FIFO", () => {
  it("falls back to oldest-received when nothing carries an expiry date", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = await undatedProduct(db, w);

      const older = await makeLot(db, p, `L-OLD-${w.tag}`, "passed", w.users.qc);
      const newer = await makeLot(db, p, `L-NEW-${w.tag}`, "passed", w.users.qc);
      await receivedAt(db, older, 90);
      await receivedAt(db, newer, 5);

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.picking,
        qty: 30,
        lotId: newer,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 30,
        lotId: older,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      expect(await picks(db, w, p, 20)).toEqual([
        { code: w.codes.storage, lot: `L-OLD-${w.tag}`, qty: 20, strategy: "fifo" },
      ]);
    });
  });

  it("puts dated stock ahead of undated stock", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      // Both lots must be the SAME product for one pick list to span them, so
      // the undated product is used and one of its lots is dated by hand —
      // which is what happens when a supplier prints a best-before on one
      // delivery of an otherwise undated part.
      const p = await undatedProduct(db, w);

      const dated = await makeLot(db, p, `L-EXP-${w.tag}`, "passed", w.users.qc);
      const undated = await makeLot(db, p, `L-NONE-${w.tag}`, "passed", w.users.qc);
      await db.asOwner();
      await db.query(`update lots set expiry_date = '2028-12-31' where id = $1`, [dated]);
      // The undated lot is much older, so a pure FIFO rule would pick it first.
      await receivedAt(db, undated, 200);
      await receivedAt(db, dated, 1);

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 20,
        lotId: undated,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.picking,
        qty: 20,
        lotId: dated,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      // Expiry beats age: the undated lot cannot spoil, the dated one can.
      const result = await picks(db, w, p, 10);
      expect(result[0].lot).toBe(`L-EXP-${w.tag}`);
      expect(result[0].strategy).toBe("fefo");
    });
  });

  it("handles an untracked product, which has no lots at all", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.untracked;

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 12,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.picking,
        qty: 40,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      // Nothing to date, so the tie-break decides: empty the smaller holding
      // first rather than leaving a 12-piece remainder behind.
      expect(await picks(db, w, p, 20)).toEqual([
        { code: w.codes.storage, lot: null, qty: 12, strategy: "fifo" },
        { code: w.codes.picking, lot: null, qty: 8, strategy: "fifo" },
      ]);
    });
  });
});

describe("suggest_picks · what it refuses to offer", () => {
  it("never offers a lot that has not passed QC", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.lotTracked;

      const pending = await makeLot(db, p, `L-PEND-${w.tag}`, "pending_qc");
      const passed = await makeLot(db, p, `L-OK-${w.tag}`, "passed", w.users.qc);
      // The pending lot expires sooner, so FEFO alone would reach for it first.
      await db.asOwner();
      await db.query(`update lots set expiry_date = '2027-01-31' where id = $1`, [pending]);
      await db.query(`update lots set expiry_date = '2027-09-30' where id = $1`, [passed]);

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 100,
        lotId: pending,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.picking,
        qty: 100,
        lotId: passed,
        uomId: w.uoms.kg,
        actor: w.users.staff,
      });

      expect(await picks(db, w, p, 50)).toEqual([
        { code: w.codes.picking, lot: `L-OK-${w.tag}`, qty: 50, strategy: "fefo" },
      ]);
    });
  });

  it("never offers stock sitting in a bin that blocks consumption", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.untracked;

      // Physically present, but in quarantine. It must not appear on a pick
      // list at all — an operator who is offered it will fetch it.
      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.quarantine,
        qty: 500,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      expect(await picks(db, w, p, 10)).toEqual([]);
    });
  });

  it("returns everything available when the warehouse is short", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.untracked;

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 15,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      // Short, not empty. The caller sums qty_suggested and compares it with
      // the request: 15 of 40 is "pick what there is and raise the rest",
      // while an empty list is "there is none". The screen says different
      // things for each, so the function must not collapse them.
      const result = await picks(db, w, p, 40);
      expect(result).toEqual([
        { code: w.codes.storage, lot: null, qty: 15, strategy: "fifo" },
      ]);
    });
  });

  it("honours a pinned lot, offering nothing else", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.lotTracked;

      const soon = await makeLot(db, p, `L-SOON-${w.tag}`, "passed", w.users.qc);
      const wanted = await makeLot(db, p, `L-WANT-${w.tag}`, "passed", w.users.qc);
      await db.asOwner();
      await db.query(`update lots set expiry_date = '2027-01-31' where id = $1`, [soon]);
      await db.query(`update lots set expiry_date = '2027-12-31' where id = $1`, [wanted]);

      for (const [lot, loc] of [
        [soon, w.locations.storage],
        [wanted, w.locations.picking],
      ] as const) {
        await giveStock(db, w, {
          productId: p,
          locationId: loc,
          qty: 50,
          lotId: lot,
          uomId: w.uoms.kg,
          actor: w.users.staff,
        });
      }

      // A customer whose line is already qualified on this batch. FEFO would
      // reach for the other lot; pinning overrides it.
      expect(await picks(db, w, p, 30, wanted)).toEqual([
        { code: w.codes.picking, lot: `L-WANT-${w.tag}`, qty: 30, strategy: "fefo" },
      ]);
    });
  });
});

describe("suggest_picks · as a real user", () => {
  it("shows a warehouse user only what RLS already lets them read", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const p = w.products.untracked;

      await giveStock(db, w, {
        productId: p,
        locationId: w.locations.storage,
        qty: 25,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      // Not SECURITY DEFINER, deliberately: stock_available is a
      // security_invoker view, so the caller's own policies apply and this
      // function cannot become a way to read around them.
      await db.actAs(w.users.staff);
      const result = await picks(db, w, p, 10);
      expect(result).toHaveLength(1);
      expect(result[0].qty).toBe(10);
    });
  });
});
