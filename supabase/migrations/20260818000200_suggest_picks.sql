-- =========================================================================
-- 0020 · suggest_picks() — FEFO/FIFO pick suggestions
--
-- Phase 2.1. Given a product and a quantity, propose which bins and lots to
-- draw from, in the order a careful storeman would pick them.
--
-- ADVISORY, NOT A CONTROL. post_document() re-checks sufficiency at the exact
-- source bin and re-applies the QC gate when the issue is posted (D-13, D-14).
-- This function's job is to save the operator from choosing, and to stop the
-- oldest stock quietly ageing at the back of the rack. If it and the posting
-- guard ever disagree, the posting guard is right — it reads the ledger under
-- a lock, this reads a view a moment earlier.
-- =========================================================================

create or replace function suggest_picks(
  p_product_id   uuid,
  p_qty          numeric,
  p_warehouse_id uuid default null,
  p_lot_id       uuid default null
) returns table (
  location_id    uuid,
  location_code  text,
  lot_id         uuid,
  lot_no         text,
  serial_id      uuid,
  expiry_date    date,
  qty_suggested  numeric,
  qty_at_bin     numeric,
  strategy       text
)
  language sql stable
  set search_path = ''
as $$
  -- 1. Everything this product could legitimately be picked from, in priority
  --    order. stock_available already excludes bins that do not count as
  --    available (receiving, staging, QC hold, scrap, and every virtual bin)
  --    and every lot that is not QC-passed, which is exactly the eligibility
  --    rule wanted here — so it is reused rather than restated (D-41).
  with candidates as (
    select
      sa.location_id,
      loc.code as location_code,
      sa.lot_id,
      sa.lot_no,
      sa.serial_id,
      sa.expiry_date,
      sa.qty,
      case when sa.expiry_date is not null then 'fefo' else 'fifo' end as strategy,
      row_number() over (
        order by
          -- FEFO first: anything with an expiry date goes before anything
          -- without, earliest first. A drum that expires in March is picked
          -- ahead of one that expires in June, and both ahead of a fitting
          -- that never expires.
          sa.expiry_date asc nulls last,
          -- Then FIFO, by when the lot was created — which is when it was
          -- received, because receiving is the only thing that creates lots.
          lot.created_at asc nulls last,
          -- Among equals, empty the smallest holding first. This clears
          -- part-used bins instead of leaving a scatter of remainders that
          -- each need their own pick line later.
          sa.qty asc,
          loc.code
      ) as pick_order
    from public.stock_available sa
    join public.locations loc on loc.id = sa.location_id
    left join public.lots lot on lot.id = sa.lot_id
    where sa.product_id = p_product_id
      and (p_warehouse_id is null or sa.warehouse_id = p_warehouse_id)
      -- A caller may pin a lot: a customer who must have the batch already
      -- qualified on their line, or a QC recall being consumed deliberately.
      and (p_lot_id is null or sa.lot_id = p_lot_id)
  ),

  -- 2. Running total, so each row knows how much was already covered by the
  --    rows above it.
  running as (
    select
      c.*,
      coalesce(sum(c.qty) over (order by c.pick_order
                                rows between unbounded preceding and 1 preceding), 0)
        as covered_before
    from candidates c
  )

  select
    r.location_id,
    r.location_code,
    r.lot_id,
    r.lot_no,
    r.serial_id,
    r.expiry_date,
    -- Take what is still outstanding, capped at what this bin actually holds.
    least(r.qty, p_qty - r.covered_before) as qty_suggested,
    r.qty                                  as qty_at_bin,
    r.strategy
  from running r
  -- Stop as soon as the requirement is met. If the warehouse holds less than
  -- was asked for, every eligible row comes back and the caller compares the
  -- total against the request — an empty result and a short result mean
  -- different things to the person on the floor, so they are reported
  -- differently rather than collapsed into "cannot pick".
  where r.covered_before < p_qty
  order by r.pick_order;
$$;

comment on function suggest_picks(uuid, numeric, uuid, uuid) is
  'Advisory FEFO/FIFO pick suggestions for an issue or delivery. Not a posting '
  'control: post_document() re-checks sufficiency and QC at the source bin.';

-- Every new function needs its grant spelled out — the blanket grants in 0011
-- ran before this existed (D-40).
revoke all on function suggest_picks(uuid, numeric, uuid, uuid) from public;
grant execute on function suggest_picks(uuid, numeric, uuid, uuid) to authenticated;
