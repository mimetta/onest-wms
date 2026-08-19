import { describe, expect, it } from "vitest";
import { withRollback } from "./helpers/db";
import { seedWorld } from "./helpers/fixtures";
import { DOC_CONFIG, DOC_TYPES } from "../src/lib/documents/config";

/**
 * The application's document table and the database's own must agree.
 *
 * `DOC_CONFIG` restates facts the database already knows — table names, line
 * table names, document-number prefixes — because the screens need them
 * synchronously and cannot ask mid-render. Restating a fact means it can drift,
 * and it already had: the adjustment prefix was written as `AD` when the
 * database issues `AJ`. Harmless so far, because nothing load-bearing read it
 * yet, which is exactly how that kind of error survives to the day something
 * does.
 */
describe("DOC_CONFIG matches the database", () => {
  it("uses the same document-number prefixes", async () => {
    await withRollback(async (db) => {
      const rows = (await db.query(
        "select doc_type::text as doc_type, prefix from document_prefixes",
      )) as unknown as { doc_type: string; prefix: string }[];

      const fromDb = Object.fromEntries(rows.map((r) => [r.doc_type, r.prefix]));
      const fromApp = Object.fromEntries(DOC_TYPES.map((t) => [t, DOC_CONFIG[t].prefix]));

      expect(fromApp).toEqual(fromDb);
    });
  });

  it("names tables that actually exist, with the line tables that belong to them", async () => {
    await withRollback(async (db) => {
      for (const type of DOC_TYPES) {
        const { table, lineTable } = DOC_CONFIG[type];

        // The header table exists and carries the columns every workflow RPC
        // assumes: format('...public.%I ... status') and doc_no.
        const header = await db.query(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1
              and column_name in ('id', 'status', 'doc_no')`,
          [table],
        );
        expect(header, `${type} header ${table}`).toHaveLength(3);

        // The line table exists and points back at the header.
        const lines = await db.query(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1
              and column_name = 'header_id'`,
          [lineTable],
        );
        expect(lines, `${type} lines ${lineTable}`).toHaveLength(1);
      }
    });
  });

  it("covers every document_type the database defines, and no others", async () => {
    await withRollback(async (db) => {
      const rows = (await db.query(
        `select unnest(enum_range(null::document_type))::text as label`,
      )) as unknown as { label: string }[];

      // A new document type added in SQL without a config entry would otherwise
      // surface as a blank row in the document centre rather than an error.
      expect([...DOC_TYPES].sort()).toEqual(rows.map((r) => r.label).sort());
    });
  });

  it("agrees with the database on which types post", async () => {
    await withRollback(async (db) => {
      // `posts` is data now (D-60), so this compares two representations of one
      // fact rather than two independent opinions.
      const rows = (await db.query(
        "select doc_type::text as doc_type, posts from document_prefixes",
      )) as unknown as { doc_type: string; posts: boolean }[];

      const fromDb = Object.fromEntries(rows.map((r) => [r.doc_type, r.posts]));
      const fromApp = Object.fromEntries(DOC_TYPES.map((t) => [t, DOC_CONFIG[t].posts]));

      expect(fromApp).toEqual(fromDb);
      // Named explicitly as well, so flipping the column by accident fails here
      // rather than silently agreeing with itself.
      expect(DOC_TYPES.filter((t) => !DOC_CONFIG[t].posts).sort()).toEqual([
        "cycle_count",
        "requisition",
      ]);
    });
  });

  it("refuses to post a non-posting type, for each of them", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.setupAs(w.users.admin);

      // A cycle count used to post: it allocated a number, marked itself posted,
      // and moved nothing (D-60). Both types are checked, because the guard is
      // now one lookup and a single test would not notice it covering only one.
      const rq = await db.value(
        `insert into requisitions (warehouse_id, department_id, status, created_by)
         values ($1, $2, 'approved', $3) returning id`,
        [w.wh, w.dept, w.users.admin],
      );
      const rqMsg = await db.expectError(() => db.post("requisition", rq));
      expect(rqMsg).toMatch(/not posted|fulfilled by an issue|permission denied/);

      const cc = await db.value(
        `insert into cycle_counts (warehouse_id, status, created_by)
         values ($1, 'approved', $2) returning id`,
        [w.wh, w.users.admin],
      );
      const ccMsg = await db.expectError(() => db.post("cycle_count", cc));
      expect(ccMsg).toMatch(/not posted|generate an adjustment/);

      // And nothing was numbered on the way out.
      expect(
        await db.value("select doc_no from cycle_counts where id = $1", [cc]),
      ).toBeNull();
    });
  });
});
