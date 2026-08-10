-- =========================================================================
-- 0003 · Master data: warehouses, zones, locations, partners, products
-- =========================================================================

-- -------------------------------------------------------------------------
-- Warehouses
-- -------------------------------------------------------------------------

create table warehouses (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name_th      text not null,
  name_en      text not null,
  address_th   text,
  address_en   text,
  tax_id       text,
  phone        text,
  is_default   boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

-- Exactly one default warehouse. The UI never asks a user to pick one; it
-- reads this. A partial unique index is what keeps that assumption honest.
create unique index warehouses_single_default_idx
  on warehouses ((true)) where is_default;

alter table user_profiles
  add constraint user_profiles_warehouse_fk
  foreign key (warehouse_id) references warehouses(id);

-- -------------------------------------------------------------------------
-- Partners
-- -------------------------------------------------------------------------

create table partners (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique,
  type                  partner_type not null,
  name_th               text not null,
  name_en               text,
  tax_id                text,
  phone                 text,
  email                 text,
  address_th            text,
  address_en            text,
  acccloud_partner_code text unique,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz
);

create index partners_name_trgm_idx on partners using gin (name_th gin_trgm_ops);

-- -------------------------------------------------------------------------
-- Zones and locations
-- -------------------------------------------------------------------------

create table zones (
  id            uuid primary key default gen_random_uuid(),
  warehouse_id  uuid not null references warehouses(id),
  code          text not null,
  name_th       text not null,
  name_en       text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  unique (warehouse_id, code)
);

create table locations (
  id                   uuid primary key default gen_random_uuid(),
  warehouse_id         uuid not null references warehouses(id),
  zone_id              uuid references zones(id),
  code                 text not null,
  barcode              text not null unique,
  type                 location_type not null,
  -- Drives pick suggestions, dashboards and line-entry validation ONLY.
  -- It is deliberately NOT a posting control -- post_document() checks
  -- on-hand at the exact bin instead, so stock in staging, at a consignment
  -- site, in qc_hold or in transit can still be moved (D-13).
  -- No defaults on these three: the BEFORE INSERT trigger below derives them
  -- from `type` when the caller leaves them null. NOT NULL is still checked,
  -- but only after the trigger has run.
  counts_as_available  boolean not null,
  -- Blocks a consumption-class movement from sourcing here. This is what
  -- guards untracked products, which have no lot and therefore no QC status
  -- to check (D-14).
  blocks_consumption   boolean not null,
  is_virtual           boolean not null,
  partner_id           uuid references partners(id),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz,

  unique (warehouse_id, code),

  -- A consignment site is stock sitting at a named customer. Anything else
  -- with a partner attached is a data-entry mistake.
  constraint consignment_needs_partner check (
    (type = 'consignment_site' and partner_id is not null) or
    (type <> 'consignment_site' and partner_id is null)
  ),

  -- Virtual locations are never physically visited, so they must never end up
  -- on a printed bin label or in a putaway suggestion.
  constraint virtual_types check (
    (is_virtual and type in ('in_transit', 'opening')) or
    (not is_virtual and type not in ('in_transit', 'opening'))
  )
);

create index locations_warehouse_type_idx on locations (warehouse_id, type) where is_active;
create index locations_zone_idx on locations (zone_id);

-- Defaults derived from type, applied on insert when the caller does not say
-- otherwise. Kept in one place so "which locations are pickable" has a single
-- definition rather than being restated in every seed and import.
create or replace function locations_apply_type_defaults()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Only storage and picking hold stock that is free to be sold or issued.
    if new.counts_as_available is null then
      new.counts_as_available := new.type in ('storage', 'picking');
    end if;
    if new.blocks_consumption is null then
      new.blocks_consumption := new.type in ('qc_hold', 'quarantine', 'scrap');
    end if;
    if new.is_virtual is null then
      new.is_virtual := new.type in ('in_transit', 'opening');
    end if;
  end if;
  return new;
end
$$;

create trigger trg_locations_type_defaults
  before insert on locations
  for each row execute function locations_apply_type_defaults();

-- -------------------------------------------------------------------------
-- Units of measure
-- -------------------------------------------------------------------------

create table uoms (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  name_th         text not null,
  name_en         text not null,
  decimal_places  smallint not null default 2 check (decimal_places between 0 and 4),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- -------------------------------------------------------------------------
-- Product categories
-- -------------------------------------------------------------------------

create table product_categories (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_th     text not null,
  name_en     text,
  parent_id   uuid references product_categories(id),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

-- -------------------------------------------------------------------------
-- Departments (the requester on an ใบขอเบิก)
-- -------------------------------------------------------------------------

create table departments (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name_th     text not null,
  name_en     text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);

-- -------------------------------------------------------------------------
-- Products
-- -------------------------------------------------------------------------

create table products (
  id                       uuid primary key default gen_random_uuid(),
  sku                      text not null unique,
  name_th                  text not null,
  name_en                  text,
  category_id              uuid references product_categories(id),
  base_uom_id              uuid not null references uoms(id),
  tracking_mode            tracking_mode not null default 'none',
  shelf_life_days          integer check (shelf_life_days is null or shelf_life_days > 0),
  requires_qc              boolean not null default false,
  is_consignment_eligible  boolean not null default false,
  -- AccCloud prodCode. Match key for CSV import.
  acccloud_item_code       text unique,
  -- AccCloud masterId: their stable internal ID. Preferred match key, because
  -- a prodCode can be renamed by a tidy-up and would then create a duplicate
  -- product on the next import (D-18).
  acccloud_master_id       numeric unique,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz
);

create index products_category_idx on products (category_id) where is_active;
create index products_name_trgm_idx on products using gin (name_th gin_trgm_ops);
create index products_sku_trgm_idx on products using gin (sku gin_trgm_ops);

-- -------------------------------------------------------------------------
-- Barcodes
--
-- One product may carry several: the supplier's, ours, and a case barcode.
-- The barcode itself is unique GLOBALLY, not per product -- a single scan has
-- to resolve to exactly one product or the scan-first screens cannot work.
-- -------------------------------------------------------------------------

create table product_barcodes (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  barcode     text not null unique,
  uom_id      uuid not null references uoms(id),
  type        barcode_type not null default 'internal',
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);

create unique index product_barcodes_one_primary_idx
  on product_barcodes (product_id) where is_primary;

create index product_barcodes_product_idx on product_barcodes (product_id);

-- -------------------------------------------------------------------------
-- UOM conversions
--
-- Per product, not global: drum -> litre is a container size, litre -> kg is
-- density. Both differ per product, so a shared table would be wrong for
-- every solvent after the first (D-10).
-- -------------------------------------------------------------------------

create table product_uom_conversions (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references products(id) on delete cascade,
  from_uom_id uuid not null references uoms(id),
  to_uom_id   uuid not null references uoms(id),
  factor      numeric(18,6) not null check (factor > 0),
  created_at  timestamptz not null default now(),
  unique (product_id, from_uom_id, to_uom_id),
  constraint conversion_not_identity check (from_uom_id <> to_uom_id)
);

-- Converts qty into the product's base UOM. Direct match, declared conversion,
-- or declared inverse -- deliberately not a graph search: a two-hop conversion
-- that nobody declared is more likely a data-entry gap than an intention.
create or replace function to_base_qty(
  p_product_id uuid,
  p_uom_id     uuid,
  p_qty        numeric
) returns numeric
  language plpgsql stable
  set search_path = ''
as $$
declare
  v_base_uom uuid;
  v_factor   numeric;
begin
  select base_uom_id into v_base_uom from public.products where id = p_product_id;
  if v_base_uom is null then
    raise exception 'unknown product %', p_product_id using errcode = '23503';
  end if;

  if p_uom_id = v_base_uom then
    return p_qty;
  end if;

  select factor into v_factor
  from public.product_uom_conversions
  where product_id = p_product_id and from_uom_id = p_uom_id and to_uom_id = v_base_uom;

  if v_factor is not null then
    return p_qty * v_factor;
  end if;

  select 1 / factor into v_factor
  from public.product_uom_conversions
  where product_id = p_product_id and from_uom_id = v_base_uom and to_uom_id = p_uom_id;

  if v_factor is not null then
    return p_qty * v_factor;
  end if;

  raise exception
    'no UOM conversion declared for product % from % to base unit %',
    p_product_id, p_uom_id, v_base_uom
    using errcode = '23514';
end
$$;

-- -------------------------------------------------------------------------
-- Min/max stock rules, per product per warehouse
-- -------------------------------------------------------------------------

create table product_stock_rules (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references products(id) on delete cascade,
  warehouse_id  uuid not null references warehouses(id),
  min_qty       numeric(18,4) not null default 0 check (min_qty >= 0),
  max_qty       numeric(18,4) check (max_qty is null or max_qty >= min_qty),
  reorder_qty   numeric(18,4) check (reorder_qty is null or reorder_qty > 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  unique (product_id, warehouse_id)
);
