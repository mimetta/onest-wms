-- =========================================================================
-- 0012 · Confirmed approval chain, and the opening-balance path
--
-- Forward-only. Migrations 0001-0011 are already applied to the hosted
-- project, so from here on changes arrive as new files rather than edits to
-- existing ones.
-- =========================================================================

-- -------------------------------------------------------------------------
-- Approval chain (PLAN.md §16 q4, answered 2026-08-10)
--
--   ใบเบิก (issue)          approved by warehouse_manager
--   ใบส่งสินค้า (delivery)   approved by warehouse_staff
--   goods receipt           posts immediately after scanning -- no separate
--                           approver, so staff hold their own approve right
-- -------------------------------------------------------------------------

insert into role_permissions (role, permission_key) values
  ('warehouse_staff', 'delivery_note.approve'),
  ('warehouse_staff', 'goods_receipt.approve')
on conflict do nothing;

-- warehouse_manager already holds issue.approve through the baseline grant.
-- Asserted rather than assumed: if the baseline ever changes, this fails loudly
-- at migration time instead of silently leaving nobody able to approve an issue.
do $$
begin
  if not exists (
    select 1 from role_permissions
    where role = 'warehouse_manager' and permission_key = 'issue.approve'
  ) then
    raise exception 'warehouse_manager must hold issue.approve';
  end if;
end
$$;

-- -------------------------------------------------------------------------
-- Opening balances need a source bin that is allowed to go negative
--
-- D-05 says opening stock enters from a virtual OPENING location so that day
-- one has a real audit trail rather than a magic starting number. But the
-- sufficiency guard (D-13) checks on-hand at the source bin, and OPENING
-- starts at zero -- so posting the very first opening balance would be
-- refused for insufficient stock.
--
-- That is correct behaviour for a real bin and wrong for this one. OPENING is
-- meant to end up holding a negative balance exactly equal to the total stock
-- that existed before the system did, which is a genuinely useful audit
-- figure rather than an anomaly to suppress.
-- -------------------------------------------------------------------------

alter table locations add column allows_negative boolean not null default false;

comment on column locations.allows_negative is
  'True only for the virtual OPENING bin: it is a source of stock that predates the ledger, so its balance is expected to be negative.';

update locations set allows_negative = true where type = 'opening';

create or replace function locations_apply_type_defaults()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.counts_as_available is null then
      new.counts_as_available := new.type in ('storage', 'picking');
    end if;
    if new.blocks_consumption is null then
      new.blocks_consumption := new.type in ('qc_hold', 'quarantine', 'scrap');
    end if;
    if new.is_virtual is null then
      new.is_virtual := new.type in ('in_transit', 'opening');
    end if;
    if new.allows_negative is null then
      new.allows_negative := new.type = 'opening';
    end if;
  end if;
  return new;
end
$$;

alter table locations alter column allows_negative drop default;

-- -------------------------------------------------------------------------
-- Goods receipt lines may name a source bin
--
-- Normal supplier receipts leave from_location_id null: stock enters from
-- outside the company. An opening-balance receipt sets it to OPENING-WH01, so
-- the go-live import lands through the same audited path as every other
-- receipt instead of needing a document type of its own.
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

    when 'requisition', 'cycle_count' then
      return;

  end case;
end
$$;

-- -------------------------------------------------------------------------
-- post_document(): honour allows_negative on the source bin
--
-- Only the sufficiency block changes. Everything else is identical to 0009 --
-- reproduced in full because CREATE OR REPLACE cannot patch part of a body.
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
           case when v_leg is null then '' else ', leg: ' || v_leg end)
  );

  return v_doc_no;
end
$$;

revoke all on function post_document(document_type, uuid, boolean, text) from public;
grant execute on function post_document(document_type, uuid, boolean, text) to authenticated;

-- -------------------------------------------------------------------------
-- Go-live date (PLAN.md §16 q7, answered 2026-08-10)
-- -------------------------------------------------------------------------

insert into settings (key, value) values ('go_live_date', '"2026-08-31"'::jsonb)
on conflict do nothing;
