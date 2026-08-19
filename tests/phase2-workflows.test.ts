import { describe, expect, it } from "vitest";
import { withRollback, type Db } from "./helpers/db";
import { giveStock, secondWarehouse, seedWorld, type World } from "./helpers/fixtures";

/**
 * Phase 2 approval chains, driven as the real roles.
 *
 * Written BEFORE the screens, because D-38 was learned the hard way: Phase 0's
 * tests inserted documents with `status: 'approved'` as `postgres`, which
 * bypasses RLS. They proved the posting operation and were completely blind to
 * whether a real user could ever reach a postable state — and in fact nobody
 * could, because the workflow RPCs did not exist.
 *
 * Every test here goes through submit_document / approve_document /
 * post_document as the person who would really do it. No `postgres` shortcuts,
 * no direct status writes.
 *
 * These encode DECIDED behaviour, some of which is not built yet. Failures on
 * the first run are the point.
 */

// ---------------------------------------------------------------- helpers

async function requisition(db: Db, w: World, actor: string) {
  await db.actAs(actor);
  const id = await db.value(
    `insert into requisitions (warehouse_id, department_id, created_by)
     values ($1, $2, $3) returning id`,
    [w.wh, w.dept, actor],
  );
  await db.query(
    `insert into requisition_lines (header_id, line_no, product_id, qty, uom_id)
     values ($1, 1, $2, 20, $3)`,
    [id, w.products.untracked, w.uoms.pcs],
  );
  return id;
}

async function issue(
  db: Db,
  w: World,
  actor: string,
  opts: { requisitionId?: string; qty?: number } = {},
) {
  await db.actAs(actor);
  const id = await db.value(
    `insert into issues (warehouse_id, department_id, requisition_id, created_by)
     values ($1, $2, $3, $4) returning id`,
    [w.wh, w.dept, opts.requisitionId ?? null, actor],
  );
  await db.query(
    `insert into issue_lines
       (header_id, line_no, product_id, qty, uom_id, from_location_id)
     values ($1, 1, $2, $3, $4, $5)`,
    [id, w.products.untracked, opts.qty ?? 5, w.uoms.pcs, w.locations.picking],
  );
  return id;
}

// ------------------------------------------------------------ requisitions

describe("ใบขอเบิก · requisition", () => {
  it("is raised by staff and approved by a manager", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const rq = await requisition(db, w, w.users.staff);

      await db.actAs(w.users.staff);
      await db.query("select submit_document('requisition', $1)", [rq]);

      await db.actAs(w.users.manager);
      await db.query("select approve_document('requisition', $1)", [rq]);

      expect(
        await db.value("select status::text from requisitions where id = $1", [rq]),
      ).toBe("approved");
    });
  });

  it("cannot be approved by the staff member who raised it", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const rq = await requisition(db, w, w.users.staff);

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() =>
        db.query("select approve_document('requisition', $1)", [rq]),
      );
      expect(msg).toContain("requisition.approve");
    });
  });

  it("cannot be posted — its lifecycle ends at approved", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const rq = await requisition(db, w, w.users.staff);

      await db.actAs(w.users.manager);
      await db.query("select approve_document('requisition', $1)", [rq]);

      // A requisition is a request, satisfied by an issue. Posting it would
      // move nothing while burning a document number.
      const msg = await db.expectError(() => db.post("requisition", rq));
      expect(msg.toLowerCase()).toMatch(/not posted|cannot be posted|requisition/);
    });
  });

  it("is numbered when it is approved, not when it is posted", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const rq = await requisition(db, w, w.users.staff);

      await db.actAs(w.users.manager);
      await db.query("select approve_document('requisition', $1)", [rq]);

      const docNo = await db.value("select doc_no from requisitions where id = $1", [rq]);
      expect(docNo).toMatch(/^RQ-\d{4}-\d{5}$/);
    });
  });
});

// ------------------------------------------------------------------ issues

describe("ใบเบิก · issue", () => {
  it("runs the full chain: staff raises, manager approves, staff posts", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.picking,
        qty: 100,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      const rq = await requisition(db, w, w.users.staff);
      await db.actAs(w.users.manager);
      await db.query("select approve_document('requisition', $1)", [rq]);

      const iss = await issue(db, w, w.users.staff, { requisitionId: rq });

      await db.actAs(w.users.staff);
      await db.query("select submit_document('issue', $1)", [iss]);

      await db.actAs(w.users.manager);
      await db.query("select approve_document('issue', $1)", [iss]);

      await db.actAs(w.users.staff);
      const docNo = await db.post("issue", iss);

      expect(docNo).toMatch(/^IS-\d{4}-\d{5}$/);
      expect(await db.onHand(w.products.untracked, w.locations.picking)).toBe(95);
    });
  });

  it("cannot be approved by warehouse staff", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);

      // Behind a requisition, because that is now the only issue staff may
      // raise at all (D-46) — and it makes the point sharper: even with an
      // approved request in hand, they still cannot approve the issue itself.
      const rq = await requisition(db, w, w.users.staff);
      await db.actAs(w.users.manager);
      await db.query("select approve_document('requisition', $1)", [rq]);

      const iss = await issue(db, w, w.users.staff, { requisitionId: rq });

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() =>
        db.query("select approve_document('issue', $1)", [iss]),
      );
      // This is the separation of duties the owner confirmed: an issue is the
      // one Phase 2 document a warehouse user cannot wave through alone.
      expect(msg).toContain("issue.approve");
    });
  });

  it("cannot be raised by staff WITHOUT a requisition", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.staff);

      // Decision 5: staff always go via a requisition; only a manager may
      // raise a direct issue.
      const msg = await db.expectError(() =>
        db.query(
          `insert into issues (warehouse_id, department_id, created_by)
           values ($1, $2, $3)`,
          [w.wh, w.dept, w.users.staff],
        ),
      );
      // Named precisely: "it errored" would also pass on a typo in the SQL.
      expect(msg).toContain("row-level security");
    });
  });

  it("can be raised without a requisition by a manager", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.picking,
        qty: 50,
        uomId: w.uoms.pcs,
        actor: w.users.manager,
      });

      const iss = await issue(db, w, w.users.manager);

      await db.actAs(w.users.manager);
      await db.query("select approve_document('issue', $1)", [iss]);
      const docNo = await db.post("issue", iss);
      expect(docNo).toMatch(/^IS-\d{4}-\d{5}$/);
    });
  });
});

// --------------------------------------------------------------- transfers

describe("ใบโอนย้าย · transfer", () => {
  it("posts in ONE step within a warehouse, never touching in-transit", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.receiving,
        qty: 30,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      await db.actAs(w.users.staff);
      const tr = await db.value(
        `insert into transfers
           (warehouse_id, from_warehouse_id, to_warehouse_id, created_by)
         values ($1, $1, $1, $2) returning id`,
        [w.wh, w.users.staff],
      );
      await db.query(
        `insert into transfer_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, 30, $3, $4, $5)`,
        [
          tr,
          w.products.untracked,
          w.uoms.pcs,
          w.locations.receiving,
          w.locations.storage,
        ],
      );

      // Approved AND posted by the same warehouse user, with no manager in the
      // loop (D-56). Before that grant this line needed w.users.manager, which
      // meant a twenty-second walk still waited on a second person — the exact
      // friction D-44 was supposed to remove.
      await db.query("select approve_document('transfer', $1)", [tr]);
      const docNo = await db.post("transfer", tr);

      // One post, straight to posted. A putaway is a twenty-second walk; it
      // should not require a dispatch and a confirmation.
      expect(docNo).toMatch(/^TR-\d{4}-\d{5}$/);
      expect(
        await db.value("select status::text from transfers where id = $1", [tr]),
      ).toBe("posted");

      expect(await db.onHand(w.products.untracked, w.locations.receiving)).toBe(0);
      expect(await db.onHand(w.products.untracked, w.locations.storage)).toBe(30);
      expect(await db.onHand(w.products.untracked, w.locations.inTransit)).toBe(0);

      const legs = await db.query(
        "select count(*)::int as n from stock_movements where document_id = $1",
        [tr],
      );
      expect(Number(legs[0].n)).toBe(1);
    });
  });

  it("keeps two steps between warehouses, with stock visible in transit", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const second = await secondWarehouse(db, w);

      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.storage,
        qty: 40,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      await db.actAs(w.users.staff);
      const tr = await db.value(
        `insert into transfers
           (warehouse_id, from_warehouse_id, to_warehouse_id, created_by)
         values ($1, $1, $2, $3) returning id`,
        [w.wh, second.wh, w.users.staff],
      );
      await db.query(
        `insert into transfer_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, 40, $3, $4, $5)`,
        [tr, w.products.untracked, w.uoms.pcs, w.locations.storage, second.bin],
      );

      await db.query("select approve_document('transfer', $1)", [tr]);
      await db.post("transfer", tr); // dispatch

      expect(
        await db.value("select status::text from transfers where id = $1", [tr]),
      ).toBe("dispatched");
      // The whole reason in_transit exists (D-05): stock in the lorry is a real
      // balance somebody can look up.
      expect(await db.onHand(w.products.untracked, w.locations.inTransit)).toBe(40);

      await db.post("transfer", tr); // confirm receive

      expect(
        await db.value("select status::text from transfers where id = $1", [tr]),
      ).toBe("posted");
      expect(await db.onHand(w.products.untracked, w.locations.inTransit)).toBe(0);
      expect(await db.onHand(w.products.untracked, second.bin)).toBe(40);
    });
  });
});

// ---------------------------------------------------------- delivery notes

describe("ใบส่งสินค้า · delivery note", () => {
  it("is approved by warehouse staff themselves", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.staging,
        qty: 25,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      await db.actAs(w.users.staff);
      const dn = await db.value(
        `insert into delivery_notes (warehouse_id, partner_id, created_by)
         values ($1, $2, $3) returning id`,
        [w.wh, w.partners.customer, w.users.staff],
      );
      await db.query(
        `insert into delivery_note_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id)
         values ($1, 1, $2, 25, $3, $4)`,
        [dn, w.products.untracked, w.uoms.pcs, w.locations.staging],
      );

      // The confirmed chain: no separate approver, so the dashboard panel is
      // the review — same reasoning as goods receipts (D-22).
      await db.query("select approve_document('delivery_note', $1)", [dn]);
      const docNo = await db.post("delivery_note", dn);

      expect(docNo).toMatch(/^DN-\d{4}-\d{5}$/);
      expect(await db.onHand(w.products.untracked, w.locations.staging)).toBe(0);
    });
  });

  it("moves stock to a consignment site and it stays ours", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await giveStock(db, w, {
        productId: w.products.untracked,
        locationId: w.locations.staging,
        qty: 15,
        uomId: w.uoms.pcs,
        actor: w.users.staff,
      });

      await db.actAs(w.users.staff);
      const dn = await db.value(
        `insert into delivery_notes
           (warehouse_id, partner_id, is_consignment, created_by)
         values ($1, $2, true, $3) returning id`,
        [w.wh, w.partners.customer, w.users.staff],
      );
      await db.query(
        `insert into delivery_note_lines
           (header_id, line_no, product_id, qty, uom_id, from_location_id, to_location_id)
         values ($1, 1, $2, 15, $3, $4, $5)`,
        [
          dn,
          w.products.untracked,
          w.uoms.pcs,
          w.locations.staging,
          w.locations.consignment,
        ],
      );

      await db.query("select approve_document('delivery_note', $1)", [dn]);
      await db.post("delivery_note", dn);

      // Not sold yet: still on our books, sitting at the customer.
      expect(await db.onHand(w.products.untracked, w.locations.consignment)).toBe(15);
    });
  });
});

// -------------------------------------------------------------- the viewer

describe("viewer can raise nothing", () => {
  it.each([
    ["requisitions", "(warehouse_id, department_id, created_by)"],
    ["issues", "(warehouse_id, department_id, created_by)"],
  ])("cannot create %s", async (table, cols) => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.viewer);

      const msg = await db.expectError(() =>
        db.query(`insert into ${table} ${cols} values ($1, $2, $3)`, [
          w.wh,
          w.dept,
          w.users.viewer,
        ]),
      );
      expect(msg.length).toBeGreaterThan(0);
    });
  });
});

// ------------------------------------------------- skipping the chain

/**
 * The approval chain is enforced by three independent layers, and each one is
 * asserted separately here.
 *
 * The INSERT policy was the weak one: it checked the permission and the author
 * but said nothing about `status`, so a `<type>.create` holder could insert a
 * row that was already `approved`. The other two layers happened to contain the
 * damage — lines will not attach to a non-draft header, and the workflow
 * trigger refuses draft -> approved — so the worst reachable outcome was an
 * empty approved shell. That is not a reason to leave a policy permitting the
 * exact thing it exists to forbid, so it was closed (D-47).
 *
 * Each layer gets its own test, because a suite that only proved "the bypass
 * fails" would go green if two of the three were removed.
 */
describe("the approval chain cannot be skipped", () => {
  it("refuses to INSERT a document that is already approved", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      await db.actAs(w.users.staff);

      const msg = await db.expectError(() =>
        db.query(
          `insert into requisitions (warehouse_id, department_id, status, created_by)
           values ($1, $2, 'approved', $3)`,
          [w.wh, w.dept, w.users.staff],
        ),
      );
      expect(msg).toContain("row-level security");
    });
  });

  it("refuses to UPDATE a draft straight to approved", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const rq = await requisition(db, w, w.users.staff);

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() =>
        db.query("update requisitions set status = 'approved' where id = $1", [rq]),
      );
      expect(msg).toContain("illegal status transition");
    });
  });

  it("refuses to attach lines to a document that is no longer a draft", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const rq = await requisition(db, w, w.users.staff);

      await db.actAs(w.users.manager);
      await db.query("select approve_document('requisition', $1)", [rq]);

      await db.actAs(w.users.staff);
      const msg = await db.expectError(() =>
        db.query(
          `insert into requisition_lines (header_id, line_no, product_id, qty, uom_id)
           values ($1, 2, $2, 999, $3)`,
          [rq, w.products.untracked, w.uoms.pcs],
        ),
      );
      expect(msg).toContain("row-level security");
    });
  });
});

// --------------------------------------------- what D-56 did NOT widen

describe("granting staff transfer.approve stays narrow", () => {
  it("still refuses them an issue approval", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);
      const rq = await requisition(db, w, w.users.staff);
      await db.actAs(w.users.manager);
      await db.query("select approve_document('requisition', $1)", [rq]);

      const iss = await issue(db, w, w.users.staff, { requisitionId: rq });

      await db.actAs(w.users.staff);
      // An issue consumes stock and charges a department. A transfer moves it
      // between two bins the company owns. Widening the second must not widen
      // the first, and a single insert into role_permissions is exactly the
      // kind of change that could quietly do both.
      const msg = await db.expectError(() =>
        db.query("select approve_document('issue', $1)", [iss]),
      );
      expect(msg).toContain("issue.approve");
    });
  });

  it("still refuses them an adjustment approval", async () => {
    await withRollback(async (db) => {
      const w = await seedWorld(db);

      await db.actAs(w.users.staff);
      const adj = await db.value(
        `insert into adjustments (warehouse_id, reason_code_id, created_by)
         values ($1, $2, $3) returning id`,
        [w.wh, w.reasons.disposal, w.users.staff],
      );

      // A write-off is the one place a single person must not be able to act
      // alone — the reasoning behind D-39.
      const msg = await db.expectError(() =>
        db.query("select approve_document('adjustment', $1)", [adj]),
      );
      expect(msg).toContain("adjustment.approve");
    });
  });
});
