-- =========================================================================
-- 0006 · Derived stock views
--
-- Every one of these is declared `security_invoker = true`. By default a
-- Postgres view executes with the privileges of its OWNER, which would let a
-- viewer read rows that RLS on the base tables denies them. security_invoker
-- makes the view run as the CALLER, so RLS still applies underneath.
--
-- Plain views, not materialised (D-11): correctness first, and a plain view
-- cannot go stale. Revisit in Phase 3 with real volume data.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Signed-leg expansion
--
-- The compatibility layer for the from/to model (D-02): each movement becomes
-- one or two signed rows, which is what makes on-hand a plain GROUP BY.
-- A receipt yields one +row, an issue one -row, a transfer both.
-- -------------------------------------------------------------------------

create view stock_ledger_entries with (security_invoker = true) as
  select
    m.id            as movement_id,
    m.occurred_at,
    m.product_id,
    m.lot_id,
    m.serial_id,
    m.uom_id,
    m.to_location_id as location_id,
    m.qty            as signed_qty,
    m.document_type,
    m.document_id,
    m.document_line_id,
    m.user_id
  from stock_movements m
  where m.to_location_id is not null

  union all

  select
    m.id,
    m.occurred_at,
    m.product_id,
    m.lot_id,
    m.serial_id,
    m.uom_id,
    m.from_location_id,
    -m.qty,
    m.document_type,
    m.document_id,
    m.document_line_id,
    m.user_id
  from stock_movements m
  where m.from_location_id is not null;

comment on view stock_ledger_entries is
  'Each movement expanded into signed +/- legs. Use this for aggregation; use stock_movements for history.';

-- -------------------------------------------------------------------------
-- On-hand
--
-- The single source of truth for "how much is physically here". Note the
-- warehouse comes from the LOCATION, not from movement.warehouse_id -- the
-- semantics of that column for inter-warehouse transfers are deliberately
-- unresolved (D-16), and deriving through the location sidesteps it entirely.
-- -------------------------------------------------------------------------

create view stock_on_hand with (security_invoker = true) as
  select
    loc.warehouse_id,
    e.product_id,
    e.lot_id,
    e.serial_id,
    e.location_id,
    sum(e.signed_qty) as qty
  from stock_ledger_entries e
  join locations loc on loc.id = e.location_id
  group by loc.warehouse_id, e.product_id, e.lot_id, e.serial_id, e.location_id
  having sum(e.signed_qty) <> 0;

comment on view stock_on_hand is
  'Physical stock per product/lot/serial/bin. What post_document() checks for sufficiency (D-13).';

-- -------------------------------------------------------------------------
-- Available
--
-- What a pick screen may SUGGEST. Deliberately NOT what posting checks:
-- stock legitimately sitting in staging, at a consignment site, in qc_hold
-- awaiting scrap, or in transit is excluded here but must still be movable
-- (D-13).
-- -------------------------------------------------------------------------

create view stock_available with (security_invoker = true) as
  select
    soh.warehouse_id,
    soh.product_id,
    soh.lot_id,
    soh.serial_id,
    soh.location_id,
    soh.qty,
    lot.expiry_date,
    lot.lot_no
  from stock_on_hand soh
  join locations loc on loc.id = soh.location_id
  left join lots lot on lot.id = soh.lot_id
  where soh.qty > 0
    and loc.counts_as_available
    and loc.is_active
    and (soh.lot_id is null or lot.qc_status = 'passed');

comment on view stock_available is
  'Advisory view for pick suggestions and line validation. NOT a posting control (D-13).';

-- -------------------------------------------------------------------------
-- Roll-up per product, with the min/max rule attached
-- -------------------------------------------------------------------------

create view stock_by_product with (security_invoker = true) as
  select
    p.id                                     as product_id,
    p.sku,
    p.name_th,
    p.name_en,
    p.tracking_mode,
    w.id                                     as warehouse_id,
    w.code                                   as warehouse_code,
    u.code                                   as base_uom,
    coalesce(sum(soh.qty), 0)                as qty_on_hand,
    coalesce(sum(soh.qty) filter (
      where loc.counts_as_available
        and (soh.lot_id is null or lot.qc_status = 'passed')
    ), 0)                                    as qty_available,
    coalesce(sum(soh.qty) filter (where loc.type = 'in_transit'), 0)  as qty_in_transit,
    coalesce(sum(soh.qty) filter (where loc.type = 'qc_hold'), 0)     as qty_in_qc,
    coalesce(sum(soh.qty) filter (
      where loc.type = 'consignment_site'
    ), 0)                                    as qty_at_consignment,
    r.min_qty,
    r.max_qty
  from products p
  cross join warehouses w
  join uoms u on u.id = p.base_uom_id
  left join stock_on_hand soh
    on soh.product_id = p.id and soh.warehouse_id = w.id
  left join locations loc on loc.id = soh.location_id
  left join lots lot on lot.id = soh.lot_id
  left join product_stock_rules r on r.product_id = p.id and r.warehouse_id = w.id
  where p.is_active and w.is_active
  group by p.id, p.sku, p.name_th, p.name_en, p.tracking_mode,
           w.id, w.code, u.code, r.min_qty, r.max_qty;

-- -------------------------------------------------------------------------
-- Where is each serial right now?
--
-- Derived, never stored (D-01). A serial with no positive on-hand row has
-- left the building; its last movement still says where it went.
-- -------------------------------------------------------------------------

create view serial_current_state with (security_invoker = true) as
  select
    s.id           as serial_id,
    s.product_id,
    s.serial_no,
    s.lot_id,
    s.status,
    soh.location_id,
    loc.code       as location_code,
    loc.warehouse_id
  from serials s
  left join stock_on_hand soh on soh.serial_id = s.id and soh.qty > 0
  left join locations loc on loc.id = soh.location_id;

-- -------------------------------------------------------------------------
-- Movement path: the "every hop, who, when" drill-down
-- -------------------------------------------------------------------------

create view stock_movement_path with (security_invoker = true) as
  select
    m.id            as movement_id,
    m.occurred_at,
    m.product_id,
    p.sku,
    p.name_th       as product_name_th,
    m.lot_id,
    lot.lot_no,
    lot.expiry_date,
    m.serial_id,
    ser.serial_no,
    m.qty,
    u.code          as uom_code,
    m.from_location_id,
    fl.code         as from_location_code,
    fl.type         as from_location_type,
    m.to_location_id,
    tl.code         as to_location_code,
    tl.type         as to_location_type,
    m.document_type,
    m.document_id,
    m.user_id,
    up.full_name    as user_name,
    m.device_id,
    m.note
  from stock_movements m
  join products p on p.id = m.product_id
  join uoms u on u.id = m.uom_id
  join user_profiles up on up.id = m.user_id
  left join lots lot on lot.id = m.lot_id
  left join serials ser on ser.id = m.serial_id
  left join locations fl on fl.id = m.from_location_id
  left join locations tl on tl.id = m.to_location_id;

-- -------------------------------------------------------------------------
-- Expiry horizon (drives near-expiry alerts and the dashboard timeline)
-- -------------------------------------------------------------------------

create view expiry_horizon with (security_invoker = true) as
  select
    soh.warehouse_id,
    soh.product_id,
    p.sku,
    p.name_th as product_name_th,
    soh.lot_id,
    lot.lot_no,
    lot.expiry_date,
    lot.qc_status,
    sum(soh.qty) as qty,
    (lot.expiry_date - bkk_today()) as days_to_expiry,
    case
      when lot.expiry_date <  bkk_today()      then 'expired'
      when lot.expiry_date <= bkk_today() + 30 then 'within_30'
      when lot.expiry_date <= bkk_today() + 60 then 'within_60'
      when lot.expiry_date <= bkk_today() + 90 then 'within_90'
      else 'beyond_90'
    end as bucket
  from stock_on_hand soh
  join lots lot on lot.id = soh.lot_id
  join products p on p.id = soh.product_id
  where soh.qty > 0 and lot.expiry_date is not null
  group by soh.warehouse_id, soh.product_id, p.sku, p.name_th,
           soh.lot_id, lot.lot_no, lot.expiry_date, lot.qc_status;

-- -------------------------------------------------------------------------
-- Movement velocity (fast/slow mover analysis)
--
-- Counts stock LEAVING the company -- issues, deliveries and settlements --
-- not internal reshuffling, which says nothing about how fast a SKU turns.
-- -------------------------------------------------------------------------

create view movement_velocity with (security_invoker = true) as
  select
    loc.warehouse_id,
    m.product_id,
    sum(m.qty) filter (where m.occurred_at >= now() - interval '30 days') as qty_out_30d,
    sum(m.qty) filter (where m.occurred_at >= now() - interval '90 days') as qty_out_90d,
    count(*)   filter (where m.occurred_at >= now() - interval '30 days') as movements_30d,
    max(m.occurred_at) as last_movement_at
  from stock_movements m
  join locations loc on loc.id = m.from_location_id
  where m.to_location_id is null
    and m.document_type in ('issue', 'delivery_note', 'consignment_settlement')
  group by loc.warehouse_id, m.product_id;
