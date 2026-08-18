// Exercise every PostgREST query the Phase 2 screens issue, as a real
// signed-in user. Typecheck cannot see an invalid embed; this can.
import { createClient } from "@supabase/supabase-js";

const URL = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const failures = [];
const ok = [];

async function as(email) {
  const c = createClient(URL, ANON);
  const { error } = await c.auth.signInWithPassword({ email, password: "onest1234" });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}

async function check(name, fn) {
  try {
    const { data, error } = await fn();
    if (error) failures.push(`${name}: ${error.message}`);
    else ok.push(`${name} (${Array.isArray(data) ? data.length : data ? 1 : 0} rows)`);
  } catch (e) {
    failures.push(`${name}: threw ${e.message}`);
  }
}

const staff = await as("staff1@onest.co.th");
const manager = await as("manager@onest.co.th");

// --- requisitions -------------------------------------------------------
await check("requisitions list", () =>
  staff
    .from("requisitions")
    .select(
      `id, doc_no, doc_date, status, required_date,
       departments(name_th), requisition_lines(count)`,
    )
    .limit(5),
);

await check("requisition detail header", () =>
  staff
    .from("requisitions")
    .select(
      `id, doc_no, doc_date, status, required_date, notes, created_by,
       departments(name_th), created:created_by(full_name),
       approver:approved_by(full_name), approved_at`,
    )
    .limit(1),
);

await check("requisition lines", () =>
  staff
    .from("requisition_lines")
    .select("id, line_no, qty, note, products(sku, name_th), uoms:uom_id(code)")
    .limit(5),
);

// --- issues -------------------------------------------------------------
await check("issues list", () =>
  staff
    .from("issues")
    .select(
      `id, doc_no, doc_date, status,
       departments(name_th), requisitions(doc_no), issue_lines(count)`,
    )
    .limit(5),
);

await check("issue detail header", () =>
  staff
    .from("issues")
    .select(
      `id, doc_no, doc_date, status, notes, created_by, requisition_id,
       departments(name_th), requisitions(doc_no),
       created:created_by(full_name), approver:approved_by(full_name),
       poster:posted_by(full_name)`,
    )
    .limit(1),
);

await check("issue lines", () =>
  staff
    .from("issue_lines")
    .select(
      `id, line_no, qty, note, products(sku, name_th), uoms:uom_id(code),
       lots(lot_no), serials(serial_no), from_location:from_location_id(code)`,
    )
    .limit(5),
);

await check("approved requisitions for issue screen", () =>
  staff
    .from("requisitions")
    .select(
      `id, doc_no, department_id, departments(name_th),
       requisition_lines(product_id, qty,
         products(sku, name_th, base_uom_id, tracking_mode, uoms:base_uom_id(code)))`,
    )
    .eq("status", "approved")
    .limit(5),
);

// --- transfers ----------------------------------------------------------
await check("transfers list", () =>
  staff
    .from("transfers")
    .select(
      `id, doc_no, doc_date, status, from_warehouse_id, to_warehouse_id,
       transfer_lines(count)`,
    )
    .limit(5),
);

await check("transfer detail header", () =>
  staff
    .from("transfers")
    .select(
      `id, doc_no, doc_date, status, notes, created_by,
       from_warehouse_id, to_warehouse_id,
       created:created_by(full_name), approver:approved_by(full_name),
       poster:posted_by(full_name)`,
    )
    .limit(1),
);

await check("transfer lines", () =>
  staff
    .from("transfer_lines")
    .select(
      `id, line_no, qty, note, products(sku, name_th), uoms:uom_id(code),
       lots(lot_no), serials(serial_no),
       from_location:from_location_id(code), to_location:to_location_id(code)`,
    )
    .limit(5),
);

// The one that would have failed: stock_on_hand is a VIEW.
await check("readBin — stock_on_hand WITHOUT embeds", () =>
  staff.from("stock_on_hand").select("product_id, lot_id, serial_id, qty").limit(5),
);

// Proof the embed really is rejected, so the workaround is not superstition.
{
  const { error } = await staff
    .from("stock_on_hand")
    .select("qty, products(sku)")
    .limit(1);
  if (error) ok.push(`view embed correctly rejected: ${error.message.slice(0, 60)}`);
  else failures.push("view embed UNEXPECTEDLY SUCCEEDED — workaround may be stale");
}

// --- delivery notes ----------------------------------------------------
await check("delivery notes list", () =>
  staff
    .from("delivery_notes")
    .select(
      `id, doc_no, doc_date, status, so_reference, is_consignment,
       partners(code, name_th), delivery_note_lines(count)`,
    )
    .limit(5),
);

await check("delivery note detail header", () =>
  staff
    .from("delivery_notes")
    .select(
      `id, doc_no, doc_date, status, notes, created_by, so_reference, is_consignment,
       partners(code, name_th, address_th), warehouses(name_th),
       created:created_by(full_name), approver:approved_by(full_name),
       poster:posted_by(full_name)`,
    )
    .limit(1),
);

await check("delivery note lines", () =>
  staff
    .from("delivery_note_lines")
    .select(
      `id, line_no, qty, note, products(sku, name_th), uoms:uom_id(code),
       lots(lot_no), serials(serial_no),
       from_location:from_location_id(code), to_location:to_location_id(code)`,
    )
    .limit(5),
);

await check("customers with consignment sites", () =>
  staff.from("locations").select("partner_id").eq("type", "consignment_site"),
);

// --- document centre ---------------------------------------------------
for (const table of [
  "goods_receipts",
  "requisitions",
  "issues",
  "transfers",
  "delivery_notes",
  "consignment_settlements",
  "adjustments",
  "cycle_counts",
]) {
  await check(`document centre — ${table}`, () =>
    staff
      .from(table)
      .select("id, doc_no, doc_date, status, created_at, created:created_by(full_name)")
      .limit(3),
  );
}

// --- suggest_picks -----------------------------------------------------
{
  const { data: p } = await staff.from("products").select("id").limit(1).maybeSingle();
  const { data: w } = await staff.from("warehouses").select("id").limit(1).maybeSingle();
  await check("suggest_picks rpc", () =>
    staff.rpc("suggest_picks", {
      p_product_id: p.id,
      p_qty: 10,
      p_warehouse_id: w.id,
      p_lot_id: null,
    }),
  );
}

// --- stock_by_product (used for the availability hint) -----------------
await check("stock_by_product availability", () =>
  staff.from("stock_by_product").select("qty_available, product_id, warehouse_id").limit(3),
);

// --- the D-46 rule, as a real user ------------------------------------
{
  const { data: dept } = await staff.from("departments").select("id").limit(1).maybeSingle();
  const { data: wh } = await staff.from("warehouses").select("id").limit(1).maybeSingle();
  const { data: me } = await staff.auth.getUser();

  const { error: staffErr } = await staff
    .from("issues")
    .insert({
      warehouse_id: wh.id,
      department_id: dept.id,
      created_by: me.user.id,
    })
    .select("id");

  if (staffErr) ok.push(`D-46 holds for staff: ${staffErr.message.slice(0, 50)}`);
  else failures.push("D-46 VIOLATED — staff raised a direct issue via the API");

  const { data: mgr } = await manager.auth.getUser();
  const { data: created, error: mgrErr } = await manager
    .from("issues")
    .insert({
      warehouse_id: wh.id,
      department_id: dept.id,
      created_by: mgr.user.id,
    })
    .select("id")
    .single();

  if (mgrErr) failures.push(`manager direct issue blocked: ${mgrErr.message}`);
  else {
    ok.push("manager may raise a direct issue");
    await manager.from("issues").delete().eq("id", created.id);
  }
}

console.log("\n=== PASSED ===");
for (const o of ok) console.log("  ✓", o);
if (failures.length) {
  console.log("\n=== FAILED ===");
  for (const f of failures) console.log("  ✗", f);
  process.exit(1);
}
console.log(`\nAll ${ok.length} checks passed.`);
