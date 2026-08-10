-- =========================================================================
-- 0007 · Documents
--
-- Eight types, one shape: header + lines, one status workflow, one numbering
-- scheme. They differ only in which extra columns the header carries and
-- which movements posting produces.
--
--   draft -> submitted -> approved -> posted
--                                  \-> dispatched -> posted   (transfers)
--   draft | submitted | approved  -> cancelled
--
-- A POSTED document is never cancelled. It is corrected by a reversing
-- document, because the ledger it wrote cannot be unwritten (D-03).
-- =========================================================================

-- -------------------------------------------------------------------------
-- Document numbering
--
-- Numbers are assigned at POST time, not when a draft is created, so an
-- abandoned draft does not burn a number and leave a gap accounting has to
-- explain (D-08). Gregorian year: Buddhist era is a print concern only.
-- -------------------------------------------------------------------------

create table document_sequences (
  doc_type  document_type not null,
  year      integer not null,
  last_no   integer not null default 0,
  primary key (doc_type, year)
);

create table document_prefixes (
  doc_type  document_type primary key,
  prefix    text not null unique
);

insert into document_prefixes (doc_type, prefix) values
  ('goods_receipt',          'GR'),
  ('requisition',            'RQ'),
  ('issue',                  'IS'),
  ('transfer',               'TR'),
  ('delivery_note',          'DN'),
  ('consignment_settlement', 'CS'),
  ('adjustment',             'AJ'),
  ('cycle_count',            'CC');

create or replace function next_doc_no(p_doc_type document_type)
  returns text
  language plpgsql
  set search_path = ''
as $$
declare
  v_year   integer := extract(year from public.bkk_today());
  v_next   integer;
  v_prefix text;
begin
  select prefix into v_prefix from public.document_prefixes where doc_type = p_doc_type;

  -- ON CONFLICT ... DO UPDATE takes a row lock, so two concurrent posts
  -- serialise here rather than both reading the same last_no.
  insert into public.document_sequences (doc_type, year, last_no)
  values (p_doc_type, v_year, 1)
  on conflict (doc_type, year)
    do update set last_no = public.document_sequences.last_no + 1
  returning last_no into v_next;

  return format('%s-%s-%s', v_prefix, v_year, lpad(v_next::text, 5, '0'));
end
$$;

comment on function next_doc_no(document_type) is
  'Allocates the next running number, e.g. GR-2026-00001. Called inside the posting transaction only.';

-- -------------------------------------------------------------------------
-- Shared status-transition guard
--
-- Attached to every header table. Keeping the rules in one function means a
-- ninth document type cannot quietly acquire a different workflow.
-- -------------------------------------------------------------------------

create or replace function document_check_status_transition()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'posted' then
    raise exception
      'document % is posted and cannot change status. Post a reversing document instead.',
      coalesce(old.doc_no, old.id::text)
      using errcode = '23514';
  end if;

  if old.status = 'cancelled' then
    raise exception 'document % is cancelled and cannot be reopened',
      coalesce(old.doc_no, old.id::text) using errcode = '23514';
  end if;

  if new.status = 'cancelled' then
    return new;  -- legal from draft, submitted, approved and dispatched
  end if;

  if not (
    (old.status = 'draft'      and new.status = 'submitted')  or
    (old.status = 'submitted'  and new.status in ('approved', 'draft')) or
    (old.status = 'approved'   and new.status in ('posted', 'dispatched')) or
    (old.status = 'dispatched' and new.status = 'posted')
  ) then
    raise exception 'illegal status transition % -> %', old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end
$$;

-- -------------------------------------------------------------------------
-- Shared line trigger: convert the entered quantity into base UOM
--
-- Documents let users work in whatever unit is on the label -- a drum, a
-- case, a kilo. The ledger only ever stores base units, so the conversion
-- happens once, here, rather than in eight places (D-10).
-- -------------------------------------------------------------------------

create or replace function document_line_set_base_qty()
  returns trigger language plpgsql
  set search_path = ''
as $$
begin
  new.qty_base := public.to_base_qty(new.product_id, new.uom_id, new.qty);
  return new;
end
$$;

-- =========================================================================
-- Goods receipts (ใบรับสินค้า)
-- =========================================================================

create table goods_receipts (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text unique,
  doc_date        date not null default bkk_today(),
  status          document_status not null default 'draft',
  warehouse_id    uuid not null references warehouses(id),
  partner_id      uuid references partners(id),
  po_reference    text,
  supplier_do_no  text,
  notes           text,
  created_by      uuid not null references user_profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  submitted_by    uuid references user_profiles(id),
  submitted_at    timestamptz,
  approved_by     uuid references user_profiles(id),
  approved_at     timestamptz,
  posted_by       uuid references user_profiles(id),
  posted_at       timestamptz,
  cancelled_by    uuid references user_profiles(id),
  cancelled_at    timestamptz,
  cancel_reason   text
);

create table goods_receipt_lines (
  id               uuid primary key default gen_random_uuid(),
  header_id        uuid not null references goods_receipts(id) on delete cascade,
  line_no          integer not null,
  product_id       uuid not null references products(id),
  lot_id           uuid references lots(id),
  serial_id        uuid references serials(id),
  qty              numeric(18,4) not null check (qty > 0),
  uom_id           uuid not null references uoms(id),
  qty_base         numeric(18,4) not null,
  from_location_id uuid references locations(id),  -- always null: stock enters here
  to_location_id   uuid not null references locations(id),
  note             text,
  unique (header_id, line_no)
);

-- =========================================================================
-- Requisitions (ใบขอเบิก) -- a request. Posts NO movements.
-- =========================================================================

create table requisitions (
  id             uuid primary key default gen_random_uuid(),
  doc_no         text unique,
  doc_date       date not null default bkk_today(),
  status         document_status not null default 'draft',
  warehouse_id   uuid not null references warehouses(id),
  department_id  uuid not null references departments(id),
  required_date  date,
  notes          text,
  created_by     uuid not null references user_profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  submitted_by   uuid references user_profiles(id),
  submitted_at   timestamptz,
  approved_by    uuid references user_profiles(id),
  approved_at    timestamptz,
  posted_by      uuid references user_profiles(id),
  posted_at      timestamptz,
  cancelled_by   uuid references user_profiles(id),
  cancelled_at   timestamptz,
  cancel_reason  text
);

create table requisition_lines (
  id          uuid primary key default gen_random_uuid(),
  header_id   uuid not null references requisitions(id) on delete cascade,
  line_no     integer not null,
  product_id  uuid not null references products(id),
  qty         numeric(18,4) not null check (qty > 0),
  uom_id      uuid not null references uoms(id),
  qty_base    numeric(18,4) not null,
  note        text,
  unique (header_id, line_no)
);

-- =========================================================================
-- Issues (ใบเบิก) -- consumption by a department
--
-- department_id is carried here as well as on the requisition (D-15): an
-- issue can be raised without one, and a department consumption report must
-- not depend on a nullable join.
-- =========================================================================

create table issues (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text unique,
  doc_date        date not null default bkk_today(),
  status          document_status not null default 'draft',
  warehouse_id    uuid not null references warehouses(id),
  department_id   uuid not null references departments(id),
  requisition_id  uuid references requisitions(id),
  notes           text,
  created_by      uuid not null references user_profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  submitted_by    uuid references user_profiles(id),
  submitted_at    timestamptz,
  approved_by     uuid references user_profiles(id),
  approved_at     timestamptz,
  posted_by       uuid references user_profiles(id),
  posted_at       timestamptz,
  cancelled_by    uuid references user_profiles(id),
  cancelled_at    timestamptz,
  cancel_reason   text
);

create table issue_lines (
  id               uuid primary key default gen_random_uuid(),
  header_id        uuid not null references issues(id) on delete cascade,
  line_no          integer not null,
  product_id       uuid not null references products(id),
  lot_id           uuid references lots(id),
  serial_id        uuid references serials(id),
  qty              numeric(18,4) not null check (qty > 0),
  uom_id           uuid not null references uoms(id),
  qty_base         numeric(18,4) not null,
  from_location_id uuid not null references locations(id),
  to_location_id   uuid references locations(id),  -- always null: consumed
  note             text,
  unique (header_id, line_no)
);

-- =========================================================================
-- Transfers (ใบโอนย้าย) -- two legs through in_transit
-- =========================================================================

create table transfers (
  id                 uuid primary key default gen_random_uuid(),
  doc_no             text unique,
  doc_date           date not null default bkk_today(),
  status             document_status not null default 'draft',
  warehouse_id       uuid not null references warehouses(id),
  from_warehouse_id  uuid not null references warehouses(id),
  to_warehouse_id    uuid not null references warehouses(id),
  notes              text,
  created_by         uuid not null references user_profiles(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz,
  submitted_by       uuid references user_profiles(id),
  submitted_at       timestamptz,
  approved_by        uuid references user_profiles(id),
  approved_at        timestamptz,
  dispatched_by      uuid references user_profiles(id),
  dispatched_at      timestamptz,
  posted_by          uuid references user_profiles(id),
  posted_at          timestamptz,
  cancelled_by       uuid references user_profiles(id),
  cancelled_at       timestamptz,
  cancel_reason      text
);

create table transfer_lines (
  id               uuid primary key default gen_random_uuid(),
  header_id        uuid not null references transfers(id) on delete cascade,
  line_no          integer not null,
  product_id       uuid not null references products(id),
  lot_id           uuid references lots(id),
  serial_id        uuid references serials(id),
  qty              numeric(18,4) not null check (qty > 0),
  uom_id           uuid not null references uoms(id),
  qty_base         numeric(18,4) not null,
  from_location_id uuid not null references locations(id),
  to_location_id   uuid not null references locations(id),
  note             text,
  unique (header_id, line_no)
);

-- =========================================================================
-- Delivery notes (ใบส่งสินค้า)
-- =========================================================================

create table delivery_notes (
  id              uuid primary key default gen_random_uuid(),
  doc_no          text unique,
  doc_date        date not null default bkk_today(),
  status          document_status not null default 'draft',
  warehouse_id    uuid not null references warehouses(id),
  partner_id      uuid not null references partners(id),
  so_reference    text,
  -- True when this despatch moves stock to a consignment location rather than
  -- selling it outright. Settlement happens later (consignment_settlements).
  is_consignment  boolean not null default false,
  notes           text,
  created_by      uuid not null references user_profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz,
  submitted_by    uuid references user_profiles(id),
  submitted_at    timestamptz,
  approved_by     uuid references user_profiles(id),
  approved_at     timestamptz,
  posted_by       uuid references user_profiles(id),
  posted_at       timestamptz,
  cancelled_by    uuid references user_profiles(id),
  cancelled_at    timestamptz,
  cancel_reason   text
);

create table delivery_note_lines (
  id               uuid primary key default gen_random_uuid(),
  header_id        uuid not null references delivery_notes(id) on delete cascade,
  line_no          integer not null,
  product_id       uuid not null references products(id),
  lot_id           uuid references lots(id),
  serial_id        uuid references serials(id),
  qty              numeric(18,4) not null check (qty > 0),
  uom_id           uuid not null references uoms(id),
  qty_base         numeric(18,4) not null,
  from_location_id uuid not null references locations(id),
  -- null = sold outright; a consignment_site location = moved, not yet sold
  to_location_id   uuid references locations(id),
  note             text,
  unique (header_id, line_no)
);

-- =========================================================================
-- Consignment settlements -- consumption at a customer site
-- =========================================================================

create table consignment_settlements (
  id             uuid primary key default gen_random_uuid(),
  doc_no         text unique,
  doc_date       date not null default bkk_today(),
  status         document_status not null default 'draft',
  warehouse_id   uuid not null references warehouses(id),
  partner_id     uuid not null references partners(id),
  location_id    uuid not null references locations(id),
  period_from    date,
  period_to      date,
  notes          text,
  created_by     uuid not null references user_profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  submitted_by   uuid references user_profiles(id),
  submitted_at   timestamptz,
  approved_by    uuid references user_profiles(id),
  approved_at    timestamptz,
  posted_by      uuid references user_profiles(id),
  posted_at      timestamptz,
  cancelled_by   uuid references user_profiles(id),
  cancelled_at   timestamptz,
  cancel_reason  text,
  constraint settlement_period check (
    period_from is null or period_to is null or period_to >= period_from
  )
);

create table consignment_settlement_lines (
  id               uuid primary key default gen_random_uuid(),
  header_id        uuid not null references consignment_settlements(id) on delete cascade,
  line_no          integer not null,
  product_id       uuid not null references products(id),
  lot_id           uuid references lots(id),
  serial_id        uuid references serials(id),
  qty              numeric(18,4) not null check (qty > 0),
  uom_id           uuid not null references uoms(id),
  qty_base         numeric(18,4) not null,
  from_location_id uuid not null references locations(id),   -- the consignment site
  to_location_id   uuid references locations(id),            -- always null: sold
  note             text,
  unique (header_id, line_no)
);

-- =========================================================================
-- Adjustments (ใบปรับปรุงสต๊อก)
-- =========================================================================

create table adjustment_reasons (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name_th      text not null,
  name_en      text,
  direction    adjustment_direction not null default 'both',
  -- Marks the reasons that legitimately remove stock that never passed QC:
  -- write-off, damage, scrap, return to supplier. This is what the disposal
  -- class in post_document() keys off, so the QC exemption follows WHY stock
  -- is leaving rather than a hard-coded list of codes (D-14).
  is_disposal  boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table adjustments (
  id                    uuid primary key default gen_random_uuid(),
  doc_no                text unique,
  doc_date              date not null default bkk_today(),
  status                document_status not null default 'draft',
  warehouse_id          uuid not null references warehouses(id),
  reason_code_id        uuid not null references adjustment_reasons(id),
  source_cycle_count_id uuid,
  notes                 text,
  created_by            uuid not null references user_profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz,
  submitted_by          uuid references user_profiles(id),
  submitted_at          timestamptz,
  approved_by           uuid references user_profiles(id),
  approved_at           timestamptz,
  posted_by             uuid references user_profiles(id),
  posted_at             timestamptz,
  cancelled_by          uuid references user_profiles(id),
  cancelled_at          timestamptz,
  cancel_reason         text
);

create table adjustment_lines (
  id               uuid primary key default gen_random_uuid(),
  header_id        uuid not null references adjustments(id) on delete cascade,
  line_no          integer not null,
  product_id       uuid not null references products(id),
  lot_id           uuid references lots(id),
  serial_id        uuid references serials(id),
  qty              numeric(18,4) not null check (qty > 0),
  uom_id           uuid not null references uoms(id),
  qty_base         numeric(18,4) not null,
  -- Exactly one side is populated: from = decrease, to = increase.
  from_location_id uuid references locations(id),
  to_location_id   uuid references locations(id),
  note             text,
  unique (header_id, line_no),
  constraint adjustment_one_sided check (
    (from_location_id is null) <> (to_location_id is null)
  )
);

-- =========================================================================
-- Cycle counts (ใบตรวจนับ) -- posts no movements; generates an adjustment
-- =========================================================================

create table cycle_counts (
  id             uuid primary key default gen_random_uuid(),
  doc_no         text unique,
  doc_date       date not null default bkk_today(),
  status         document_status not null default 'draft',
  warehouse_id   uuid not null references warehouses(id),
  zone_id        uuid references zones(id),
  mode           cycle_count_mode not null default 'blind',
  notes          text,
  created_by     uuid not null references user_profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  submitted_by   uuid references user_profiles(id),
  submitted_at   timestamptz,
  approved_by    uuid references user_profiles(id),
  approved_at    timestamptz,
  posted_by      uuid references user_profiles(id),
  posted_at      timestamptz,
  cancelled_by   uuid references user_profiles(id),
  cancelled_at   timestamptz,
  cancel_reason  text
);

create table cycle_count_lines (
  id                    uuid primary key default gen_random_uuid(),
  header_id             uuid not null references cycle_counts(id) on delete cascade,
  line_no               integer not null,
  product_id            uuid not null references products(id),
  lot_id                uuid references lots(id),
  serial_id             uuid references serials(id),
  location_id           uuid not null references locations(id),
  -- Captured when the sheet is generated, so a later movement does not
  -- retroactively change what the counter was measured against.
  expected_qty_snapshot numeric(18,4) not null default 0,
  counted_qty           numeric(18,4),
  variance_qty          numeric(18,4)
    generated always as (coalesce(counted_qty, 0) - expected_qty_snapshot) stored,
  recount_of_line_id    uuid references cycle_count_lines(id),
  counted_by            uuid references user_profiles(id),
  counted_at            timestamptz,
  note                  text,
  unique (header_id, line_no)
);

alter table adjustments
  add constraint adjustments_cycle_count_fk
  foreign key (source_cycle_count_id) references cycle_counts(id);

-- =========================================================================
-- Wire the shared triggers onto every table
-- =========================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'goods_receipts', 'requisitions', 'issues', 'transfers',
    'delivery_notes', 'consignment_settlements', 'adjustments', 'cycle_counts'
  ] loop
    execute format(
      'create trigger trg_%1$s_status before update of status on %1$s
         for each row execute function document_check_status_transition()', t);
    execute format('create index %1$s_status_idx on %1$s (status, doc_date desc)', t);
    execute format('create index %1$s_created_by_idx on %1$s (created_by)', t);
  end loop;

  -- Cycle count lines have no uom/qty pair to convert, so they are excluded.
  foreach t in array array[
    'goods_receipt_lines', 'requisition_lines', 'issue_lines', 'transfer_lines',
    'delivery_note_lines', 'consignment_settlement_lines', 'adjustment_lines'
  ] loop
    execute format(
      'create trigger trg_%1$s_base_qty before insert or update of qty, uom_id, product_id
         on %1$s for each row execute function document_line_set_base_qty()', t);
    execute format('create index %1$s_header_idx on %1$s (header_id)', t);
  end loop;
end
$$;

create index cycle_count_lines_header_idx on cycle_count_lines (header_id);
