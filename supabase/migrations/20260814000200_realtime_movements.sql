-- =========================================================================
-- 0017 · Realtime on the ledger
--
-- The dashboard's activity feed is one half of the compensating control for
-- goods receipts posting without an approver (D-22): a receipt must be visible
-- as it happens, not at month end. That needs the ledger in the realtime
-- publication.
-- =========================================================================

-- Adding a table that is already published raises, and this migration must be
-- re-runnable from zero like every other, so the membership is checked first.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'stock_movements'
  ) then
    alter publication supabase_realtime add table stock_movements;
  end if;
end
$$;

-- Realtime applies RLS to each subscriber, and for that it needs to identify
-- the row. DEFAULT (primary key) is enough here and is the cheap option:
-- stock_movements is append-only, so there are no UPDATE or DELETE events whose
-- old values would need REPLICA IDENTITY FULL, and the table is the highest
-- write-volume object in the system — doubling its WAL for nothing would be a
-- poor trade.
alter table stock_movements replica identity default;

comment on table stock_movements is
  'Append-only stock ledger. On-hand is derived from this table and stored nowhere. Corrections are new reversing rows -- never UPDATE, never DELETE (D-01, D-03). Published to supabase_realtime for the dashboard activity feed (D-22).';
