import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Papa from "papaparse";
import {
  ACCCLOUD_COLUMNS,
  DEFAULT_NON_STOCK_GROUPS,
  REQUIRED_COLUMNS,
  UOM_MAP,
  mapRow,
  parseCost,
  summariseGroups,
  summariseUnknownUoms,
  type RawRow,
} from "../src/lib/import/acccloud-products";

/**
 * The AccCloud mapping, exercised against the REAL export.
 *
 * Not a synthetic fixture. The file is the thing that will be imported at
 * go-live, and the failure modes that matter — a unit spelled differently than
 * expected, a quoted field containing a newline, a cost column that is almost
 * entirely zeroes — are properties of that file rather than of code. A
 * hand-written fixture would have had none of them.
 */

const CSV = "docs/samples/acccloud-products.csv";

function loadRows(): RawRow[] {
  const text = readFileSync(CSV, "utf8");
  const parsed = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: true,
    // The file is UTF-8 with a BOM; left on the first header otherwise, which
    // makes the first column unfindable by name.
    transformHeader: (h) => h.replace(/^﻿/, "").trim(),
  });
  return parsed.data;
}

describe("the export file itself", () => {
  it("parses to 731 rows despite having 808 lines", () => {
    const rows = loadRows();
    expect(rows).toHaveLength(731);

    // 50 rows carry newlines inside quoted fields. This is the reason the
    // importer must use a CSV parser: splitting on newlines would produce 807
    // half-rows and quietly corrupt the item master.
    const raw = readFileSync(CSV, "utf8");
    expect(raw.split("\n").length).toBeGreaterThan(800);

    const withNewlines = rows.filter((r) =>
      Object.values(r).some((v) => typeof v === "string" && v.includes("\n")),
    );
    expect(withNewlines.length).toBe(50);
  });

  it("has every column the import depends on", () => {
    const headers = Object.keys(loadRows()[0]);
    for (const col of REQUIRED_COLUMNS) expect(headers).toContain(col);
  });

  it("has a unique, always-present item code", () => {
    const rows = loadRows();
    const codes = rows.map((r) => (r[ACCCLOUD_COLUMNS.itemCode] ?? "").trim());
    expect(codes.filter((c) => !c)).toHaveLength(0);
    expect(new Set(codes).size).toBe(731);
  });

  it("uses only units the mapping knows", () => {
    // A unit we do not recognise silently changes every quantity that follows,
    // so this failing is a hard stop rather than a warning.
    expect(summariseUnknownUoms(loadRows())).toEqual([]);
  });
});

describe("group filtering", () => {
  it("lists every group with counts, largest first", () => {
    const groups = summariseGroups(loadRows(), new Set(["PK"]));

    expect(groups[0].code).toBe("PK");
    expect(groups[0].rows).toBe(285);
    expect(groups[0].included).toBe(true);
    expect(groups.find((g) => g.code === "GE")?.included).toBe(false);
    // Thirteen groups in the file; the owner ticks from reality, not from a
    // guessed list.
    expect(groups).toHaveLength(13);
  });

  it("excludes non-stock groups without calling them errors", () => {
    const rows = loadRows();
    const included = new Set(
      summariseGroups(rows, new Set())
        .map((g) => g.code)
        .filter((c) => !DEFAULT_NON_STOCK_GROUPS.includes(c)),
    );

    const outcomes = rows.map((r) => mapRow(r, included));
    const excluded = outcomes.filter((o) => o.kind === "excluded");
    const errors = outcomes.filter((o) => o.kind === "error");

    // SVC 43 + FA 12 + TRANS 3. A service line is a good AccCloud record that
    // simply is not stock, and the preview must not cry wolf about it.
    expect(excluded).toHaveLength(58);
    expect(errors).toHaveLength(0);
  });
});

describe("row mapping", () => {
  const allGroups = () =>
    new Set(summariseGroups(loadRows(), new Set()).map((g) => g.code));

  it("maps every row when all groups are included", () => {
    const rows = loadRows();
    const outcomes = rows.map((r) => mapRow(r, allGroups()));
    expect(outcomes.filter((o) => o.kind === "mapped")).toHaveLength(731);
  });

  it("carries the AccCloud code through as both sku and external key", () => {
    const row = loadRows()[0];
    const out = mapRow(row, allGroups());
    if (out.kind !== "mapped") throw new Error("expected mapped");

    expect(out.product.sku).toBe("BAG-KRAFT-GR-15X20");
    expect(out.product.acccloudItemCode).toBe("BAG-KRAFT-GR-15X20");
  });

  it("translates AccCloud's unit spelling", () => {
    // 'Centimeter' is their label; ours is CM. Five rows use it.
    expect(UOM_MAP["Centimeter"]).toBe("CM");
    expect(UOM_MAP["ชิ้น"]).toBe("PCS");

    const rows = loadRows();
    const cm = rows
      .map((r) => mapRow(r, allGroups()))
      .filter((o) => o.kind === "mapped" && o.product.uomCode === "CM");
    expect(cm).toHaveLength(5);
  });

  it("imports discontinued items as inactive rather than dropping them", () => {
    const outcomes = loadRows().map((r) => mapRow(r, allGroups()));
    const inactive = outcomes.filter((o) => o.kind === "mapped" && !o.product.isActive);

    // 31 rows are flagged Y. They may still have stock on a shelf that has to
    // be counted, issued or written off, so they are imported and deactivated —
    // not selectable for new work, still accountable.
    expect(inactive).toHaveLength(31);
  });

  it("leaves the English name null rather than copying the Thai one", () => {
    const outcomes = loadRows().map((r) => mapRow(r, allGroups()));
    const nulls = outcomes.filter(
      (o) => o.kind === "mapped" && o.product.nameEn === null,
    );

    // Blank on 690 of 731. A copy would look like data.
    expect(nulls).toHaveLength(690);
  });

  it("rejects an unknown unit instead of guessing one", () => {
    const row: RawRow = {
      [ACCCLOUD_COLUMNS.itemCode]: "X-1",
      [ACCCLOUD_COLUMNS.nameTh]: "ทดสอบ",
      [ACCCLOUD_COLUMNS.uom]: "FURLONG",
      [ACCCLOUD_COLUMNS.groupCode]: "PK",
    };
    const out = mapRow(row, new Set(["PK"]));
    expect(out.kind).toBe("error");
    if (out.kind === "error") {
      expect(out.reason).toBe("unknownUom");
      expect(out.detail).toBe("FURLONG");
    }
  });

  it("errors on a missing item code or name", () => {
    const base: RawRow = {
      [ACCCLOUD_COLUMNS.itemCode]: "X-2",
      [ACCCLOUD_COLUMNS.nameTh]: "ทดสอบ",
      [ACCCLOUD_COLUMNS.uom]: "KG",
      [ACCCLOUD_COLUMNS.groupCode]: "PK",
    };
    const g = new Set(["PK"]);

    expect(mapRow({ ...base, [ACCCLOUD_COLUMNS.itemCode]: "" }, g).kind).toBe("error");
    expect(mapRow({ ...base, [ACCCLOUD_COLUMNS.nameTh]: "  " }, g).kind).toBe("error");
  });
});

describe("standard cost", () => {
  it("treats zero as absent, not as a price", () => {
    // 722 of 731 rows carry 0. Stored as a price, a zero reads as "this item is
    // free" to anything valuing stock later — worse than having no price.
    expect(parseCost("0")).toBeNull();
    expect(parseCost("0.00")).toBeNull();
    expect(parseCost("")).toBeNull();
    expect(parseCost(null)).toBeNull();
  });

  it("keeps real costs, including thousands separators and small decimals", () => {
    expect(parseCost("125.0")).toBe(125);
    expect(parseCost("0.104")).toBe(0.104);
    expect(parseCost("1,250.50")).toBe(1250.5);
  });

  it("refuses a negative cost as a bad row rather than a discount", () => {
    expect(parseCost("-5")).toBeNull();
  });

  it("finds exactly the nine priced rows in the real file", () => {
    const outcomes = loadRows().map((r) =>
      mapRow(r, new Set(summariseGroups(loadRows(), new Set()).map((g) => g.code))),
    );
    const priced = outcomes.filter(
      (o) => o.kind === "mapped" && o.product.standardCost !== null,
    );
    expect(priced).toHaveLength(9);
  });
});
