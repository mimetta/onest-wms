-- =========================================================================
-- 0009 · Posting
--
-- One function writes to the ledger (D-06). Every document type routes
-- through it, so the invariants are written once and cannot be forgotten by
-- the eighth document type or by a developer in a hurry.
--
-- Two SEPARATE guards, deliberately not merged (D-13):
--
--   sufficiency  "is there enough stock in THIS EXACT BIN?"
--                reads stock_on_hand at from_location_id
--
--   QC gate      "may this lot be consumed or handed to a customer?"
--                reads lots.qc_status, applied per movement class
--
-- Merging them -- checking stock_available, which excludes non-available
-- locations -- made four legitimate operations impossible: scrapping a failed
-- lot, settling consignment stock, shipping from staging, and confirming a
-- transfer's receive leg.
-- =========================================================================

create table settings (
  key           text not null,
  warehouse_id  uuid references warehouses(id),
  value         jsonb not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references user_profiles(id)
);

-- A global row (warehouse_id null) plus optional per-warehouse overrides.
create unique index settings_global_idx on settings (key) where warehouse_id is null;
create unique index settings_warehouse_idx on settings (key, warehouse_id)
  where warehouse_id is not null;

insert into settings (key, value) values
  ('allow_negative_stock',    'false'::jsonb),
  ('near_expiry_horizons',    '[90, 60, 30]'::jsonb),
  ('slow_mover_days',         '90'::jsonb),
  ('qc_pending_alert_hours',  '48'::jsonb),
  ('buddhist_era_display',    'true'::jsonb);

create or replace function get_setting(p_key text, p_warehouse_id uuid default null)
  returns jsonb
  language sql stable
  set search_path = ''
as $$
  select value from public.settings
  where key = p_key
    and (warehouse_id = p_warehouse_id or warehouse_id is null)
  order by warehouse_id nulls last
  limit 1
$$;

-- -------------------------------------------------------------------------
-- Movement classification (D-14)
--
-- The QC rule depends on WHAT is happening, not only on where stock is
-- going. Relocating a failed lot internally is fine -- stock_available gates
-- on lot status at every location, so moving it changes nothing about its
-- availability. Sending it to a customer is not fine. Scrapping it must be
-- possible, or a failed lot is trapped in the warehouse forever.
-- -------------------------------------------------------------------------

create or replace function classify_movement(
  p_doc_type       document_type,
  p_from_location  uuid,
  p_to_location    uuid
) returns text
  language plpgsql stable
  set search_path = ''
as $$
declare
  v_to_type public.location_type;
begin
  if p_from_location is null then
    return 'inbound';
  end if;

  if p_to_location is not null then
    select type into v_to_type from public.locations where id = p_to_location;
  end if;

  -- Stock leaving our control: either consumed outright, or handed to a
  -- customer's site.
  if p_to_location is null or v_to_type = 'consignment_site' then
    if p_doc_type in ('issue', 'delivery_note', 'consignment_settlement') then
      return 'consumption';
    else
      return 'disposal';
    end if;
  end if;

  return 'internal';
end
$$;

comment on function classify_movement(document_type, uuid, uuid) is
  'inbound | internal | consumption | disposal. Determines which QC rule applies (D-14).';

-- -------------------------------------------------------------------------
-- On-hand at one exact bin
--
-- Deliberately queries stock_movements directly rather than stock_on_hand:
-- inside a SECURITY DEFINER function the view''s security_invoker semantics
-- add nothing, and this keeps the hot path a single indexed aggregate.
-- -------------------------------------------------------------------------

create or replace function on_hand_at(
  p_product_id  uuid,
  p_lot_id      uuid,
  p_serial_id   uuid,
  p_location_id uuid
) returns numeric
  language sql stable
  set search_path = ''
as $$
  select coalesce(sum(
           case
             when m.to_location_id   = p_location_id then  m.qty
             when m.from_location_id = p_location_id then -m.qty
             else 0
           end), 0)
  from public.stock_movements m
  where m.product_id = p_product_id
    and m.lot_id is not distinct from p_lot_id
    and m.serial_id is not distinct from p_serial_id
    and (m.to_location_id = p_location_id or m.from_location_id = p_location_id)
$$;

-- -------------------------------------------------------------------------
-- The in-transit bin for a warehouse (D-05)
-- -------------------------------------------------------------------------

create or replace function in_transit_location(p_warehouse_id uuid)
  returns uuid
  language plpgsql stable
  set search_path = ''
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.locations
  where warehouse_id = p_warehouse_id and type = 'in_transit' and is_active
  limit 1;

  if v_id is null then
    raise exception 'warehouse % has no in_transit location', p_warehouse_id
      using errcode = '23503';
  end if;
  return v_id;
end
$$;

-- -------------------------------------------------------------------------
-- Normalise a document's lines into one shape
--
-- Eight line tables, one posting routine. Transfers return different
-- endpoints depending on which leg is being posted, which is why the leg is
-- a parameter rather than being inferred inside the SQL.
-- -------------------------------------------------------------------------

create type posting_line as (
  line_id          uuid,
  product_id       uuid,
  lot_id           uuid,
  serial_id        uuid,
  qty_base         numeric,
  from_location_id uuid,
  to_location_id   uuid,
  note             text
);

create or replace function document_posting_lines(
  p_doc_type document_type,
  p_doc_id   uuid,
  p_leg      text default null
) returns setof posting_line
  language plpgsql stable
  set search_path = ''
as $$
declare
  v_transit uuid;
  v_from_wh uuid;
  v_to_wh   uuid;
begin
  case p_doc_type

    when 'goods_receipt' then
      return query
        select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
               null::uuid, l.to_location_id, l.note
        from public.goods_receipt_lines l
        where l.header_id = p_doc_id
        order by l.line_no;

    when 'issue' then
      return query
        select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
               l.from_location_id, null::uuid, l.note
        from public.issue_lines l
        where l.header_id = p_doc_id
        order by l.line_no;

    when 'delivery_note' then
      return query
        select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
               l.from_location_id, l.to_location_id, l.note
        from public.delivery_note_lines l
        where l.header_id = p_doc_id
        order by l.line_no;

    when 'consignment_settlement' then
      return query
        select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
               l.from_location_id, null::uuid, l.note
        from public.consignment_settlement_lines l
        where l.header_id = p_doc_id
        order by l.line_no;

    when 'adjustment' then
      return query
        select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
               l.from_location_id, l.to_location_id, l.note
        from public.adjustment_lines l
        where l.header_id = p_doc_id
        order by l.line_no;

    when 'transfer' then
      select t.from_warehouse_id, t.to_warehouse_id into v_from_wh, v_to_wh
      from public.transfers t where t.id = p_doc_id;

      if p_leg = 'dispatch' then
        v_transit := public.in_transit_location(v_from_wh);
        return query
          select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
                 l.from_location_id, v_transit, l.note
          from public.transfer_lines l
          where l.header_id = p_doc_id
          order by l.line_no;
      else
        v_transit := public.in_transit_location(v_from_wh);
        return query
          select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
                 v_transit, l.to_location_id, l.note
          from public.transfer_lines l
          where l.header_id = p_doc_id
          order by l.line_no;
      end if;

    -- Requisitions and cycle counts move nothing. Posting them is a status
    -- change and a document number, nothing more.
    when 'requisition', 'cycle_count' then
      return;

  end case;
end
$$;

-- =========================================================================
-- post_document()
-- =========================================================================

create or replace function post_document(
  p_doc_type          document_type,
  p_doc_id            uuid,
  p_override_negative boolean default false,
  p_override_reason   text default null
) returns text
  language plpgsql volatile security definer
  set search_path = ''
as $$
declare
  v_line            public.posting_line;
  v_status          public.document_status;
  v_warehouse       uuid;
  v_doc_no          text;
  v_leg             text;
  v_new_status      public.document_status;
  v_class           text;
  v_qc              public.qc_status;
  v_tracking        public.tracking_mode;
  v_base_uom        uuid;
  v_on_hand         numeric;
  v_blocks          boolean;
  v_allow_negative  boolean;
  v_actor           uuid := (select auth.uid());
  v_movement_wh     uuid;
  v_serial_loc      uuid;
  v_count           integer := 0;
begin
  perform public.require_perm(p_doc_type::text || '.post');

  -- 1. Lock the header and read its state. FOR UPDATE serialises two people
  --    posting the same document.
  -- Every document type's table is its enum label plus 's': goods_receipt ->
  -- goods_receipts, and so on for all eight. %I quotes the identifier, and the
  -- value can only ever be one of the enum labels, so this is not injectable.
  execute format(
    'select status, warehouse_id, doc_no from public.%I where id = $1 for update',
    p_doc_type::text || 's')
  into v_status, v_warehouse, v_doc_no
  using p_doc_id;

  if v_status is null then
    raise exception '% % not found', p_doc_type, p_doc_id using errcode = 'P0002';
  end if;

  -- 2. Work out which transition this post performs.
  if p_doc_type = 'transfer' and v_status = 'approved' then
    v_leg := 'dispatch';
    v_new_status := 'dispatched';
  elsif p_doc_type = 'transfer' and v_status = 'dispatched' then
    v_leg := 'receive';
    v_new_status := 'posted';
  elsif v_status = 'approved' then
    v_leg := null;
    v_new_status := 'posted';
  else
    raise exception
      'cannot post % %: status is %, expected approved%',
      p_doc_type, coalesce(v_doc_no, p_doc_id::text), v_status,
      case when p_doc_type = 'transfer' then ' or dispatched' else '' end
      using errcode = '23514';
  end if;

  v_allow_negative :=
    coalesce((public.get_setting('allow_negative_stock', v_warehouse))::boolean, false);

  -- 3. Walk the lines. document_posting_lines() already orders by line_no;
  --    advisory locks are taken in that same deterministic order across the
  --    whole document, so two concurrent posts touching the same pair of bins
  --    cannot deadlock (D-07).
  for v_line in
    select * from public.document_posting_lines(p_doc_type, p_doc_id, v_leg)
  loop
    v_count := v_count + 1;

    select tracking_mode, base_uom_id into v_tracking, v_base_uom
    from public.products where id = v_line.product_id;

    -- 3a. QC gate, by movement class (D-14).
    v_class := public.classify_movement(p_doc_type, v_line.from_location_id, v_line.to_location_id);

    if v_line.lot_id is not null then
      select qc_status into v_qc from public.lots where id = v_line.lot_id;

      if v_class = 'consumption' and v_qc <> 'passed' then
        raise exception
          'lot % has QC status %, so it cannot be issued, delivered or settled',
          v_line.lot_id, v_qc
          using errcode = '23514';
      end if;

      if v_class = 'disposal' and v_qc <> 'passed' then
        perform public.require_perm('lot.dispose_unpassed');
      end if;
    end if;

    -- Untracked products have no lot and therefore no QC status, so they are
    -- guarded by location instead (D-14).
    if v_class = 'consumption' and v_line.from_location_id is not null then
      select blocks_consumption into v_blocks
      from public.locations where id = v_line.from_location_id;

      if v_blocks then
        raise exception
          'location % holds stock that is not cleared for issue or delivery',
          v_line.from_location_id
          using errcode = '23514';
      end if;
    end if;

    -- 3b. Sufficiency, at the EXACT source bin (D-13).
    if v_line.from_location_id is not null then
      perform pg_advisory_xact_lock(
        hashtext(v_line.product_id::text || '/' || v_line.from_location_id::text)
      );

      v_on_hand := public.on_hand_at(
        v_line.product_id, v_line.lot_id, v_line.serial_id, v_line.from_location_id
      );

      if v_on_hand < v_line.qty_base then
        if not v_allow_negative and not p_override_negative then
          raise exception
            'insufficient stock: bin % holds % of product %, need %',
            v_line.from_location_id, v_on_hand, v_line.product_id, v_line.qty_base
            using errcode = '23514';
        end if;

        perform public.require_perm('stock.negative_override');

        if p_override_reason is null or btrim(p_override_reason) = '' then
          raise exception 'a reason is required to post into negative stock'
            using errcode = '23514';
        end if;

        insert into public.audit_log
          (actor_id, table_name, record_id, action, document_type, document_id, note)
        values (
          v_actor, 'stock_movements', v_line.line_id, 'override', p_doc_type, p_doc_id,
          format('negative stock permitted at bin %s: on hand %s, required %s. Reason: %s',
                 v_line.from_location_id, v_on_hand, v_line.qty_base, p_override_reason)
        );
      end if;

      -- A serial exists in exactly one place at a time.
      if v_line.serial_id is not null then
        select location_id into v_serial_loc
        from public.stock_on_hand
        where serial_id = v_line.serial_id and qty > 0
        limit 1;

        if v_serial_loc is distinct from v_line.from_location_id then
          raise exception
            'serial % is not at location % (it is at %)',
            v_line.serial_id, v_line.from_location_id, coalesce(v_serial_loc::text, 'no location')
            using errcode = '23514';
        end if;
      end if;
    end if;

    -- 3c. Write the movement. The warehouse is taken from whichever endpoint
    --     exists; for a single-warehouse operation both agree, and the
    --     inter-warehouse semantics of this column are deferred (D-16).
    select warehouse_id into v_movement_wh
    from public.locations
    where id = coalesce(v_line.from_location_id, v_line.to_location_id);

    insert into public.stock_movements (
      warehouse_id, product_id, lot_id, serial_id, qty, uom_id,
      from_location_id, to_location_id,
      document_type, document_id, document_line_id, user_id, note
    ) values (
      v_movement_wh, v_line.product_id, v_line.lot_id, v_line.serial_id,
      v_line.qty_base, v_base_uom,
      v_line.from_location_id, v_line.to_location_id,
      p_doc_type, p_doc_id, v_line.line_id, v_actor, v_line.note
    );
  end loop;

  -- 4. Allocate the document number, once, on the first post. A transfer keeps
  --    the number it got at dispatch.
  if v_doc_no is null then
    v_doc_no := public.next_doc_no(p_doc_type);
  end if;

  -- 5. Advance the header.
  execute format(
    'update public.%I set status = $1, doc_no = $2, %s = $3, %s = now(), updated_at = now()
      where id = $4',
    p_doc_type::text || 's',
    case when v_leg = 'dispatch' then 'dispatched_by' else 'posted_by' end,
    case when v_leg = 'dispatch' then 'dispatched_at' else 'posted_at' end)
  using v_new_status, v_doc_no, v_actor, p_doc_id;

  -- 6. Audit the post itself. The per-table audit trigger records the status
  --    change; this row records the posting event with its line count.
  insert into public.audit_log
    (actor_id, table_name, record_id, action, document_type, document_id, note)
  values (
    v_actor, p_doc_type::text || 's', p_doc_id, 'post', p_doc_type, p_doc_id,
    format('%s posted as %s (%s movement lines%s)',
           p_doc_type, v_doc_no, v_count,
           case when v_leg is null then '' else ', leg: ' || v_leg end)
  );

  return v_doc_no;
end
$$;

comment on function post_document(document_type, uuid, boolean, text) is
  'The only routine that writes to stock_movements. Atomic: the whole document lands or none of it does.';

revoke all on function post_document(document_type, uuid, boolean, text) from public;
grant execute on function post_document(document_type, uuid, boolean, text) to authenticated;
