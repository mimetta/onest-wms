-- =========================================================================
-- 0011 · Row Level Security
--
-- RLS is ENABLED on every table but deliberately NOT FORCED (D-19).
--
-- FORCE would apply policies to the table owner as well, which is exactly
-- what post_document(), the auth helpers and audit_trigger() rely on NOT
-- happening: they are SECURITY DEFINER and must be able to read and write
-- past the policies they exist to implement. Forcing RLS would make
-- has_perm() recurse into the policy that calls has_perm().
--
-- The protection that matters is unchanged: anon and authenticated get only
-- what the policies below allow, and the service-role key never reaches the
-- browser.
--
-- Write access to stock is granted to nobody. stock_movements has no INSERT
-- policy at all -- post_document() is the only writer (D-06).
-- =========================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'user_profiles', 'permissions', 'role_permissions',
    'warehouses', 'zones', 'locations', 'partners', 'uoms',
    'product_categories', 'departments', 'products', 'product_barcodes',
    'product_uom_conversions', 'product_stock_rules',
    'lots', 'serials',
    'stock_movements',
    'document_sequences', 'document_prefixes',
    'goods_receipts', 'goods_receipt_lines',
    'requisitions', 'requisition_lines',
    'issues', 'issue_lines',
    'transfers', 'transfer_lines',
    'delivery_notes', 'delivery_note_lines',
    'consignment_settlements', 'consignment_settlement_lines',
    'adjustments', 'adjustment_lines', 'adjustment_reasons',
    'cycle_counts', 'cycle_count_lines',
    'audit_log', 'settings',
    'alerts', 'alert_rules',
    'erp_sync_map', 'erp_import_batches', 'erp_import_rows', 'erp_sync_log'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end
$$;

-- -------------------------------------------------------------------------
-- Reference data: readable by any active signed-in user
--
-- Everyone who can log in needs to resolve a barcode, a location code or a
-- unit name. There is nothing confidential here, and withholding it would
-- only mean every screen round-trips through an RPC to render a label.
-- -------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'warehouses', 'zones', 'locations', 'partners', 'uoms',
    'product_categories', 'departments', 'products', 'product_barcodes',
    'product_uom_conversions', 'product_stock_rules',
    'lots', 'serials', 'adjustment_reasons',
    'document_prefixes', 'permissions', 'role_permissions'
  ] loop
    execute format($p$
      create policy %1$s_read on %1$I for select to authenticated
        using (has_perm('master_data.read'))
    $p$, t);
  end loop;
end
$$;

-- Master-data writes need the permission. Lots and serials are excluded:
-- they are created by receiving, not by hand.
do $$
declare
  t text;
begin
  foreach t in array array[
    'warehouses', 'zones', 'locations', 'partners', 'uoms',
    'product_categories', 'departments', 'products', 'product_barcodes',
    'product_uom_conversions', 'product_stock_rules', 'adjustment_reasons'
  ] loop
    execute format($p$
      create policy %1$s_write on %1$I for all to authenticated
        using (has_perm('master_data.write'))
        with check (has_perm('master_data.write'))
    $p$, t);
  end loop;
end
$$;

-- Lots: anyone may create one while receiving; only QC may change status.
-- The status check itself lives in a trigger, because a policy cannot see
-- which column changed.
create policy lots_insert on lots for insert to authenticated
  with check (has_perm('goods_receipt.create') or has_perm('master_data.write'));

create policy lots_update on lots for update to authenticated
  using (has_perm('lot.set_qc_status') or has_perm('master_data.write'))
  with check (has_perm('lot.set_qc_status') or has_perm('master_data.write'));

create policy serials_insert on serials for insert to authenticated
  with check (has_perm('goods_receipt.create') or has_perm('master_data.write'));

create policy serials_update on serials for update to authenticated
  with check (has_perm('master_data.write'));

create or replace function lots_guard_qc_status()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  if new.qc_status is distinct from old.qc_status then
    if not public.has_perm('lot.set_qc_status') then
      raise exception 'permission denied: lot.set_qc_status is required to change QC status'
        using errcode = '42501';
    end if;
    new.qc_by := coalesce(new.qc_by, (select auth.uid()));
    new.qc_at := coalesce(new.qc_at, now());
  end if;
  return new;
end
$$;

create trigger trg_lots_guard_qc
  before update on lots
  for each row execute function lots_guard_qc_status();

-- -------------------------------------------------------------------------
-- Profiles
-- -------------------------------------------------------------------------

create policy user_profiles_self_read on user_profiles for select to authenticated
  using (id = (select auth.uid()) or has_perm('master_data.read'));

create policy user_profiles_admin_write on user_profiles for all to authenticated
  using (has_perm('user.manage'))
  with check (has_perm('user.manage'));

-- -------------------------------------------------------------------------
-- The ledger: readable, never writable
--
-- No INSERT, UPDATE or DELETE policy exists on stock_movements. That is not
-- an omission -- it is the design (D-06). post_document() is SECURITY
-- DEFINER and therefore the only path in.
-- -------------------------------------------------------------------------

create policy stock_movements_read on stock_movements for select to authenticated
  using (has_perm('report.read') or has_perm('master_data.read'));

create policy audit_log_read on audit_log for select to authenticated
  using (has_perm('report.read'));

create policy document_sequences_read on document_sequences for select to authenticated
  using (has_perm('report.read'));

-- -------------------------------------------------------------------------
-- Documents
--
-- Read: anyone who can see reports.
-- Insert: needs <type>.create.
-- Update: only while the document is still a draft, and only by its author or
--         someone who can approve it. Status transitions go through RPCs, not
--         a direct UPDATE.
-- Delete: drafts only.
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
    execute format($p$
      create policy %1$s_read on %1$I for select to authenticated
        using (has_perm('report.read'))
    $p$, d.tbl);

    execute format($p$
      create policy %1$s_insert on %1$I for insert to authenticated
        with check (has_perm('%2$s.create') and created_by = (select auth.uid()))
    $p$, d.tbl, d.perm);

    execute format($p$
      create policy %1$s_update on %1$I for update to authenticated
        using (
          status = 'draft'
          and (created_by = (select auth.uid()) or has_perm('%2$s.approve'))
        )
        with check (
          status in ('draft', 'submitted')
          and (created_by = (select auth.uid()) or has_perm('%2$s.approve'))
        )
    $p$, d.tbl, d.perm);

    execute format($p$
      create policy %1$s_delete on %1$I for delete to authenticated
        using (status = 'draft' and created_by = (select auth.uid()))
    $p$, d.tbl);
  end loop;
end
$$;

-- Lines follow their header: if you may edit the draft, you may edit its lines.
do $$
declare
  l record;
begin
  for l in
    select * from (values
      ('goods_receipt_lines',          'goods_receipts',          'goods_receipt'),
      ('requisition_lines',            'requisitions',            'requisition'),
      ('issue_lines',                  'issues',                  'issue'),
      ('transfer_lines',               'transfers',               'transfer'),
      ('delivery_note_lines',          'delivery_notes',          'delivery_note'),
      ('consignment_settlement_lines', 'consignment_settlements', 'consignment_settlement'),
      ('adjustment_lines',             'adjustments',             'adjustment'),
      ('cycle_count_lines',            'cycle_counts',            'cycle_count')
    ) as t(tbl, hdr, perm)
  loop
    execute format($p$
      create policy %1$s_read on %1$I for select to authenticated
        using (has_perm('report.read'))
    $p$, l.tbl);

    execute format($p$
      create policy %1$s_write on %1$I for all to authenticated
        using (exists (
          select 1 from %2$I h
          where h.id = header_id
            and h.status = 'draft'
            and (h.created_by = (select auth.uid()) or has_perm('%3$s.approve'))
        ))
        with check (exists (
          select 1 from %2$I h
          where h.id = header_id
            and h.status = 'draft'
            and (h.created_by = (select auth.uid()) or has_perm('%3$s.approve'))
        ))
    $p$, l.tbl, l.hdr, l.perm);
  end loop;
end
$$;

-- -------------------------------------------------------------------------
-- Settings, alerts, sync
-- -------------------------------------------------------------------------

create policy settings_read on settings for select to authenticated
  using (has_perm('master_data.read'));
create policy settings_write on settings for all to authenticated
  using (has_perm('settings.manage')) with check (has_perm('settings.manage'));

create policy alerts_read on alerts for select to authenticated
  using (has_perm('report.read'));
create policy alerts_ack on alerts for update to authenticated
  using (has_perm('alert.acknowledge')) with check (has_perm('alert.acknowledge'));

create policy alert_rules_read on alert_rules for select to authenticated
  using (has_perm('report.read'));
create policy alert_rules_write on alert_rules for all to authenticated
  using (has_perm('settings.manage')) with check (has_perm('settings.manage'));

do $$
declare
  t text;
begin
  foreach t in array array[
    'erp_sync_map', 'erp_import_batches', 'erp_import_rows', 'erp_sync_log'
  ] loop
    execute format($p$
      create policy %1$s_read on %1$I for select to authenticated
        using (has_perm('report.read'))
    $p$, t);
    execute format($p$
      create policy %1$s_write on %1$I for all to authenticated
        using (has_perm('erp.import')) with check (has_perm('erp.import'))
    $p$, t);
  end loop;
end
$$;

-- -------------------------------------------------------------------------
-- Grants
--
-- RLS narrows what a role may touch, but the role still needs the underlying
-- privilege. anon gets nothing: this is an internal system with no public
-- surface.
-- -------------------------------------------------------------------------

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update, delete on all tables in schema public to authenticated;

-- Re-revoke the ledger. The blanket grant above would otherwise hand back
-- exactly what 0005 and 0008 took away.
revoke insert, update, delete, truncate on stock_movements from authenticated;
revoke insert, update, delete, truncate on audit_log from authenticated;
revoke insert, update, delete on document_sequences from authenticated;
revoke insert, update, delete on document_prefixes from authenticated;
revoke insert, update, delete on permissions from authenticated;

grant execute on all functions in schema public to authenticated;

revoke all on schema public from anon;
