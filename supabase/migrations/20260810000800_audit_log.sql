-- =========================================================================
-- 0008 · Audit log
--
-- Append-only, same as the ledger. Records every create/update/approve/
-- cancel on documents and master data, with a before/after diff.
-- =========================================================================

create table audit_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  actor_id       uuid references user_profiles(id),
  table_name     text not null,
  record_id      uuid,
  action         audit_action not null,
  document_type  document_type,
  document_id    uuid,
  before         jsonb,
  after          jsonb,
  diff           jsonb,
  note           text
);

create index audit_log_record_idx on audit_log (table_name, record_id, at desc);
create index audit_log_actor_idx on audit_log (actor_id, at desc);
create index audit_log_document_idx on audit_log (document_type, document_id)
  where document_id is not null;
create index audit_log_at_idx on audit_log (at desc);

create or replace function audit_log_immutable()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = '42501';
end
$$;

create trigger trg_audit_log_no_update
  before update or delete on audit_log
  for each row execute function audit_log_immutable();

create trigger trg_audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_log_immutable();

revoke update, delete, truncate on audit_log from public;
revoke update, delete, truncate on audit_log from anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- Generic audit trigger
--
-- Attached to every document and master-data table. Records only the columns
-- that actually changed, so an update touching one field does not produce a
-- diff the size of the row.
-- -------------------------------------------------------------------------

create or replace function audit_trigger()
  returns trigger language plpgsql security definer
  set search_path = ''
as $$
declare
  v_before jsonb;
  v_after  jsonb;
  v_diff   jsonb;
  v_action public.audit_action;
  v_id     uuid;
begin
  if tg_op = 'INSERT' then
    v_action := 'insert';
    v_after  := to_jsonb(new);
    v_id     := (v_after ->> 'id')::uuid;

  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after  := to_jsonb(new);
    v_id     := (v_after ->> 'id')::uuid;

    -- A status change is more interesting than a field edit, so it is
    -- recorded under its own action verb.
    if v_before ? 'status' and (v_before ->> 'status') is distinct from (v_after ->> 'status') then
      v_action := case v_after ->> 'status'
        when 'submitted' then 'submit'::public.audit_action
        when 'approved'  then 'approve'::public.audit_action
        when 'posted'    then 'post'::public.audit_action
        when 'cancelled' then 'cancel'::public.audit_action
        else 'update'::public.audit_action
      end;
    else
      v_action := 'update';
    end if;

    select jsonb_object_agg(key, jsonb_build_object('from', v_before -> key, 'to', v_after -> key))
      into v_diff
    from jsonb_each(v_after)
    where v_after -> key is distinct from v_before -> key;

    -- Nothing actually changed (a no-op UPDATE); do not log noise.
    if v_diff is null then
      return new;
    end if;

  elsif tg_op = 'DELETE' then
    v_action := 'delete';
    v_before := to_jsonb(old);
    v_id     := (v_before ->> 'id')::uuid;
  end if;

  insert into public.audit_log (actor_id, table_name, record_id, action, before, after, diff)
  values (
    (select auth.uid()),
    tg_table_name,
    v_id,
    v_action,
    v_before,
    v_after,
    v_diff
  );

  return coalesce(new, old);
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    -- documents
    'goods_receipts', 'requisitions', 'issues', 'transfers',
    'delivery_notes', 'consignment_settlements', 'adjustments', 'cycle_counts',
    -- master data
    'products', 'product_barcodes', 'product_uom_conversions', 'product_stock_rules',
    'locations', 'zones', 'warehouses', 'partners', 'product_categories',
    'departments', 'uoms', 'lots', 'serials', 'adjustment_reasons',
    'user_profiles', 'role_permissions'
  ] loop
    execute format(
      'create trigger trg_%1$s_audit after insert or update or delete on %1$s
         for each row execute function audit_trigger()', t);
  end loop;
end
$$;
