import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import { withRollback } from "./helpers/db";
import { seedWorld } from "./helpers/fixtures";
import {
  DEFAULT_NON_STOCK_GROUPS,
  mapRow,
  summariseGroups,
  type MappedProduct,
  type RawRow,
} from "../src/lib/import/acccloud-products";

/**
 * The import, applied to the real schema with the real file.
 *
 * The pure mapping is covered in acccloud-import.test.ts. What this covers is
 * the part that only fails on contact with Postgres: column names, NOT NULLs,
 * enum values, unique constraints, and the append-only price history. Reading
 * the migrations caught three wrong column names before this ran; a test is how
 * the fourth one gets caught.
 */

function realRows(): RawRow[] {
  const text = readFileSync("docs/samples/acccloud-products.csv", "utf8");
  return Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.replace(/^﻿/, "").trim(),
  }).data;
}

/** The stock groups, as the preview would default them. */
function stockGroups(rows: RawRow[]): Set<string> {
  return new Set(
    summariseGroups(rows, new Set())
      .map((g) => g.code)
      .filter((c) => !DEFAULT_NON_STOCK_GROUPS.includes(c)),
  );
}

/**
 * Apply mapped products the way commitBatch does, so the assertions below are
 * about the same writes the action performs.
 */
async function apply(
  db: Parameters<Parameters<typeof withRollback>[0]>[0],
  products: MappedProduct[],
  userId: string,
) {
  const uomRows = (await db.query("select id, code from uoms")) as unknown as {
    id: string;
    code: string;
  }[];
  const uomByCode = new Map(uomRows.map((u) => [u.code, u.id]));

  const groups = new Map(products.map((p) => [p.groupCode, p.groupName]));
  const catByCode = new Map<string, string>();
  for (const [code, name] of groups) {
    const id = await db.value(
      `insert into product_categories (code, name_th, name_en) values ($1, $2, $1)
       on conflict (code) do update set name_th = excluded.name_th returning id`,
      [code, name],
    );
    catByCode.set(code, id);
  }

  let created = 0;
  let priced = 0;

  for (const p of products) {
    const uomId = uomByCode.get(p.uomCode);
    expect(uomId, `uom ${p.uomCode} must exist`).toBeTruthy();

    const id = await db.value(
      `insert into products
         (sku, name_th, name_en, base_uom_id, category_id, acccloud_item_code,
          source, acccloud_linked_at, is_active)
       values ($1, $2, $3, $4, $5, $6, 'acccloud', now(), $7)
       returning id`,
      [
        p.sku,
        p.nameTh,
        p.nameEn,
        uomId,
        catByCode.get(p.groupCode),
        p.acccloudItemCode,
        p.isActive,
      ],
    );
    created += 1;

    if (p.standardCost !== null) {
      await db.query(
        `insert into product_price_history (product_id, price, source, created_by, note)
         values ($1, $2, 'import', $3, 'AccCloud')`,
        [id, p.standardCost, userId],
      );
      priced += 1;
    }
  }

  return { created, priced };
}

describe("importing the real export into the real schema", () => {
  it("lands all 673 stock rows, with categories and prices", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.asOwner();

      const rows = realRows();
      const included = stockGroups(rows);
      const mapped = rows
        .map((r) => mapRow(r, included))
        .filter((o) => o.kind === "mapped")
        .map((o) => (o as { product: MappedProduct }).product);

      // 731 total less SVC 43, FA 12, TRANS 3.
      expect(mapped).toHaveLength(673);

      // Counted as a DELTA: the seed already holds 49 products marked
      // source='acccloud' (migration 0014 back-filled every row with an
      // acccloud_item_code), so an absolute count measures the seed as much as
      // the import.
      const before = Number(
        await db.value(
          "select count(*)::int from products where source = 'acccloud' and acccloud_item_code is not null",
        ),
      );
      const pricesBefore = Number(
        await db.value(
          "select count(*)::int from product_price_history where source = 'import'",
        ),
      );

      const { created, priced } = await apply(db, mapped, w.users.admin);
      expect(created).toBe(673);

      // Only the genuinely priced rows reach price history. Two of the nine
      // priced rows are in 1RM and seven in PK — both included groups.
      expect(priced).toBe(9);

      const after = Number(
        await db.value(
          "select count(*)::int from products where source = 'acccloud' and acccloud_item_code is not null",
        ),
      );
      expect(after - before).toBe(673);

      const pricesAfter = Number(
        await db.value(
          "select count(*)::int from product_price_history where source = 'import'",
        ),
      );
      expect(pricesAfter - pricesBefore).toBe(9);

      // No zero-price rows: a stored zero reads as "free" to anything valuing
      // stock, which is worse than having no price at all.
      const zeros = await db.value(
        "select count(*)::int from product_price_history where source = 'import' and price = 0",
      );
      expect(Number(zeros)).toBe(0);
    });
  });

  it("imports discontinued items as inactive, not absent", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.asOwner();

      const rows = realRows();
      const included = stockGroups(rows);
      const mapped = rows
        .map((r) => mapRow(r, included))
        .filter((o) => o.kind === "mapped")
        .map((o) => (o as { product: MappedProduct }).product);

      await apply(db, mapped, w.users.admin);

      // They may still have stock on a shelf that has to be counted or written
      // off, so they must exist and be unselectable — not missing.
      const inactive = await db.value(
        "select count(*)::int from products where source = 'acccloud' and not is_active",
      );
      expect(Number(inactive)).toBeGreaterThan(0);
      expect(Number(inactive)).toBeLessThanOrEqual(31);
    });
  });

  it("creates a category per included group and none for excluded ones", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.asOwner();

      const rows = realRows();
      const included = stockGroups(rows);
      const mapped = rows
        .map((r) => mapRow(r, included))
        .filter((o) => o.kind === "mapped")
        .map((o) => (o as { product: MappedProduct }).product);

      await apply(db, mapped, w.users.admin);

      for (const code of ["PK", "GE", "FG", "1RM"]) {
        expect(
          await db.value("select count(*)::int from product_categories where code = $1", [
            code,
          ]),
        ).toBe(1);
      }
      // Excluded groups get no category: inventing one would imply the WMS
      // tracks services.
      for (const code of DEFAULT_NON_STOCK_GROUPS) {
        expect(
          await db.value("select count(*)::int from product_categories where code = $1", [
            code,
          ]),
        ).toBe(0);
      }
    });
  });

  it("re-importing matches on acccloud_item_code instead of duplicating", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.asOwner();

      const rows = realRows().slice(0, 40);
      const included = stockGroups(realRows());
      const mapped = rows
        .map((r) => mapRow(r, included))
        .filter((o) => o.kind === "mapped")
        .map((o) => (o as { product: MappedProduct }).product);

      const before = Number(
        await db.value("select count(*)::int from products where source = 'acccloud'"),
      );
      await apply(db, mapped, w.users.admin);
      const first =
        Number(
          await db.value("select count(*)::int from products where source = 'acccloud'"),
        ) - before;

      // The second pass is what the preview classifies as `update`: the unique
      // constraint on acccloud_item_code is what makes that possible at all.
      const codes = mapped.map((p) => p.acccloudItemCode);
      const found = await db.query(
        "select acccloud_item_code from products where acccloud_item_code = any($1)",
        [codes],
      );
      expect(found).toHaveLength(mapped.length);
      expect(first).toBe(mapped.length);

      // And a genuine duplicate insert is refused by the database, not by us.
      const dup = await db.expectError(() =>
        db.query(
          `insert into products (sku, name_th, base_uom_id, acccloud_item_code)
           values ($1, 'ซ้ำ', (select id from uoms where code = 'PCS'), $2)`,
          [`DUP-${w.tag}`, mapped[0].acccloudItemCode],
        ),
      );
      expect(dup).toContain("duplicate key");
    });
  });

  it("every unit in the file resolves to an ACTIVE uom row", async () => {
    await withRollback(async (db) => {
      const rows = realRows();
      const included = stockGroups(rows);
      const codes = new Set(
        rows
          .map((r) => mapRow(r, included))
          .filter((o) => o.kind === "mapped")
          .map((o) => (o as { product: MappedProduct }).product.uomCode),
      );

      for (const code of codes) {
        // Deactivated in 0026 would be as bad as missing: the product would
        // import but its unit would not be selectable anywhere afterwards.
        const active = await db.value("select is_active from uoms where code = $1", [
          code,
        ]);
        expect(active, `uom ${code}`).toBe(true);
      }
    });
  });
});
