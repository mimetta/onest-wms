-- =========================================================================
-- 0010 · Alerts and ERP sync scaffolding
--
-- Phase 0 creates the tables and the adapter's data model. The alerts Edge
-- Function is Phase 3; the AccCloud import UI is Phase 4 (D-17).
-- =========================================================================

create table alert_rules (
  id            uuid primary key default gen_random_uuid(),
  type          alert_type not null,
  severity      alert_severity not null default 'warning',
  -- Rules can be global, per category, or per product. Narrower scope wins.
  category_id   uuid references product_categories(id),
  product_id    uuid references products(id),
  warehouse_id  uuid references warehouses(id),
  params        jsonb not null default '{}'::jsonb,
  is_enabled    boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  constraint rule_scope_is_single check (
    (category_id is not null)::int + (product_id is not null)::int <= 1
  )
);

insert into alert_rules (type, severity, params) values
  ('near_expiry',         'warning',  '{"horizon_days": 30}'::jsonb),
  ('near_expiry',         'info',     '{"horizon_days": 90}'::jsonb),
  ('expired',             'critical', '{}'::jsonb),
  ('low_stock',           'warning',  '{}'::jsonb),
  ('slow_moving',         'info',     '{"days": 90}'::jsonb),
  ('negative_stock',      'critical', '{}'::jsonb),
  ('qc_pending_too_long', 'warning',  '{"hours": 48}'::jsonb);

create table alerts (
  id             uuid primary key default gen_random_uuid(),
  type           alert_type not null,
  severity       alert_severity not null,
  status         alert_status not null default 'open',
  warehouse_id   uuid references warehouses(id),
  product_id     uuid references products(id),
  lot_id         uuid references lots(id),
  location_id    uuid references locations(id),
  payload        jsonb not null default '{}'::jsonb,
  -- Identifies "the same problem" across runs, so a scheduled job that runs
  -- hourly updates one alert instead of creating 24 a day.
  dedupe_key     text not null,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  acked_by       uuid references user_profiles(id),
  acked_at       timestamptz,
  resolved_at    timestamptz,
  -- Reserved so LINE Notify / email delivery can be added without a migration.
  channel_state  jsonb not null default '{}'::jsonb
);

create unique index alerts_open_dedupe_idx on alerts (dedupe_key)
  where status <> 'resolved';
create index alerts_status_idx on alerts (status, severity, last_seen_at desc);
create index alerts_product_idx on alerts (product_id) where status = 'open';

-- -------------------------------------------------------------------------
-- ERP sync (AccCloud -> WMS, inbound only)
-- -------------------------------------------------------------------------

create table erp_sync_map (
  id               uuid primary key default gen_random_uuid(),
  entity_type      erp_entity_type not null,
  wms_id           uuid not null,
  external_system  text not null default 'acccloud',
  external_code    text not null,
  external_name    text,          -- last seen label, for the diff preview
  created_at       timestamptz not null default now(),
  updated_at       timestamptz,
  -- This is what makes import idempotent: re-importing the same file matches
  -- the existing row instead of creating a second one.
  unique (external_system, entity_type, external_code)
);

create index erp_sync_map_wms_idx on erp_sync_map (entity_type, wms_id);

create table erp_import_batches (
  id              uuid primary key default gen_random_uuid(),
  source          text not null default 'csv' check (source in ('csv', 'api')),
  entity_type     erp_entity_type not null,
  filename        text,
  -- Same file uploaded twice is detectable before anything is parsed.
  file_hash       text,
  column_mapping  jsonb not null default '{}'::jsonb,
  status          erp_import_status not null default 'uploaded',
  stats           jsonb not null default '{}'::jsonb,
  uploaded_by     uuid not null references user_profiles(id),
  uploaded_at     timestamptz not null default now(),
  committed_by    uuid references user_profiles(id),
  committed_at    timestamptz,
  error_text      text
);

create table erp_import_rows (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references erp_import_batches(id) on delete cascade,
  row_no      integer not null,
  raw         jsonb not null,
  mapped      jsonb,
  action      erp_row_action not null default 'skip',
  -- Which key the row matched on. A fallback match on prodCode rather than
  -- masterId is visible in the diff preview rather than silent (D-18).
  matched_on  text,
  target_id   uuid,
  error_text  text,
  unique (batch_id, row_no)
);

create index erp_import_rows_batch_action_idx on erp_import_rows (batch_id, action);

create table erp_sync_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  direction      text not null default 'inbound' check (direction = 'inbound'),
  operation      text not null,           -- 'item_master_import', 'reconciliation', ...
  source         text not null,           -- 'csv' | 'api'
  batch_id       uuid references erp_import_batches(id),
  actor_id       uuid references user_profiles(id),
  ok             boolean not null,
  rows_read      integer,
  rows_created   integer,
  rows_updated   integer,
  rows_skipped   integer,
  rows_errored   integer,
  detail         jsonb not null default '{}'::jsonb,
  error_text     text
);

create index erp_sync_log_at_idx on erp_sync_log (at desc);

comment on table erp_sync_log is
  'Every import and reconciliation run. Direction is inbound-only by constraint: nothing is written back to AccCloud in v1.';
