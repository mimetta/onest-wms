-- =========================================================================
-- 0018 · stock_by_product counts physical stock
--
-- Found on the dashboard: total on-hand read 0 against a warehouse holding
-- roughly 17,000 units.
--
-- The view summed every location including the virtual ones. OPENING holds the
-- exact negative of everything that predates the ledger (D-21), so
-- qty_on_hand netted to zero for the warehouse as a whole — arithmetically
-- correct and operationally meaningless. "On hand" is a question about
-- shelves.
--
-- The same reasoning already applied twice in the UI (the stock explorer and
-- the QC queue both filter virtual bins). Fixing it at the view means the next
-- caller does not have to remember, and the Phase 4 reconciliation report —
-- which compares WMS stock against AccCloud's balances — gets the right
-- definition for free.
-- =========================================================================

drop view if exists stock_by_product;

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

    -- Physical stock only: what is actually on a shelf, in a bay, at a
    -- customer's site. Virtual bins are bookkeeping.
    coalesce(sum(soh.qty) filter (where not loc.is_virtual), 0) as qty_on_hand,

    coalesce(sum(soh.qty) filter (
      where loc.counts_as_available
        and (soh.lot_id is null or lot.qc_status = 'passed')
    ), 0)                                    as qty_available,
    coalesce(sum(soh.qty) filter (where loc.type = 'in_transit'), 0)  as qty_in_transit,
    coalesce(sum(soh.qty) filter (where loc.type = 'qc_hold'), 0)     as qty_in_qc,
    coalesce(sum(soh.qty) filter (
      where loc.type = 'consignment_site'
    ), 0)                                    as qty_at_consignment,

    -- Kept, and named for what it is: the balance sitting in virtual bins.
    -- Almost always the negative of opening stock. Useful for the go-live
    -- reconciliation check and for proving the ledger balances; never part of
    -- an answer to "how much do we have".
    coalesce(sum(soh.qty) filter (where loc.is_virtual), 0) as qty_virtual,

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

comment on view stock_by_product is
  'Per product per warehouse. qty_on_hand is PHYSICAL stock — virtual bins are excluded and reported separately as qty_virtual (D-41).';

-- A view dropped and recreated loses its grants (D-40).
grant select on stock_by_product to authenticated;
