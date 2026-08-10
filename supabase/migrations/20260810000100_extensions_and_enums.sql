-- =========================================================================
-- 0001 · Extensions, enums, and time helpers
--
-- Every migration in this project is written to run against an EMPTY
-- database. `supabase db reset` is the acceptance test. Nothing here may
-- depend on data or objects created outside the migration sequence.
-- =========================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()
create extension if not exists pg_trgm;   -- fuzzy product/partner search

-- -------------------------------------------------------------------------
-- Time
--
-- All timestamps are stored as timestamptz (i.e. UTC on disk). We never rely
-- on a session or database timezone setting to get Bangkok-local behaviour,
-- because a cron job, an Edge Function and a developer's psql session can all
-- have different settings. Where a *local calendar date* is needed -- document
-- dates, expiry comparisons, "today's receipts" -- these helpers make the
-- conversion explicit at the call site.
-- -------------------------------------------------------------------------

create or replace function bkk_now() returns timestamptz
  language sql stable parallel safe
  set search_path = ''
as $$ select now() $$;

create or replace function bkk_today() returns date
  language sql stable parallel safe
  set search_path = ''
as $$ select (now() at time zone 'Asia/Bangkok')::date $$;

comment on function bkk_today() is
  'Current calendar date in Asia/Bangkok, independent of session TimeZone.';

-- -------------------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------------------

create type user_role as enum (
  'admin',
  'warehouse_manager',
  'warehouse_staff',
  'qc',
  'viewer'
);

-- Location types drive two things: the default for counts_as_available, and
-- the consumption-source guard for untracked products (see 0009, post_document).
create type location_type as enum (
  'receiving',
  'qc_hold',
  'storage',
  'picking',
  'staging',
  'shipping',
  'in_transit',            -- virtual; holds stock between transfer legs (D-05)
  'consignment_site',      -- physically at a customer; linked to a partner
  'quarantine',
  'scrap',
  'opening'                -- virtual; source of go-live opening balances (D-05)
);

create type tracking_mode as enum ('none', 'lot', 'serial');

create type qc_status as enum ('pending_qc', 'passed', 'failed', 'quarantined');

create type serial_status as enum ('in_stock', 'issued', 'shipped', 'scrapped');

create type barcode_type as enum ('internal', 'supplier', 'case', 'other');

create type partner_type as enum ('supplier', 'customer', 'both');

create type document_type as enum (
  'goods_receipt',
  'requisition',
  'issue',
  'transfer',
  'delivery_note',
  'consignment_settlement',
  'adjustment',
  'cycle_count'
);

-- 'dispatched' exists only for transfers: the point between the two legs where
-- stock is real but sitting in in_transit (D-05).
create type document_status as enum (
  'draft',
  'submitted',
  'approved',
  'dispatched',
  'posted',
  'cancelled'
);

create type adjustment_direction as enum ('increase', 'decrease', 'both');

create type cycle_count_mode as enum ('blind', 'informed');

create type audit_action as enum (
  'insert',
  'update',
  'delete',
  'submit',
  'approve',
  'post',
  'cancel',
  'override'
);

create type alert_type as enum (
  'low_stock',
  'near_expiry',
  'expired',
  'slow_moving',
  'negative_stock',
  'qc_pending_too_long'
);

create type alert_severity as enum ('info', 'warning', 'critical');

create type alert_status as enum ('open', 'acked', 'resolved');

-- 'warehouse' is present because AccCloud's getProductRemain returns whCode
-- and reconciliation must map it, even while we run a single warehouse (D-18).
create type erp_entity_type as enum (
  'product',
  'partner',
  'uom',
  'category',
  'warehouse'
);

create type erp_import_status as enum ('uploaded', 'validated', 'committed', 'failed');

create type erp_row_action as enum ('create', 'update', 'skip', 'error');
