-- =========================================================================
-- 0013 · A dedicated permission for label printing
--
-- Found while building the nav (screen 1.1): the Labels screen was gated on
-- master_data.read, which `viewer` holds — so accounting and management would
-- see a warehouse label-printing screen. Widening or narrowing an existing
-- permission would have mis-fitted some other role, because "may read master
-- data" and "may print barcode labels" are genuinely different questions.
--
-- Permissions are data, not hard-coded role checks (D-09), so this is a row,
-- not a special case in the UI.
-- =========================================================================

insert into permissions (key, description)
values ('label.print', 'Print product, lot and location barcode labels')
on conflict (key) do nothing;

-- Everyone who physically handles stock. Deliberately not `viewer`: a
-- read-only accounting user has no reason to print a bin label.
--
-- `qc` is included because lot labels get reprinted when a lot is relabelled
-- after a QC decision, and QC is the role standing at the pallet when that
-- happens.
insert into role_permissions (role, permission_key)
values
  ('admin', 'label.print'),
  ('warehouse_manager', 'label.print'),
  ('warehouse_staff', 'label.print'),
  ('qc', 'label.print')
on conflict do nothing;
