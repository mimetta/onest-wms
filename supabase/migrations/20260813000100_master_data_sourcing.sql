-- =========================================================================
-- 0014 · Master-data ownership, and supplier cost data
--
-- Two policy decisions land here (D-33, D-34).
--
-- 1. AccCloud is the system of record for whether a product or partner
--    EXISTS, and for its core identity — code, names, tax data. The WMS owns
--    the enrichment AccCloud has no concept of: tracking mode, QC requirement,
--    barcodes, stock rules, shelf life, MOQ, partner notes.
--
--    Creating one in the WMS stays possible but becomes admin-only, and the
--    record is marked `local` until an import matches it by code. That way
--    accounting owns the master list without receiving ever being blocked by a
--    product nobody has entered into AccCloud yet.
--
-- 2. Supplier MOQ and purchase price get their schema now, because it is cheap
--    to add and awkward to retrofit. Populating them is Phase 4.
-- =========================================================================

create type master_source as enum ('acccloud', 'local');

-- -------------------------------------------------------------------------
-- Provenance on products and partners
-- -------------------------------------------------------------------------

alter table products
  add column source master_source not null default 'local',
  add column acccloud_linked_at timestamptz,
  -- Minimum order quantity agreed with the supplier, in the product's base
  -- unit. Enrichment: AccCloud may or may not expose it (see PLAN.md §18.4).
  add column supplier_moq numeric(18,4) check (supplier_moq is null or supplier_moq > 0);

alter table partners
  add column source master_source not null default 'local',
  add column acccloud_linked_at timestamptz,
  -- Free text the warehouse keeps about a partner: delivery quirks, gate
  -- access, who to call. Never round-trips to AccCloud.
  add column notes text;

comment on column products.source is
  'acccloud = originated in or matched to AccCloud. local = created in the WMS and not yet linked (D-33).';

comment on column products.acccloud_linked_at is
  'When the Phase 4 import matched this record to an AccCloud row by code.';

-- "Awaiting link" is a derived state, not a third enum value: a record is
-- awaiting link exactly when it is local and has never been matched. Deriving
-- it means the badge cannot disagree with reality.
create index products_awaiting_link_idx on products (created_at)
  where source = 'local' and acccloud_linked_at is null;

create index partners_awaiting_link_idx on partners (created_at)
  where source = 'local' and acccloud_linked_at is null;

-- Anything already carrying an AccCloud code came from there.
update products set source = 'acccloud', acccloud_linked_at = now()
  where acccloud_item_code is not null;

update partners set source = 'acccloud', acccloud_linked_at = now()
  where acccloud_partner_code is not null;

-- -------------------------------------------------------------------------
-- Purchase price history
--
-- Append-only, like the ledger and the audit log. A price is a fact about a
-- moment: overwriting last quarter's price destroys the ability to explain a
-- cost change, and the same discipline that protects stock history should
-- protect cost history.
-- -------------------------------------------------------------------------

create table product_price_history (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  partner_id     uuid references partners(id),
  price          numeric(18,4) not null check (price >= 0),
  currency       text not null default 'THB' check (char_length(currency) = 3),
  source         text not null check (source in ('import', 'manual')),
  effective_date date not null default bkk_today(),
  note           text,
  created_by     uuid references user_profiles(id),
  created_at     timestamptz not null default now()
);

create index product_price_history_lookup_idx
  on product_price_history (product_id, partner_id, effective_date desc);

create or replace function product_price_history_immutable()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  raise exception
    'product_price_history is append-only: % is not permitted. Record a new price instead.',
    tg_op
    using errcode = '42501';
end
$$;

create trigger trg_product_price_history_no_update
  before update or delete on product_price_history
  for each row execute function product_price_history_immutable();

create trigger trg_product_price_history_no_truncate
  before truncate on product_price_history
  for each statement execute function product_price_history_immutable();

revoke update, delete, truncate on product_price_history from public;
revoke update, delete, truncate on product_price_history from anon, authenticated, service_role;

-- Latest price per product per supplier.
--
-- DISTINCT ON is the cheap way to say "most recent row per group" in Postgres.
-- Ordering by created_at as well as effective_date settles the case where two
-- prices share an effective date — the later entry wins, because that is the
-- correction.
create view product_latest_price with (security_invoker = true) as
  select distinct on (h.product_id, h.partner_id)
    h.product_id,
    h.partner_id,
    h.price,
    h.currency,
    h.effective_date,
    h.source,
    h.created_at
  from product_price_history h
  order by h.product_id, h.partner_id, h.effective_date desc, h.created_at desc;

comment on view product_latest_price is
  'Most recent purchase price per product and supplier. Read requires cost.read (D-34).';

-- -------------------------------------------------------------------------
-- Permissions
-- -------------------------------------------------------------------------

insert into permissions (key, description) values
  ('master_data.create',
   'Create products and partners in the WMS. Admin only: AccCloud is the system of record for existence (D-33).'),
  ('cost.read',
   'See purchase prices and supplier MOQ. Never shown on warehouse operation screens (D-34).'),
  ('cost.write',
   'Record a purchase price by hand')
on conflict (key) do nothing;

-- Creation is admin-only. Everyone who could previously write master data can
-- still EDIT it — the restriction is on bringing a record into existence.
insert into role_permissions (role, permission_key) values
  ('admin', 'master_data.create'),
  ('admin', 'cost.read'),
  ('admin', 'cost.write'),
  ('warehouse_manager', 'cost.read'),
  ('warehouse_manager', 'cost.write'),
  -- viewer is accounting and management: cost is precisely what they are here
  -- for, and they cannot change anything.
  ('viewer', 'cost.read')
on conflict do nothing;

-- Deliberately NOT granted to warehouse_staff or qc. A picker does not need to
-- know what a drum cost, and putting it on a scan screen would be a privacy
-- and a focus problem at once.

-- -------------------------------------------------------------------------
-- RLS: split creation from editing
--
-- The existing products/partners policies were FOR ALL on master_data.write.
-- They are replaced with separate INSERT and UPDATE policies so creation can
-- require the narrower permission.
-- -------------------------------------------------------------------------

drop policy products_write on products;
drop policy partners_write on partners;

create policy products_insert on products for insert to authenticated
  with check (has_perm('master_data.create'));
create policy products_update on products for update to authenticated
  using (has_perm('master_data.write')) with check (has_perm('master_data.write'));
create policy products_delete on products for delete to authenticated
  using (has_perm('master_data.create'));

create policy partners_insert on partners for insert to authenticated
  with check (has_perm('master_data.create'));
create policy partners_update on partners for update to authenticated
  using (has_perm('master_data.write')) with check (has_perm('master_data.write'));
create policy partners_delete on partners for delete to authenticated
  using (has_perm('master_data.create'));

-- Price history: readable only with cost.read, writable only with cost.write.
alter table product_price_history enable row level security;

create policy product_price_history_read on product_price_history
  for select to authenticated using (has_perm('cost.read'));

create policy product_price_history_insert on product_price_history
  for insert to authenticated with check (has_perm('cost.write'));

grant select, insert on product_price_history to authenticated;

-- -------------------------------------------------------------------------
-- Guard: supplier_moq is cost-adjacent but lives on products, which everyone
-- can read. That is deliberate — MOQ is an operational number a receiver may
-- legitimately need — but price never lives on products, only in the history
-- table behind cost.read.
-- -------------------------------------------------------------------------
comment on column products.supplier_moq is
  'Minimum order quantity in base units. Readable by anyone with master_data.read; price is not (D-34).';
