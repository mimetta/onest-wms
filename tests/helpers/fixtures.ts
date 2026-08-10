import type { Db } from "./db";

export type World = Awaited<ReturnType<typeof seedWorld>>;

/**
 * Every fixture code carries a unique tag. The demo seed in supabase/seed.sql
 * already occupies the obvious codes (WH01, PCS, FG-001, ...), and tests run
 * against a seeded database, so anything hard-coded would collide on a unique
 * index. Tagging also keeps tests independent of what the seed happens to
 * contain: they should fail when a constraint changes, not when the demo data
 * does.
 */
let fixtureCounter = 0;
const nextTag = () =>
  `X${(fixtureCounter++).toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)
    .toString(36)
    .toUpperCase()}`;

/**
 * A minimal but realistic warehouse: one of every location type that matters,
 * three products covering all three tracking modes, and one user per role.
 */
export async function seedWorld(db: Db) {
  const t = nextTag();

  // is_default stays false: a partial unique index allows exactly one default
  // warehouse, and the seeded WH01 already holds it.
  const wh = await db.value(
    `insert into warehouses (code, name_th, name_en, is_default)
     values ($1, 'คลังทดสอบ', 'Test Warehouse', false) returning id`,
    [`WH-${t}`],
  );

  const zone = await db.value(
    `insert into zones (warehouse_id, code, name_th) values ($1, $2, 'โซน A') returning id`,
    [wh, `A-${t}`],
  );

  // Codes are recorded alongside the ids: a couple of assertions read the
  // human-facing location code back out of stock_movement_path.
  const codes: Record<string, string> = {};
  const loc = async (key: string, base: string, type: string, partnerId?: string) => {
    const code = `${base}-${t}`;
    codes[key] = code;
    return db.value(
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
  };

  const supplier = await db.value(
    `insert into partners (code, type, name_th) values ($1, 'supplier', 'ผู้ขาย ก') returning id`,
    [`SUP-${t}`],
  );
  const customer = await db.value(
    `insert into partners (code, type, name_th) values ($1, 'customer', 'ลูกค้า ข') returning id`,
    [`CUS-${t}`],
  );

  const locations = {
    receiving: await loc("receiving", "RECV", "receiving"),
    qcHold: await loc("qcHold", "QC-HOLD", "qc_hold"),
    storage: await loc("storage", "A-01-01", "storage"),
    storage2: await loc("storage2", "A-01-02", "storage"),
    picking: await loc("picking", "PICK", "picking"),
    staging: await loc("staging", "STAGE", "staging"),
    shipping: await loc("shipping", "SHIP", "shipping"),
    quarantine: await loc("quarantine", "QUAR", "quarantine"),
    scrap: await loc("scrap", "SCRAP", "scrap"),
    inTransit: await loc("inTransit", "IN-TRANSIT", "in_transit"),
    opening: await loc("opening", "OPENING", "opening"),
    consignment: await loc("consignment", "CONS", "consignment_site", customer),
  };

  const uomPcs = await db.value(
    `insert into uoms (code, name_th, name_en, decimal_places)
     values ($1, 'ชิ้น', 'Pieces', 0) returning id`,
    [`PCS-${t}`],
  );
  const uomKg = await db.value(
    `insert into uoms (code, name_th, name_en) values ($1, 'กิโลกรัม', 'Kilogram') returning id`,
    [`KG-${t}`],
  );
  const uomDrum = await db.value(
    `insert into uoms (code, name_th, name_en) values ($1, 'ถัง', 'Drum') returning id`,
    [`DRUM-${t}`],
  );

  const dept = await db.value(
    `insert into departments (code, name_th, name_en) values ($1, 'ฝ่ายผลิต', 'Production') returning id`,
    [`PROD-${t}`],
  );

  // Three products, one per tracking mode.
  const untracked = await db.value(
    `insert into products (sku, name_th, base_uom_id, tracking_mode)
     values ($2, 'สินค้าสำเร็จรูป 1', $1, 'none') returning id`,
    [uomPcs, `FG-${t}`],
  );
  const lotTracked = await db.value(
    `insert into products (sku, name_th, base_uom_id, tracking_mode, requires_qc, shelf_life_days)
     values ($2, 'ตัวทำละลาย', $1, 'lot', true, 365) returning id`,
    [uomKg, `RM-SOLV-${t}`],
  );
  const serialTracked = await db.value(
    `insert into products (sku, name_th, base_uom_id, tracking_mode)
     values ($2, 'ปั๊มจ่ายสาร', $1, 'serial') returning id`,
    [uomPcs, `EQ-PUMP-${t}`],
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
      [`${key}-${t}@onest.test`],
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
     values ($1, 'ตัดจำหน่าย', 'decrease', true) returning id`,
    [`WRITE_OFF-${t}`],
  );
  const reasonFound = await db.value(
    `insert into adjustment_reasons (code, name_th, direction, is_disposal)
     values ($1, 'พบสินค้าเพิ่ม', 'increase', false) returning id`,
    [`FOUND-${t}`],
  );

  return {
    tag: t,
    wh,
    zone,
    locations,
    codes,
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
