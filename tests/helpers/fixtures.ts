import type { Db } from "./db";

export type World = Awaited<ReturnType<typeof seedWorld>>;

/**
 * A minimal but realistic warehouse: one of every location type that matters,
 * three products covering all three tracking modes, and one user per role.
 *
 * Deliberately hand-built rather than reusing supabase/seed.sql -- tests
 * should fail when a constraint changes, not when the demo data does.
 */
export async function seedWorld(db: Db) {
  const wh = await db.value(
    `insert into warehouses (code, name_th, name_en, is_default)
     values ('WH01', 'คลังสินค้าหลัก', 'Main Warehouse', true) returning id`,
  );

  const zone = await db.value(
    `insert into zones (warehouse_id, code, name_th) values ($1, 'A', 'โซน A') returning id`,
    [wh],
  );

  const loc = async (code: string, type: string, partnerId?: string) =>
    db.value(
      `insert into locations (warehouse_id, zone_id, code, barcode, type, partner_id)
       values ($1, $2, $3, $3, $4, $5) returning id`,
      [
        wh,
        type === "in_transit" || type === "opening" ? null : zone,
        code,
        type,
        partnerId ?? null,
      ],
    );

  const supplier = await db.value(
    `insert into partners (code, type, name_th) values ('SUP01', 'supplier', 'ผู้ขาย ก') returning id`,
  );
  const customer = await db.value(
    `insert into partners (code, type, name_th) values ('CUS01', 'customer', 'ลูกค้า ข') returning id`,
  );

  const locations = {
    receiving: await loc("RECV-01", "receiving"),
    qcHold: await loc("QC-HOLD-01", "qc_hold"),
    storage: await loc("A-01-01", "storage"),
    storage2: await loc("A-01-02", "storage"),
    picking: await loc("PICK-01", "picking"),
    staging: await loc("STAGE-01", "staging"),
    shipping: await loc("SHIP-01", "shipping"),
    quarantine: await loc("QUAR-01", "quarantine"),
    scrap: await loc("SCRAP-01", "scrap"),
    inTransit: await loc("IN-TRANSIT-WH01", "in_transit"),
    opening: await loc("OPENING-WH01", "opening"),
    consignment: await loc("CONS-CUS01", "consignment_site", customer),
  };

  const uomPcs = await db.value(
    `insert into uoms (code, name_th, name_en, decimal_places)
     values ('PCS', 'ชิ้น', 'Pieces', 0) returning id`,
  );
  const uomKg = await db.value(
    `insert into uoms (code, name_th, name_en) values ('KG', 'กิโลกรัม', 'Kilogram') returning id`,
  );
  const uomDrum = await db.value(
    `insert into uoms (code, name_th, name_en) values ('DRUM', 'ถัง', 'Drum') returning id`,
  );

  const dept = await db.value(
    `insert into departments (code, name_th, name_en) values ('PROD', 'ฝ่ายผลิต', 'Production') returning id`,
  );

  // Three products, one per tracking mode.
  const untracked = await db.value(
    `insert into products (sku, name_th, base_uom_id, tracking_mode)
     values ('FG-001', 'สินค้าสำเร็จรูป 1', $1, 'none') returning id`,
    [uomPcs],
  );
  const lotTracked = await db.value(
    `insert into products (sku, name_th, base_uom_id, tracking_mode, requires_qc, shelf_life_days)
     values ('RM-SOLV-01', 'ตัวทำละลาย', $1, 'lot', true, 365) returning id`,
    [uomKg],
  );
  const serialTracked = await db.value(
    `insert into products (sku, name_th, base_uom_id, tracking_mode)
     values ('EQ-PUMP-01', 'ปั๊มจ่ายสาร', $1, 'serial') returning id`,
    [uomPcs],
  );

  // A drum of solvent is 200 kg. Per product, because it is density, not a
  // universal constant (D-10).
  await db.query(
    `insert into product_uom_conversions (product_id, from_uom_id, to_uom_id, factor)
     values ($1, $2, $3, 200)`,
    [lotTracked, uomDrum, uomKg],
  );

  const users: Record<string, string> = {};
  for (const [key, role] of Object.entries({
    admin: "admin",
    manager: "warehouse_manager",
    staff: "warehouse_staff",
    qc: "qc",
    viewer: "viewer",
  })) {
    const id = await db.value(
      `insert into auth.users (id, instance_id, aud, role, email)
       values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
               'authenticated', 'authenticated', $1)
       returning id`,
      [`${key}@onest.test`],
    );
    await db.query(
      `insert into user_profiles (id, full_name, role, warehouse_id)
       values ($1, $2, $3, $4)`,
      [id, `${key} user`, role, wh],
    );
    users[key] = id;
  }

  const reasonDisposal = await db.value(
    `insert into adjustment_reasons (code, name_th, direction, is_disposal)
     values ('WRITE_OFF', 'ตัดจำหน่าย', 'decrease', true) returning id`,
  );
  const reasonFound = await db.value(
    `insert into adjustment_reasons (code, name_th, direction, is_disposal)
     values ('FOUND', 'พบสินค้าเพิ่ม', 'increase', false) returning id`,
  );

  return {
    wh,
    zone,
    locations,
    partners: { supplier, customer },
    uoms: { pcs: uomPcs, kg: uomKg, drum: uomDrum },
    dept,
    products: { untracked, lotTracked, serialTracked },
    users,
    reasons: { disposal: reasonDisposal, found: reasonFound },
  };
}

/** Create a lot. Defaults to pending_qc, which is how receiving leaves them. */
export async function makeLot(
  db: Db,
  productId: string,
  lotNo: string,
  qcStatus: "pending_qc" | "passed" | "failed" | "quarantined" = "pending_qc",
  qcBy?: string,
) {
  // $3 is referenced twice in different contexts, so it needs an explicit cast
  // or Postgres cannot deduce a single type for the parameter.
  return db.value(
    `insert into lots (product_id, lot_no, mfg_date, qc_status, qc_by, qc_at)
     values ($1, $2, bkk_today(), $3::qc_status, $4,
             case when $3::qc_status = 'pending_qc' then null else now() end)
     returning id`,
    [productId, lotNo, qcStatus, qcStatus === "pending_qc" ? null : (qcBy ?? null)],
  );
}

/**
 * Put stock into a bin without going through a document, by posting a
 * one-line adjustment. Used to arrange test state; the posting path itself is
 * tested directly elsewhere.
 */
export async function giveStock(
  db: Db,
  w: World,
  opts: {
    productId: string;
    locationId: string;
    qty: number;
    lotId?: string | null;
    serialId?: string | null;
    uomId: string;
    actor: string;
  },
) {
  await db.actAs(w.users.admin);
  const adj = await db.value(
    `insert into adjustments (warehouse_id, reason_code_id, status, created_by)
     values ($1, $2, 'approved', $3) returning id`,
    [w.wh, w.reasons.found, w.users.admin],
  );
  await db.query(
    `insert into adjustment_lines
       (header_id, line_no, product_id, lot_id, serial_id, qty, uom_id, to_location_id)
     values ($1, 1, $2, $3, $4, $5, $6, $7)`,
    [
      adj,
      opts.productId,
      opts.lotId ?? null,
      opts.serialId ?? null,
      opts.qty,
      opts.uomId,
      opts.locationId,
    ],
  );
  await db.post("adjustment", adj);
  await db.actAs(opts.actor);
  return adj;
}
