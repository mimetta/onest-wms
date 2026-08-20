import { describe, expect, it } from "vitest";
import { withRollback } from "./helpers/db";

/**
 * The seed-versus-schema guarantees (D-64).
 *
 * Every assertion here answers the same question: does a FRESH production
 * project — migrations applied, no seed, per GO-LIVE.md D1 — have what the
 * posting paths require? The reason codes did not (D-63), and that was found by
 * accident. These tests are the version that does not rely on accident.
 */

describe("master data that must survive a fresh project", () => {
  it("has departments, without which requisitions and issues cannot exist", async () => {
    await withRollback(async (db) => {
      // department_id is NOT NULL on both tables, so an empty list is not an
      // empty dropdown — it is two screens that cannot create anything.
      const rows = (await db.query(
        "select code from departments where is_active order by code",
      )) as unknown as { code: string }[];
      const codes = rows.map((r) => r.code);

      expect(codes).toContain("PROD");
      expect(codes).toContain("QCQA");
      expect(codes.length).toBeGreaterThanOrEqual(7);
    });
  });

  it("has units of measure, without which no product can exist", async () => {
    await withRollback(async (db) => {
      // products.base_uom_id is NOT NULL: no UOMs means no products, which means
      // no stock, which means nothing at all.
      const rows = (await db.query(
        "select code, decimal_places from uoms order by code",
      )) as unknown as { code: string; decimal_places: number }[];

      const byCode = Object.fromEntries(rows.map((r) => [r.code, r.decimal_places]));
      expect(Object.keys(byCode)).toContain("KG");
      expect(Object.keys(byCode)).toContain("PCS");

      // A chemical weighed to whole kilograms loses up to 999 g that somebody
      // still has to account for, so the scale is part of the data, not cosmetic.
      expect(byCode.KG).toBe(3);
      expect(byCode.PCS).toBe(0);
    });
  });
});

describe("provision_system_locations()", () => {
  /** A warehouse with no locations at all, as production starts. */
  async function bareWarehouse(db: Parameters<Parameters<typeof withRollback>[0]>[0]) {
    return db.value(
      `insert into warehouses (code, name_th, name_en, is_default)
       values ('WH-PROV', 'คลังใหม่', 'New Warehouse', false) returning id`,
    );
  }

  it("creates every location type the posting paths need", async () => {
    await withRollback(async (db) => {
      const wh = await bareWarehouse(db);

      const created = (await db.query(
        "select created_code, created_type::text as created_type from provision_system_locations($1)",
        [wh],
      )) as unknown as { created_code: string; created_type: string }[];

      const types = created.map((c) => c.created_type).sort();
      expect(types).toEqual([
        "in_transit",
        "opening",
        "qc_hold",
        "quarantine",
        "receiving",
        "scrap",
        "shipping",
        "staging",
      ]);

      // Codes are derived from the warehouse code, so two warehouses cannot
      // collide on the globally-unique barcode column.
      expect(created.map((c) => c.created_code)).toContain("QC-HOLD-WH-PROV");
      expect(created.map((c) => c.created_code)).toContain("OPENING-WH-PROV");
    });
  });

  it("does not invent storage or picking bins", async () => {
    await withRollback(async (db) => {
      const wh = await bareWarehouse(db);
      await db.query("select provision_system_locations($1)", [wh]);

      // Those are physical racks that must match the building (GO-LIVE D3).
      // Inventing one would create somewhere for stock to hide.
      const rows = await db.query(
        `select code from locations
          where warehouse_id = $1 and type in ('storage', 'picking')`,
        [wh],
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("is idempotent, so running it twice is harmless", async () => {
    await withRollback(async (db) => {
      const wh = await bareWarehouse(db);

      const first = await db.query("select * from provision_system_locations($1)", [wh]);
      const second = await db.query("select * from provision_system_locations($1)", [wh]);

      expect(first).toHaveLength(8);
      // Re-running it during a go-live checklist must not double the bins.
      expect(second).toHaveLength(0);
    });
  });

  it("leaves an existing bin of that type alone rather than adding a duplicate", async () => {
    await withRollback(async (db) => {
      const wh = await bareWarehouse(db);

      // A warehouse that already has a hand-made, nicely-named QC bin. The code
      // is unique to this test: locations.barcode is unique GLOBALLY, not per
      // warehouse, and the seeded demo warehouse already owns QC-HOLD-01.
      await db.query(
        `insert into locations (warehouse_id, code, barcode, type)
         values ($1, 'QC-HOLD-PROV-A', 'QC-HOLD-PROV-A', 'qc_hold')`,
        [wh],
      );

      const created = (await db.query(
        "select created_type::text as created_type from provision_system_locations($1)",
        [wh],
      )) as unknown as { created_type: string }[];

      expect(created.map((c) => c.created_type)).not.toContain("qc_hold");
      const qc = await db.query(
        "select code from locations where warehouse_id = $1 and type = 'qc_hold'",
        [wh],
      );
      expect(qc).toHaveLength(1);
    });
  });

  it("makes in_transit_location() work, which it does not without provisioning", async () => {
    await withRollback(async (db) => {
      const wh = await bareWarehouse(db);

      // The failure this prevents: a cross-warehouse transfer raising
      // "warehouse X has no in_transit location" at posting time.
      const before = await db.expectError(() =>
        db.query("select in_transit_location($1)", [wh]),
      );
      expect(before).toContain("no in_transit location");

      await db.query("select provision_system_locations($1)", [wh]);
      expect(await db.value("select in_transit_location($1) is not null", [wh])).toBe(
        true,
      );
    });
  });

  it("refuses an unknown warehouse instead of silently doing nothing", async () => {
    await withRollback(async (db) => {
      const msg = await db.expectError(() =>
        db.query("select provision_system_locations(gen_random_uuid())"),
      );
      expect(msg).toContain("does not exist");
    });
  });

  it("gives provisioned bins the same QC flags as hand-made ones", async () => {
    await withRollback(async (db) => {
      const wh = await bareWarehouse(db);
      await db.query("select provision_system_locations($1)", [wh]);

      const rows = (await db.query(
        `select type::text as type, counts_as_available, blocks_consumption
           from locations where warehouse_id = $1 order by type`,
        [wh],
      )) as unknown as {
        type: string;
        counts_as_available: boolean;
        blocks_consumption: boolean;
      }[];

      const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
      // The type-defaults trigger has to have run, or a provisioned QC bin would
      // not block consumption and unpassed stock would become pickable (D-14).
      expect(byType.qc_hold.blocks_consumption).toBe(true);
      expect(byType.quarantine.blocks_consumption).toBe(true);
      expect(byType.scrap.blocks_consumption).toBe(true);
      // And none of these count as available: they are not shelves.
      for (const r of rows) expect(r.counts_as_available).toBe(false);
    });
  });
});
