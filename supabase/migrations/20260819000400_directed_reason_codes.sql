-- =========================================================================
-- 0024 · Adjustment reason codes become schema, and the 'both' codes split
--
-- Decided 19 Aug 2026, after the owner reviewed the 11 production codes.
--
-- TWO changes, and the second was found while making the first.
--
-- 1. Two codes carried direction = 'both': COUNT_VAR and SYS_CORR. The
--    adjustment screen refuses those for lines by design (D-61) — a reason code
--    that has not decided which way stock moves cannot be applied without
--    asking the operator for a sign, which is precisely what that design
--    exists to prevent. Each is split into a directed pair.
--
-- 2. The reason codes lived ONLY in supabase/seed.sql. GO-LIVE.md D1 requires a
--    fresh Supabase project with migrations applied and NO seed — so production
--    would have started life with zero reason codes and an adjustment screen
--    that could not be used at all. Since the owner has confirmed these codes as
--    correct for the business, they are operational master data, not demo data,
--    and they belong in a migration. The seed's copy is removed.
--
-- Idempotent throughout: `on conflict do nothing` and a guarded update, so this
-- is safe on the existing hosted project (which already holds the original 11)
-- and on a fresh one (which holds none).
-- =========================================================================

-- The nine codes confirmed by the owner, verbatim. Kept in business order
-- rather than alphabetical, because that is how somebody thinks about them:
-- losses first, then the deliberate movements, then the corrections.
insert into adjustment_reasons (code, name_th, name_en, direction, is_disposal) values
  ('DAMAGE',     'สินค้าเสียหาย',           'Damaged goods',        'decrease', true),
  ('SPILL',      'หกหล่น/รั่วไหล',          'Spillage',             'decrease', true),
  ('EVAP',       'ระเหย/สูญเสียตามธรรมชาติ',  'Evaporation loss',     'decrease', true),
  ('EXPIRED',    'หมดอายุ - ตัดจำหน่าย',     'Expired write-off',    'decrease', true),
  ('SCRAP',      'ทำลายทิ้ง',               'Scrapped',             'decrease', true),
  ('RETURN_SUP', 'คืนผู้ขาย',               'Return to supplier',   'decrease', true),
  ('SAMPLE',     'เบิกตัวอย่างทดสอบ',        'Sample for testing',   'decrease', false),
  ('FOUND',      'พบสินค้าเพิ่ม',            'Found stock',          'increase', false),
  ('OPENING',    'ยอดยกมา ณ วันเริ่มระบบ',    'Opening balance',      'increase', false)
on conflict (code) do nothing;

-- The directed pairs replacing COUNT_VAR and SYS_CORR.
insert into adjustment_reasons (code, name_th, name_en, direction, is_disposal) values
  ('COUNT_VAR_UP',   'นับได้เกิน',             'Count variance — over',        'increase', false),
  ('COUNT_VAR_DOWN', 'นับได้ขาด',              'Count variance — short',       'decrease', false),
  ('SYS_CORR_UP',    'ปรับปรุงตามระบบ - เพิ่ม',  'System correction — increase', 'increase', false),
  ('SYS_CORR_DOWN',  'ปรับปรุงตามระบบ - ลด',    'System correction — decrease', 'decrease', false)
on conflict (code) do nothing;

-- The originals are DEACTIVATED, not deleted. An adjustment references its
-- reason code, and master data that documents point at is never removed — the
-- history has to keep meaning what it meant. is_active = false takes them out of
-- the picker while leaving any existing reference intact and readable.
update adjustment_reasons set is_active = false
where code in ('COUNT_VAR', 'SYS_CORR');


-- -------------------------------------------------------------------------
-- The is_disposal comment was telling a lie
--
-- It claimed: "This is what the disposal class in post_document() keys off, so
-- the QC exemption follows WHY stock is leaving rather than a hard-coded list of
-- codes (D-14)."
--
-- It does not. classify_movement() derives the class from the movement's
-- ENDPOINTS — stock leaving with no destination is a disposal, whatever the
-- reason code says. Proven by test: a decrease with is_disposal = false is still
-- refused with "lot.dispose_unpassed is required" when the lot has not passed.
--
-- That behaviour is correct and is left exactly as it is. Deriving the class
-- from where stock actually went is far more robust than trusting a boolean
-- somebody can clear on a master-data screen — a reason code flagged
-- is_disposal = false must never become a quiet route for removing unpassed
-- stock.
--
-- But the comment would have led a maintainer to believe the flag controls the
-- gate, and to "fix" a QC refusal by clearing it. Corrected, with the flag's
-- real and smaller job stated.
-- -------------------------------------------------------------------------

comment on column adjustment_reasons.is_disposal is
  'Advisory only — marks reasons that exist to destroy or return stock (write-off, '
  'damage, scrap, return to supplier), for badges and reporting. It does NOT control '
  'the QC gate: classify_movement() derives the disposal class from the movement''s '
  'endpoints, so ANY decrease of a non-passed lot requires lot.dispose_unpassed '
  'regardless of this flag (D-14, D-62).';

comment on column adjustment_reasons.direction is
  'increase | decrease | both. The adjustment screen reads this to decide which '
  'endpoint the quantity hangs off, so the operator never enters a sign (D-61). '
  'A code left as ''both'' cannot be used on a line — split it into a directed pair.';

comment on table adjustment_reasons is
  'Operational master data, owned by this migration rather than the seed: a fresh '
  'production project applies migrations without a seed (GO-LIVE.md D1), and an '
  'adjustment screen with no reason codes cannot be used at all.';
