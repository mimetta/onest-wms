-- =========================================================================
-- 0005 · The ledger
--
-- This is the only table in the system that changes stock, and the only one
-- that cannot be changed itself. Everything else -- every view, report,
-- dashboard, alert and pick suggestion -- is derived from it.
--
-- Shape (D-02): qty is ALWAYS POSITIVE. Direction is carried by
-- from_location_id / to_location_id, either of which may be null to mean
-- "entered the company" or "left the company". One physical hop is one row,
-- so a transfer cannot be half-recorded and history reads as a path.
--
--   receipt          NULL      -> RECV-01
--   putaway          RECV-01   -> A-01-02
--   issue            PICK-03   -> NULL
--   transfer leg 1   A-01-02   -> IN-TRANSIT
--   transfer leg 2   IN-TRANSIT-> B-04-01
--   adjust up        NULL      -> A-01-02
--   adjust down      A-01-02   -> NULL
-- =========================================================================

create table stock_movements (
  id                bigint generated always as identity primary key,
  occurred_at       timestamptz not null default now(),
  warehouse_id      uuid not null references warehouses(id),
  product_id        uuid not null references products(id),
  lot_id            uuid references lots(id),
  serial_id         uuid references serials(id),
  qty               numeric(18,4) not null,
  uom_id            uuid not null references uoms(id),   -- always the product's base uom
  from_location_id  uuid references locations(id),
  to_location_id    uuid references locations(id),

  -- Polymorphic: eight document tables, so no foreign key is possible. The
  -- pair is always populated and always points at a real document, because
  -- post_document() is the only writer (D-06).
  document_type     document_type not null,
  document_id       uuid not null,
  document_line_id  uuid not null,

  user_id           uuid not null references user_profiles(id),
  device_id         text,
  note              text,
  created_at        timestamptz not null default now(),

  constraint qty_positive   check (qty > 0),
  constraint has_direction  check (from_location_id is not null or to_location_id is not null),
  constraint no_self_move   check (from_location_id is distinct from to_location_id),
  constraint serial_qty_one check (serial_id is null or qty = 1)
);

comment on table stock_movements is
  'Append-only stock ledger. On-hand is derived from this table and stored nowhere. Corrections are new reversing rows -- never UPDATE, never DELETE (D-01, D-03).';

-- -------------------------------------------------------------------------
-- Append-only enforcement
--
-- Belt and braces on purpose. The trigger catches application mistakes; the
-- revoked grants catch anything connecting with elevated credentials. Neither
-- is sufficient alone -- a superuser ignores the grant, and TRUNCATE ignores
-- a row-level trigger, which is why there is a statement-level trigger too.
-- -------------------------------------------------------------------------

create or replace function stock_movements_immutable()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  raise exception
    'stock_movements is append-only: % is not permitted. Post a reversing movement instead.',
    tg_op
    using errcode = '42501';
end
$$;

create trigger trg_stock_movements_no_update
  before update or delete on stock_movements
  for each row execute function stock_movements_immutable();

create trigger trg_stock_movements_no_truncate
  before truncate on stock_movements
  for each statement execute function stock_movements_immutable();

revoke update, delete, truncate on stock_movements from public;
revoke update, delete, truncate on stock_movements from anon, authenticated, service_role;

-- -------------------------------------------------------------------------
-- Tracking discipline
--
-- Cannot be a CHECK constraint: it needs to look up the product's tracking
-- mode. A lot-tracked product moving without a lot would make every lot
-- balance silently wrong, so this is enforced on the ledger itself rather
-- than trusted to the posting function alone.
-- -------------------------------------------------------------------------

create or replace function stock_movements_check_tracking()
  returns trigger language plpgsql
  set search_path = ''
as $$
declare
  v_mode     public.tracking_mode;
  v_base_uom uuid;
begin
  select tracking_mode, base_uom_id into v_mode, v_base_uom
  from public.products where id = new.product_id;

  if v_mode = 'none' then
    if new.lot_id is not null or new.serial_id is not null then
      raise exception 'product % is not tracked, so movements must carry no lot or serial',
        new.product_id using errcode = '23514';
    end if;

  elsif v_mode = 'lot' then
    if new.lot_id is null then
      raise exception 'product % is lot-tracked, so every movement must carry a lot',
        new.product_id using errcode = '23514';
    end if;
    if new.serial_id is not null then
      raise exception 'product % is lot-tracked, not serial-tracked', new.product_id
        using errcode = '23514';
    end if;

  elsif v_mode = 'serial' then
    if new.serial_id is null then
      raise exception 'product % is serial-tracked, so every movement must carry a serial',
        new.product_id using errcode = '23514';
    end if;
  end if;

  -- The lot and serial must actually belong to this product, or balances
  -- would be attributed to the wrong SKU.
  if new.lot_id is not null then
    if not exists (
      select 1 from public.lots
      where id = new.lot_id and product_id = new.product_id
    ) then
      raise exception 'lot % does not belong to product %', new.lot_id, new.product_id
        using errcode = '23514';
    end if;
  end if;

  if new.serial_id is not null then
    if not exists (
      select 1 from public.serials
      where id = new.serial_id and product_id = new.product_id
    ) then
      raise exception 'serial % does not belong to product %', new.serial_id, new.product_id
        using errcode = '23514';
    end if;
  end if;

  -- The ledger is stored in base UOM only. Documents convert on the way in
  -- (to_base_qty), so that every aggregate is a plain sum with no unit maths.
  if new.uom_id <> v_base_uom then
    raise exception
      'movements must be recorded in the product''s base unit (expected %, got %)',
      v_base_uom, new.uom_id using errcode = '23514';
  end if;

  return new;
end
$$;

create trigger trg_stock_movements_check_tracking
  before insert on stock_movements
  for each row execute function stock_movements_check_tracking();

-- -------------------------------------------------------------------------
-- tracking_mode is immutable once a product has moved (D-12)
--
-- Switching a product from 'none' to 'lot' retroactively would leave every
-- historic movement without a lot, so lot balances would be wrong from the
-- first row and the ledger would be unreadable. Lives here rather than in
-- 0003 because it needs stock_movements to exist.
-- -------------------------------------------------------------------------

create or replace function products_freeze_tracking_mode()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  if new.tracking_mode is distinct from old.tracking_mode
     and exists (select 1 from public.stock_movements where product_id = old.id)
  then
    raise exception
      'product % has movements, so its tracking_mode cannot change from % to %. Create a new SKU and transfer the balance instead.',
      old.sku, old.tracking_mode, new.tracking_mode
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger trg_products_freeze_tracking_mode
  before update of tracking_mode on products
  for each row execute function products_freeze_tracking_mode();

-- -------------------------------------------------------------------------
-- Indexes
--
-- The two composite indexes are what make the derived-stock model viable:
-- every on-hand query is an aggregate over one of them.
-- -------------------------------------------------------------------------

create index stock_movements_in_idx
  on stock_movements (product_id, lot_id, to_location_id)
  where to_location_id is not null;

create index stock_movements_out_idx
  on stock_movements (product_id, lot_id, from_location_id)
  where from_location_id is not null;

create index stock_movements_document_idx on stock_movements (document_type, document_id);
create index stock_movements_occurred_idx on stock_movements (occurred_at desc);
create index stock_movements_warehouse_time_idx on stock_movements (warehouse_id, occurred_at desc);
create index stock_movements_serial_idx on stock_movements (serial_id, occurred_at desc)
  where serial_id is not null;
create index stock_movements_lot_idx on stock_movements (lot_id) where lot_id is not null;
