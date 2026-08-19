-- =========================================================================
-- 0022 · suggest_picks() subtracts what the document has already claimed
--
-- Found in the Phase 1+2 walkthrough on the deployed site, 19 Aug 2026.
--
-- After picking 416.48 kg from A-01-01 onto an issue, the next suggestion
-- offered A-01-01 again for the remaining 83.52 — the bin the operator had
-- just emptied. suggest_picks() reads the ledger, and nothing moves until the
-- document posts, so the ledger still showed the full 416.48 sitting there.
--
-- Following the screen therefore built an issue drawing 500 kg from a bin
-- holding 416.48. The ledger was never at risk — post_document() checks every line
-- against the real balance at the exact bin (D-13) and would have refused it —
-- but the picker only finds out after walking the aisle, which is the worst
-- possible moment to discover it.
--
-- The fix belongs here rather than in the screen. This function already owns
-- the definition of "pickable"; "and not already spoken for by the document in
-- front of you" is part of that same question, and putting it in one of the
-- two callers would leave the other one wrong.
-- =========================================================================

-- The signature gains two parameters. Adding defaulted arguments to an
-- existing function creates a second overload rather than replacing it, and a
-- four-argument call would then be ambiguous — so the old one goes first.
drop function if exists suggest_picks(uuid, numeric, uuid, uuid);

create or replace function suggest_picks(
  p_product_id       uuid,
  p_qty              numeric,
  p_warehouse_id     uuid default null,
  p_lot_id           uuid default null,
  -- The document being built. Its own un-posted lines are subtracted from what
  -- is on offer, so a second pick cannot be suggested out of a bin the first
  -- pick already drained.
  p_exclude_doc_type document_type default null,
  p_exclude_doc_id   uuid default null
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
  -- 0. What this document has already committed, per bin and lot.
  --
  --    Only the three document types that consume stock are considered, because
  --    they are the only ones that pick. The union is static rather than
  --    dynamic SQL: three known tables are cheaper to read than a format()
  --    string, and the planner discards the two irrelevant branches on the
  --    constant type comparison.
  with committed as (
    select l.from_location_id as location_id, l.lot_id, sum(l.qty_base) as qty
    from public.issue_lines l
    where p_exclude_doc_type = 'issue' and l.header_id = p_exclude_doc_id
    group by l.from_location_id, l.lot_id

    union all

    select l.from_location_id, l.lot_id, sum(l.qty_base)
    from public.delivery_note_lines l
    where p_exclude_doc_type = 'delivery_note' and l.header_id = p_exclude_doc_id
    group by l.from_location_id, l.lot_id

    union all

    select l.from_location_id, l.lot_id, sum(l.qty_base)
    from public.consignment_settlement_lines l
    where p_exclude_doc_type = 'consignment_settlement'
      and l.header_id = p_exclude_doc_id
    group by l.from_location_id, l.lot_id
  ),

  -- 1. Everything this product could legitimately be picked from, in priority
  --    order, less anything the document has already claimed.
  candidates as (
    select
      sa.location_id,
      loc.code as location_code,
      sa.lot_id,
      sa.lot_no,
      sa.serial_id,
      sa.expiry_date,
      -- The ledger balance minus this document's own un-posted claim. A bin
      -- fully claimed drops to zero and is filtered out below.
      sa.qty - coalesce(c.qty, 0) as qty,
      case when sa.expiry_date is not null then 'fefo' else 'fifo' end as strategy,
      row_number() over (
        order by
          sa.expiry_date asc nulls last,
          lot.created_at asc nulls last,
          sa.qty - coalesce(c.qty, 0) asc,
          loc.code
      ) as pick_order
    from public.stock_available sa
    join public.locations loc on loc.id = sa.location_id
    left join public.lots lot on lot.id = sa.lot_id
    -- `is not distinct from` rather than `=`, because an untracked product's
    -- lot_id is null on both sides and `null = null` would never match, which
    -- would silently disable the whole fix for exactly the products that have
    -- no lot to fall back on.
    left join committed c
      on c.location_id = sa.location_id
     and c.lot_id is not distinct from sa.lot_id
    where sa.product_id = p_product_id
      and (p_warehouse_id is null or sa.warehouse_id = p_warehouse_id)
      and (p_lot_id is null or sa.lot_id = p_lot_id)
      and sa.qty - coalesce(c.qty, 0) > 0
  ),

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
    -- Rounded to the ledger's own scale. 500 - 416.48 is 83.51999999999998 in
    -- IEEE754, and numeric(18,4) would round it on save anyway — but the
    -- operator sees this number in a quantity box first, and a warehouse
    -- screen showing 83.51999999999998 does not look like a system anyone
    -- should trust with stock.
    round(least(r.qty, p_qty - r.covered_before), 4) as qty_suggested,
    round(r.qty, 4)                                  as qty_at_bin,
    r.strategy
  from running r
  where r.covered_before < p_qty
  order by r.pick_order;
$$;

comment on function suggest_picks(uuid, numeric, uuid, uuid, document_type, uuid) is
  'Advisory FEFO/FIFO pick suggestions. Subtracts the in-progress document''s own '
  'un-posted lines so a bin already drained on paper is not offered twice. Not a '
  'posting control: post_document() re-checks sufficiency and QC at the source bin.';

revoke all on function suggest_picks(uuid, numeric, uuid, uuid, document_type, uuid) from public;
grant execute on function suggest_picks(uuid, numeric, uuid, uuid, document_type, uuid)
  to authenticated;
