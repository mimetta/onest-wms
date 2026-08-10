-- =========================================================================
-- 0002 · Identity: profiles, permissions, and the auth helper functions
--
-- Permissions are rows, not hard-coded role checks (D-09). Policies and
-- posting functions ask has_perm('issue.approve'), never role = 'admin', so
-- the approval chain is a seed change rather than a migration.
-- =========================================================================

create table user_profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  full_name     text not null,
  role          user_role not null default 'viewer',
  warehouse_id  uuid,                      -- FK added in 0003, after warehouses exists
  locale        text not null default 'th' check (locale in ('th', 'en')),
  phone         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz
);

comment on table user_profiles is
  'One row per auth user. warehouse_id scopes what RLS lets them read.';

create index user_profiles_role_idx on user_profiles (role) where is_active;

-- -------------------------------------------------------------------------
-- Permission catalogue
--
-- Kept as a table (rather than a free-text column) so a typo in a seed file
-- fails loudly at insert time instead of silently granting nothing.
-- -------------------------------------------------------------------------

create table permissions (
  key         text primary key,
  description text not null
);

create table role_permissions (
  role           user_role not null,
  permission_key text not null references permissions(key) on delete cascade,
  primary key (role, permission_key)
);

-- -------------------------------------------------------------------------
-- Auth helpers
--
-- SECURITY DEFINER so they can read user_profiles without tripping the RLS
-- policies that are themselves defined in terms of these functions -- without
-- that, every policy on user_profiles would recurse into itself.
--
-- search_path is pinned to empty on every SECURITY DEFINER function in this
-- project: it stops a caller from shadowing `user_profiles` with a temp table
-- and getting the function to read the wrong rows.
-- -------------------------------------------------------------------------

create or replace function auth_profile()
  returns user_profiles
  language sql stable security definer
  set search_path = ''
as $$
  select p.* from public.user_profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

create or replace function auth_role()
  returns user_role
  language sql stable security definer
  set search_path = ''
as $$
  select p.role from public.user_profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

create or replace function auth_warehouse()
  returns uuid
  language sql stable security definer
  set search_path = ''
as $$
  select p.warehouse_id from public.user_profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

create or replace function has_perm(p_key text)
  returns boolean
  language sql stable security definer
  set search_path = ''
as $$
  select exists (
    select 1
    from public.user_profiles p
    join public.role_permissions rp on rp.role = p.role
    where p.id = (select auth.uid())
      and p.is_active
      and rp.permission_key = p_key
  )
$$;

comment on function has_perm(text) is
  'True if the calling user''s role grants this permission. The only authorisation predicate used anywhere in this schema.';

-- Raises instead of returning false. Used inside SECURITY DEFINER routines,
-- where silently doing nothing would be worse than an error the caller sees.
create or replace function require_perm(p_key text)
  returns void
  language plpgsql stable security definer
  set search_path = ''
as $$
begin
  if not public.has_perm(p_key) then
    raise exception 'permission denied: % is required', p_key
      using errcode = '42501';
  end if;
end
$$;

-- -------------------------------------------------------------------------
-- Permission catalogue contents
--
-- Seeded here rather than in seed.sql because policies reference these keys:
-- they are schema, not demo data.
-- -------------------------------------------------------------------------

insert into permissions (key, description) values
  ('master_data.read',            'Read products, locations, partners and other master data'),
  ('master_data.write',           'Create and edit master data'),
  ('user.manage',                 'Create users and assign roles'),
  ('settings.manage',             'Change system settings and alert thresholds'),

  ('goods_receipt.create',        'Create a goods receipt'),
  ('goods_receipt.approve',       'Approve a goods receipt'),
  ('goods_receipt.post',          'Post a goods receipt to the ledger'),

  ('requisition.create',          'Raise a requisition (ใบขอเบิก)'),
  ('requisition.approve',         'Approve a requisition'),

  ('issue.create',                'Create an issue (ใบเบิก)'),
  ('issue.approve',               'Approve an issue'),
  ('issue.post',                  'Post an issue to the ledger'),

  ('transfer.create',             'Create a transfer'),
  ('transfer.approve',            'Approve a transfer'),
  ('transfer.post',               'Dispatch or receive a transfer'),

  ('delivery_note.create',        'Create a delivery note (ใบส่งสินค้า)'),
  ('delivery_note.approve',       'Approve a delivery note'),
  ('delivery_note.post',          'Post a delivery note to the ledger'),

  ('consignment_settlement.create',  'Record consumption at a consignment site'),
  ('consignment_settlement.approve', 'Approve a consignment settlement'),
  ('consignment_settlement.post',    'Post a consignment settlement to the ledger'),

  ('adjustment.create',           'Create a stock adjustment'),
  ('adjustment.approve',          'Approve a stock adjustment'),
  ('adjustment.post',             'Post an adjustment to the ledger'),

  ('cycle_count.create',          'Create and enter a cycle count'),
  ('cycle_count.approve',         'Approve a cycle count and generate its adjustment'),
  ('cycle_count.post',            'Post a cycle count'),

  ('lot.set_qc_status',           'Pass, fail or quarantine a lot'),
  ('lot.dispose_unpassed',        'Scrap, write off or return stock from a lot that has not passed QC (D-14)'),
  ('stock.negative_override',     'Post a movement that takes a bin negative, with a reason'),

  ('alert.acknowledge',           'Acknowledge and resolve alerts'),
  ('erp.import',                  'Run and commit an AccCloud import'),
  ('report.read',                 'View dashboards and reports');

-- -------------------------------------------------------------------------
-- Baseline role grants
--
-- This is the documented starting point, not a final answer: the real
-- approval chain is still outstanding (PLAN.md §16 question 4). Changing it
-- means editing these rows, never a migration.
-- -------------------------------------------------------------------------

-- admin: everything
insert into role_permissions (role, permission_key)
select 'admin', key from permissions;

-- warehouse_manager: everything operational except QC status and user admin
insert into role_permissions (role, permission_key)
select 'warehouse_manager', key from permissions
where key not in ('user.manage', 'lot.set_qc_status', 'lot.dispose_unpassed');

-- warehouse_staff: create and post approved work; no approvals, no QC
insert into role_permissions (role, permission_key)
select 'warehouse_staff', key from permissions
where key in (
  'master_data.read', 'report.read',
  'goods_receipt.create', 'goods_receipt.post',
  'requisition.create',
  'issue.create', 'issue.post',
  'transfer.create', 'transfer.post',
  'delivery_note.create', 'delivery_note.post',
  'consignment_settlement.create',
  'adjustment.create',
  'cycle_count.create',
  'alert.acknowledge'
);

-- qc: lot status, and disposal of stock that never passed (D-14).
--
-- adjustment.post is included deliberately: qc is the only role holding
-- lot.dispose_unpassed, so without the ability to post its own write-off, a
-- failed lot could be raised for scrapping but never actually scrapped --
-- exactly the trap D-14 exists to avoid. Approval stays with a manager, so
-- the two-person check on a write-off is preserved.
insert into role_permissions (role, permission_key)
select 'qc', key from permissions
where key in (
  'master_data.read', 'report.read',
  'lot.set_qc_status', 'lot.dispose_unpassed',
  'adjustment.create', 'adjustment.post',
  'alert.acknowledge'
);

-- viewer: read-only. Accounting and management.
insert into role_permissions (role, permission_key)
select 'viewer', key from permissions
where key in ('master_data.read', 'report.read');
