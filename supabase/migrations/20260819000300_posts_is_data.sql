-- =========================================================================
-- 0023 · Which document types post is data, not a hard-coded list (D-60)
--
-- Found while writing a test that pins the application's DOC_CONFIG table
-- against the database, 19 Aug 2026.
--
-- D-45 stopped requisitions being posted with a `if p_doc_type = 'requisition'`
-- check inside post_document(). Cycle counts have exactly the same property —
-- counting is measurement, and accepting a variance generates an adjustment,
-- which is the document that moves stock — but nobody had written the second
-- branch. So an approved cycle count posted happily: it allocated CC-2026-00001,
-- set itself to `posted`, and moved nothing.
--
-- Harmless today because no screen raises a cycle count yet. Not harmless in
-- three weeks, when one does, and a counter's sheet silently becomes a document
-- claiming to be the record of a stock change that never happened.
--
-- Two facts had drifted apart: `document_prefixes` knew the prefixes, the
-- function knew which types post, and the application's DOC_CONFIG restated
-- both. Now the database holds it once and a test pins the application to it.
-- =========================================================================

alter table document_prefixes
  add column if not exists posts boolean not null default true;

-- The two types whose lifecycle ends before the ledger.
update document_prefixes set posts = false
where doc_type in ('requisition', 'cycle_count');

comment on column document_prefixes.posts is
  'False for document types that never write to the ledger: a requisition is a '
  'request (D-45), a cycle count is a measurement (D-60). post_document() reads '
  'this rather than carrying a hard-coded list.';

comment on table document_prefixes is
  'Per-document-type facts: numbering prefix, and whether the type posts at all.';


-- -------------------------------------------------------------------------
-- post_document() consults the column instead of naming a type
-- -------------------------------------------------------------------------

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
  v_allows_negative boolean;
  v_allow_negative  boolean;
  v_actor           uuid := (select auth.uid());
  v_movement_wh     uuid;
  v_serial_loc      uuid;
  v_count           integer := 0;
  v_internal        boolean := false;
begin
  perform public.require_perm(p_doc_type::text || '.post');

  execute format(
    'select status, warehouse_id, doc_no from public.%I where id = $1 for update',
    p_doc_type::text || 's')
  into v_status, v_warehouse, v_doc_no
  using p_doc_id;

  if v_status is null then
    raise exception '% % not found', p_doc_type, p_doc_id using errcode = 'P0002';
  end if;

  -- Some document types do not post at all, and which ones is now DATA rather
  -- than a list written into this function (D-60).
  --
  -- A requisition is a REQUEST, fulfilled by an issue — the document that
  -- actually moves the stock (D-45). A cycle count is a MEASUREMENT; accepting
  -- its variance generates an adjustment, which is what moves anything. Posting
  -- either would move nothing while burning a document number and leaving two
  -- documents that each look like the authoritative record of one event.
  if not (select posts from public.document_prefixes where doc_type = p_doc_type) then
    raise exception
      '% documents are not posted: %', p_doc_type,
      case p_doc_type
        when 'requisition' then 'a requisition is fulfilled by an issue'
        when 'cycle_count' then 'accept the variance to generate an adjustment'
        else 'this type records something rather than moving stock'
      end
      using errcode = '23514';
  end if;

  if p_doc_type = 'transfer' then
    select t.from_warehouse_id = t.to_warehouse_id into v_internal
    from public.transfers t where t.id = p_doc_id;
  end if;

  if p_doc_type = 'transfer' and v_internal and v_status = 'approved' then
    -- Bin to bin inside one warehouse: one hop, straight to posted (D-44).
    v_leg := null;
    v_new_status := 'posted';
  elsif p_doc_type = 'transfer' and v_status = 'approved' then
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
      case when p_doc_type = 'transfer' and not v_internal
           then ' or dispatched' else '' end
      using errcode = '23514';
  end if;

  v_allow_negative :=
    coalesce((public.get_setting('allow_negative_stock', v_warehouse))::boolean, false);

  for v_line in
    select * from public.document_posting_lines(p_doc_type, p_doc_id, v_leg)
  loop
    v_count := v_count + 1;

    select tracking_mode, base_uom_id into v_tracking, v_base_uom
    from public.products where id = v_line.product_id;

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

    if v_line.from_location_id is not null then
      select allows_negative into v_allows_negative
      from public.locations where id = v_line.from_location_id;

      -- The OPENING bin is a source of stock that predates the ledger, so it
      -- is expected to run negative. Every other bin is checked.
      if not coalesce(v_allows_negative, false) then
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

        if v_line.serial_id is not null then
          select location_id into v_serial_loc
          from public.stock_on_hand
          where serial_id = v_line.serial_id and qty > 0
          limit 1;

          if v_serial_loc is distinct from v_line.from_location_id then
            raise exception
              'serial % is not at location % (it is at %)',
              v_line.serial_id, v_line.from_location_id,
              coalesce(v_serial_loc::text, 'no location')
              using errcode = '23514';
          end if;
        end if;
      end if;
    end if;

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

  if v_doc_no is null then
    v_doc_no := public.next_doc_no(p_doc_type);
  end if;

  execute format(
    'update public.%I set status = $1, doc_no = $2, %s = $3, %s = now(), updated_at = now()
      where id = $4',
    p_doc_type::text || 's',
    case when v_leg = 'dispatch' then 'dispatched_by' else 'posted_by' end,
    case when v_leg = 'dispatch' then 'dispatched_at' else 'posted_at' end)
  using v_new_status, v_doc_no, v_actor, p_doc_id;

  insert into public.audit_log
    (actor_id, table_name, record_id, action, document_type, document_id, note)
  values (
    v_actor, p_doc_type::text || 's', p_doc_id, 'post', p_doc_type, p_doc_id,
    format('%s posted as %s (%s movement lines%s)',
           p_doc_type, v_doc_no, v_count,
           case
             when p_doc_type = 'transfer' and v_leg is null then ', internal'
             when v_leg is null then ''
             else ', leg: ' || v_leg
           end)
  );

  return v_doc_no;
end
$$;

revoke all on function post_document(document_type, uuid, boolean, text) from public;
grant execute on function post_document(document_type, uuid, boolean, text) to authenticated;
