-- =========================================================================
-- 0019 · Phase 2 workflow rules
--
-- Four changes: three decisions the owner made on the Phase 2 plan, and one
-- hole the D-38 test suite found once it started connecting as a real user
-- instead of as the table owner.
--
--   1. A transfer inside one warehouse posts in ONE step (D-44).
--   2. A requisition is numbered when approved and can never be posted (D-45).
--   3. An issue without a requisition needs issue.create_direct (D-46).
--   4. A document can only be INSERTed as a draft (D-47).
--
-- The two functions below are the definitions from 0012 with those edits
-- applied — replaced wholesale, because plpgsql has no way to patch a body,
-- and reproduced verbatim otherwise so a reader can diff the two files.
-- =========================================================================

-- -------------------------------------------------------------------------
-- 1. Same-warehouse transfers post in one step (D-44)
--
-- The two-leg design exists for a real problem: stock on a lorry between two
-- sites is neither here nor there, and somebody asking "where is it?" deserves
-- an answer, so it sits in an in_transit bin until the receiving end confirms
-- (D-05).
--
-- Inside one warehouse none of that applies. A putaway from RECEIVING to
-- STORAGE is a twenty-second walk. Making the operator post a dispatch, then
-- find the document again and confirm a receive, adds a step that protects
-- nothing — and a forgotten second leg parks real stock in a virtual bin where
-- no picker will ever find it.
--
-- So the leg is chosen from the document, not from the document type.
-- -------------------------------------------------------------------------

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
               l.from_location_id, l.to_location_id, l.note
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

      -- A null leg on a transfer now means "internal": bin to bin, one hop,
      -- no in_transit. post_document() passes null only when the two
      -- warehouses are the same, so the inter-site path below is untouched.
      if p_leg is null then
        return query
          select l.id, l.product_id, l.lot_id, l.serial_id, l.qty_base,
                 l.from_location_id, l.to_location_id, l.note
          from public.transfer_lines l
          where l.header_id = p_doc_id
          order by l.line_no;

      elsif p_leg = 'dispatch' then
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

    when 'requisition', 'cycle_count' then
      return;

  end case;
end
$$;


-- -------------------------------------------------------------------------
-- 2. post_document(): internal transfers, and requisitions are not postable
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

  -- A requisition is a REQUEST (D-45), fulfilled by an issue — which is the
  -- document that actually moves the stock. Posting one would move nothing
  -- while burning a document number and leaving two documents that each look
  -- like the authoritative record of the same event.
  if p_doc_type = 'requisition' then
    raise exception
      'a requisition cannot be posted — it is fulfilled by an issue'
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

comment on function post_document(document_type, uuid, boolean, text) is
  'The only writer to stock_movements. A transfer within one warehouse posts in '
  'a single hop; a transfer between warehouses posts twice, via in_transit. A '
  'requisition cannot be posted at all — it is fulfilled by an issue.';


-- -----------------------------------------------------------------------
-- 2b. A requisition is numbered when it is approved (D-45)
--
-- Every other document gets its number at posting, because posting is the
-- moment it becomes a permanent record. A requisition never posts, so without
-- this it would stay unnumbered forever — and a requisition is precisely the
-- document a person needs to quote down a radio: "เบิกตาม RQ-2026-00042".
-- -------------------------------------------------------------------------

create or replace function approve_document(
  p_doc_type document_type,
  p_doc_id   uuid
) returns void
  language plpgsql volatile security definer
  set search_path = ''
as $$
declare
  v_status public.document_status;
  v_doc_no text;
  v_actor  uuid := (select auth.uid());
begin
  perform public.require_perm(p_doc_type::text || '.approve');
  v_status := public.document_current_status(p_doc_type, p_doc_id);

  if v_status not in ('draft', 'submitted') then
    raise exception 'only a draft or submitted document can be approved (status is %)',
      v_status using errcode = '23514';
  end if;

  -- A draft is walked through `submitted` rather than jumping straight to
  -- `approved`: the workflow trigger in 0007 permits only
  -- draft -> submitted -> approved, and that strictness is worth keeping.
  if v_status = 'draft' then
    execute format(
      'update public.%I set status = ''submitted'', submitted_by = $1,
         submitted_at = now(), updated_at = now() where id = $2',
      p_doc_type::text || 's')
    using v_actor, p_doc_id;
  end if;

  execute format(
    'update public.%I set status = ''approved'', approved_by = $1,
       approved_at = now(), updated_at = now() where id = $2',
    p_doc_type::text || 's')
  using v_actor, p_doc_id;

  -- Approval is the end of a requisition's life, so it is also where the number
  -- is allocated. Guarded on doc_no being null so a re-approval — which the
  -- status check above already prevents — could never burn a second number.
  if p_doc_type = 'requisition' then
    select r.doc_no into v_doc_no from public.requisitions r where r.id = p_doc_id;
    if v_doc_no is null then
      update public.requisitions
         set doc_no = public.next_doc_no('requisition')
       where id = p_doc_id;
    end if;
  end if;
end
$$;


-- -------------------------------------------------------------------------
-- 3. An issue without a requisition needs its own permission (D-46)
--
-- Warehouse staff always go via a requisition, so there is a signed request
-- behind every issue and the ledger says who asked for the stock, not just who
-- handed it over. A manager can still issue directly — a line stoppage does not
-- wait for paperwork — but that is a deliberate, separately-granted act.
--
-- This is enforced in the RLS policy rather than in a trigger because it is a
-- question about who may write the row, which is what policies are for.
-- -------------------------------------------------------------------------

insert into permissions (key, description)
values ('issue.create_direct', 'Raise an issue with no requisition behind it')
on conflict (key) do nothing;

insert into role_permissions (role, permission_key)
select r, 'issue.create_direct'
from unnest(array['admin', 'warehouse_manager']::user_role[]) as r
on conflict do nothing;


-- -------------------------------------------------------------------------
-- 4. A document can only be INSERTed as a draft (D-47)
--
-- Found by the Phase 2 suite once it began connecting as `authenticated`: the
-- INSERT policies checked the permission and the author but said nothing about
-- `status`, so anyone holding <type>.create could insert a row that was already
-- `approved`.
--
-- It was not a way past the approval chain — the line policies refuse to attach
-- lines to a non-draft header, and the workflow trigger refuses draft ->
-- approved — so the worst available outcome was an empty approved shell in the
-- document centre. But "the other two layers happened to hold" is not a reason
-- to leave a policy that permits the thing it exists to forbid.
-- -------------------------------------------------------------------------

do $$
declare
  d record;
begin
  for d in
    select * from (values
      ('goods_receipts',          'goods_receipt'),
      ('requisitions',            'requisition'),
      ('issues',                  'issue'),
      ('transfers',               'transfer'),
      ('delivery_notes',          'delivery_note'),
      ('consignment_settlements', 'consignment_settlement'),
      ('adjustments',             'adjustment'),
      ('cycle_counts',            'cycle_count')
    ) as t(tbl, perm)
  loop
    execute format('drop policy if exists %1$s_insert on %1$I', d.tbl);
    execute format($p$
      create policy %1$s_insert on %1$I for insert to authenticated
        with check (
          has_perm('%2$s.create')
          and created_by = (select auth.uid())
          and status = 'draft'
        )
    $p$, d.tbl, d.perm);
  end loop;
end
$$;

-- Issues carry the extra condition from D-46 on top.
drop policy if exists issues_insert on issues;
create policy issues_insert on issues for insert to authenticated
  with check (
    has_perm('issue.create')
    and created_by = (select auth.uid())
    and status = 'draft'
    and (requisition_id is not null or has_perm('issue.create_direct'))
  );
