-- =========================================================================
-- 0016 · QC queue view
--
-- Two reasons this is a view rather than a query assembled in the screen:
--
-- 1. `waiting_days` must be counted in Bangkok days. Computing it in JavaScript
--    from Date.now() counts UTC days, so a lot received at 08:00 Bangkok on
--    Monday would tick over to "1 day waiting" at 07:00 Bangkok on Tuesday
--    rather than at midnight. Small, but the number is the whole point of the
--    queue — it is what a QC user sorts and escalates on (D-31).
--
-- 2. It keeps the age definition in one place, so the alerts engine in Phase 3
--    (`qc_pending_too_long`) measures exactly what the screen displays.
-- =========================================================================

create view lot_qc_queue with (security_invoker = true) as
  select
    l.id                as lot_id,
    l.lot_no,
    l.qc_status,
    l.expiry_date,
    l.created_at,
    l.qc_at,
    l.qc_note,
    p.id                as product_id,
    p.sku,
    p.name_th           as product_name_th,
    -- Whole days elapsed in Asia/Bangkok, floor-style: a lot received today
    -- reads 0 rather than rounding up to 1.
    (bkk_today() - (l.created_at at time zone 'Asia/Bangkok')::date) as waiting_days,
    coalesce(stock.qty_on_hand, 0) as qty_on_hand,
    coalesce(stock.location_codes, array[]::text[]) as location_codes
  from lots l
  join products p on p.id = l.product_id
  left join lateral (
    select
      sum(soh.qty)                          as qty_on_hand,
      array_agg(distinct loc.code order by loc.code) as location_codes
    from stock_on_hand soh
    join locations loc on loc.id = soh.location_id
    where soh.lot_id = l.id
      and soh.qty > 0
      -- Virtual bins hold bookkeeping, not stock. OPENING carries the negative
      -- of everything predating the ledger; including it would make a lot's
      -- on-hand read as zero and hide real stock from the QC user.
      and not loc.is_virtual
  ) stock on true;

comment on view lot_qc_queue is
  'Lots with their QC status, age in Bangkok days, and physical stock. Backs the QC review queue and the Phase 3 qc_pending_too_long alert.';

-- -------------------------------------------------------------------------
-- Grants
--
-- Migration 0011 ran `grant select on all tables in schema public to
-- authenticated`, which applies only to objects that existed AT THAT MOMENT.
-- Every table or view added afterwards needs its own grant, and forgetting one
-- fails in the most confusing possible way: the query succeeds and returns zero
-- rows, so a screen looks like it has no data rather than like it is broken.
--
-- product_latest_price (migration 0014) was missed the same way and is fixed
-- here rather than left to surface in Phase 4.
--
-- Rule for future migrations: a new table or view gets its grant in the same
-- file that creates it.
-- -------------------------------------------------------------------------

grant select on lot_qc_queue to authenticated;
grant select on product_latest_price to authenticated;
