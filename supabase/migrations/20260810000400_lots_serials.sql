-- =========================================================================
-- 0004 · Lot and serial tracking
--
-- QC status lives on the LOT, not on the location (D-04). A lot that fails
-- must become unavailable everywhere at once, including any quantity already
-- put away into storage before the result came back.
-- =========================================================================

create table lots (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id),
  lot_no           text not null,
  supplier_lot_no  text,
  mfg_date         date,
  expiry_date      date,
  qc_status        qc_status not null default 'pending_qc',
  qc_by            uuid references user_profiles(id),
  qc_at            timestamptz,
  qc_note          text,
  received_document_id uuid,   -- the GRN that created it; polymorphic, no FK
  created_at       timestamptz not null default now(),
  updated_at       timestamptz,

  unique (product_id, lot_no),
  constraint expiry_after_mfg check (
    mfg_date is null or expiry_date is null or expiry_date >= mfg_date
  ),
  -- A cleared or rejected lot must say who decided and when. Without this the
  -- QC gate is unauditable, which defeats the point of having one.
  constraint qc_decision_recorded check (
    qc_status = 'pending_qc' or (qc_by is not null and qc_at is not null)
  )
);

create index lots_product_idx on lots (product_id);
create index lots_expiry_idx on lots (expiry_date) where expiry_date is not null;
create index lots_qc_pending_idx on lots (created_at) where qc_status = 'pending_qc';

comment on column lots.qc_status is
  'pending_qc and failed stock is visible but not consumable. Enforced in post_document(), not only in the UI.';

-- Only lot-tracked products may have lots. Without this a product could be
-- switched to lot tracking by accident and acquire orphan lots.
create or replace function lots_check_product_tracking()
  returns trigger language plpgsql
  set search_path = ''
as $$
declare
  v_mode public.tracking_mode;
begin
  select tracking_mode into v_mode from public.products where id = new.product_id;
  if v_mode not in ('lot', 'serial') then
    raise exception
      'product % has tracking_mode=%, so it cannot have lots', new.product_id, v_mode
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger trg_lots_check_tracking
  before insert or update of product_id on lots
  for each row execute function lots_check_product_tracking();

-- Default expiry from the product's shelf life, when the receiver did not
-- type one. Warehouse staff scanning a drum should not have to do date
-- arithmetic on a handheld.
create or replace function lots_default_expiry()
  returns trigger language plpgsql
  set search_path = ''
as $$
declare
  v_shelf integer;
begin
  if new.expiry_date is null and new.mfg_date is not null then
    select shelf_life_days into v_shelf from public.products where id = new.product_id;
    if v_shelf is not null then
      new.expiry_date := new.mfg_date + v_shelf;
    end if;
  end if;
  return new;
end
$$;

create trigger trg_lots_default_expiry
  before insert on lots
  for each row execute function lots_default_expiry();

-- -------------------------------------------------------------------------
-- Serials
--
-- `status` is a convenience mirror for list screens. A serial's CURRENT
-- LOCATION is never stored -- it is derived from the ledger, same as every
-- other quantity in this system (D-01). See serial_current_state in 0006.
-- -------------------------------------------------------------------------

create table serials (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id),
  lot_id      uuid references lots(id),
  serial_no   text not null,
  status      serial_status not null default 'in_stock',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  unique (product_id, serial_no)
);

create index serials_product_idx on serials (product_id);
create index serials_lot_idx on serials (lot_id) where lot_id is not null;

create or replace function serials_check_product_tracking()
  returns trigger language plpgsql
  set search_path = ''
as $$
declare
  v_mode public.tracking_mode;
begin
  select tracking_mode into v_mode from public.products where id = new.product_id;
  if v_mode <> 'serial' then
    raise exception
      'product % has tracking_mode=%, so it cannot have serials', new.product_id, v_mode
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger trg_serials_check_tracking
  before insert or update of product_id on serials
  for each row execute function serials_check_product_tracking();
