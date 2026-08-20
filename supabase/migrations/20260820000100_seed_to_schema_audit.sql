-- =========================================================================
-- 0025 · Seed-versus-schema audit (D-64)
--
-- Ran 20 Aug 2026, after D-63 found the adjustment reason codes living only in
-- supabase/seed.sql — which GO-LIVE.md D1 never runs, because production is a
-- fresh project with migrations and no seed.
--
-- The question asked of every seeded table was not "is it data?" but "would
-- production be BROKEN without it, rather than merely empty?". Three answers
-- came back yes.
--
--   departments      · issues.department_id and requisitions.department_id are
--                      NOT NULL, so with no departments the requisition and
--                      issue screens cannot create a document at all.
--   uoms             · products.base_uom_id is NOT NULL, so with no UOMs no
--                      product can exist, and therefore no stock.
--   system locations · receiving refuses a QC-required product with "noQcBin"
--                      when no qc_hold bin exists; in_transit_location() raises
--                      for a cross-warehouse transfer; opening balances need the
--                      opening bin. None can be inserted by a migration,
--                      because they belong to a warehouse that does not exist
--                      yet — so they get a provisioning function instead.
--
-- Everything else stays seed and is listed in the audit table in DECISIONS.md
-- (D-64), because "we checked and decided no" is worth recording as much as the
-- three moves.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Departments
--
-- The list the owner supplied during Phase 0. Business master data: every
-- requisition and issue is charged to one, and the codes appear in reporting.
-- -------------------------------------------------------------------------

insert into departments (code, name_th, name_en) values
  ('PROD',   'ฝ่ายผลิต',         'Production'),
  ('QCQA',   'ฝ่ายควบคุมคุณภาพ',  'QC / QA'),
  ('WH',     'ฝ่ายคลังสินค้า',    'Warehouse'),
  ('RETAIL', 'ฝ่ายค้าปลีก',       'Retail'),
  ('PROC',   'ฝ่ายจัดซื้อ',       'Procurement'),
  ('ACCT',   'ฝ่ายบัญชี',         'Accounting'),
  ('MKT',    'ฝ่ายการตลาด',       'Marketing')
on conflict (code) do nothing;


-- -------------------------------------------------------------------------
-- Units of measure
--
-- FLAGGED FOR CONFIRMATION rather than asserted. These eight are carried over
-- from the seed and are the ones the demo data uses; the real list may differ
-- once the AccCloud export lands, and product-specific units (PAIL, CAN, ...)
-- may need adding.
--
-- Moved anyway, because the alternative is worse: with no UOMs at all the
-- product master cannot be created or imported, so a fresh project is stuck
-- before it starts. Unused codes are inert clutter that can be deactivated;
-- a missing one blocks everything.
--
-- decimal_places matters more than it looks. A solvent measured to 3 places and
-- a drum counted to 0 are different physical claims, and rounding a KG to a
-- whole number loses 999 g of a chemical somebody has to account for.
-- -------------------------------------------------------------------------

insert into uoms (code, name_th, name_en, decimal_places) values
  ('PCS',  'ชิ้น',     'Pieces',   0),
  ('KG',   'กิโลกรัม', 'Kilogram', 3),
  ('L',    'ลิตร',     'Litre',    3),
  ('DRUM', 'ถัง',      'Drum',     2),
  ('BAG',  'ถุง',      'Bag',      0),
  ('BOX',  'กล่อง',    'Box',      0),
  ('ROLL', 'ม้วน',     'Roll',     0),
  ('SET',  'ชุด',      'Set',      0)
on conflict (code) do nothing;


-- -------------------------------------------------------------------------
-- System locations, as a function rather than rows
--
-- Eight location types are not shelves — they are places the posting paths
-- require to exist. A migration cannot insert them, because they hang off a
-- warehouse row that production creates later. Hand-creating them at go-live
-- is possible and is exactly the sort of step that gets half-done: the miss
-- would not surface until the first QC-required receipt, or the first opening
-- balance, or the first cross-site transfer.
--
-- So the guarantee is a function. Idempotent per type: it fills gaps and leaves
-- anything already present alone, which is why the demo seed can call it after
-- creating its own nicely-named bins and get only what it was missing.
--
-- Storage and picking are deliberately NOT provisioned. Those are physical
-- racks that must match the building (GO-LIVE.md D3), and inventing a
-- STORAGE-WH01 would create somewhere for stock to hide.
-- -------------------------------------------------------------------------

create or replace function provision_system_locations(p_warehouse_id uuid)
  returns table (created_code text, created_type location_type)
  language plpgsql volatile
  set search_path = ''
as $$
declare
  v_wh_code text;
  r         record;
begin
  select code into v_wh_code from public.warehouses where id = p_warehouse_id;

  if v_wh_code is null then
    raise exception 'warehouse % does not exist', p_warehouse_id
      using errcode = 'P0002';
  end if;

  for r in
    select * from (values
      ('RECV',       'receiving'),
      ('QC-HOLD',    'qc_hold'),
      ('STAGE',      'staging'),
      ('SHIP',       'shipping'),
      ('QUAR',       'quarantine'),
      ('SCRAP',      'scrap'),
      ('IN-TRANSIT', 'in_transit'),
      ('OPENING',    'opening')
    ) as t(code_stem, loc_type)
  loop
    -- One active location of each type is enough for every code path that looks
    -- one up, and they all take the first match.
    if not exists (
      select 1 from public.locations
      where warehouse_id = p_warehouse_id
        and type = r.loc_type::public.location_type
        and is_active
    ) then
      -- counts_as_available and blocks_consumption are left to the type-defaults
      -- trigger, so a bin provisioned here behaves identically to one created by
      -- hand (D-13, D-14).
      insert into public.locations (warehouse_id, code, barcode, type)
      values (
        p_warehouse_id,
        r.code_stem || '-' || v_wh_code,
        r.code_stem || '-' || v_wh_code,
        r.loc_type::public.location_type
      )
      returning code, type into created_code, created_type;

      return next;
    end if;
  end loop;
end
$$;

comment on function provision_system_locations(uuid) is
  'Creates the system locations a warehouse needs for posting to work: receiving, '
  'qc_hold, staging, shipping, quarantine, scrap, in_transit, opening. Idempotent '
  'per type. Storage and picking are excluded — those are physical racks (D-64).';

revoke all on function provision_system_locations(uuid) from public;
-- Provisioning a warehouse is an admin act, not an operator one.
grant execute on function provision_system_locations(uuid) to authenticated;
