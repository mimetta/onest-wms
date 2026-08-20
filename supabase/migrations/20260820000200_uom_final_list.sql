-- =========================================================================
-- 0026 · The real UOM list, from the AccCloud export (D-65)
--
-- D-64 moved UOMs into a migration because products.base_uom_id is NOT NULL,
-- but flagged the eight codes as demo carry-over that nobody had reviewed. The
-- export has now been profiled — 731 rows, nine distinct หน่วย values — and the
-- owner has confirmed the final list and its decimal places.
--
-- decimal_places is an accounting decision, not a display preference. KG at 3
-- versus 0 is the difference between accounting for 999 g of solvent and losing
-- it, and GRAM at 1 versus 0 matters for the additives weighed out by hand.
-- =========================================================================

insert into uoms (code, name_th, name_en, decimal_places) values
  ('UNIT', 'หน่วย',        'Unit',       0),
  ('PACK', 'แพ็ค',         'Pack',       0),
  ('GRAM', 'กรัม',         'Gram',       1),
  ('CM',   'เซนติเมตร',    'Centimeter', 1),
  ('SQM',  'ตารางเมตร',    'Square metre', 2)
on conflict (code) do nothing;

-- Confirm the scale on every code in the final list, including the ones that
-- already existed — a carried-over default must not silently outrank the
-- owner's decision.
update uoms set decimal_places = v.dp
from (values
  ('PCS', 0), ('SET', 0), ('UNIT', 0), ('BOX', 0), ('PACK', 0),
  ('GRAM', 1), ('CM', 1), ('SQM', 2), ('KG', 3), ('DRUM', 2)
) as v(code, dp)
where uoms.code = v.code and uoms.decimal_places <> v.dp;

-- Demo carry-overs that the export does not use. Deactivated rather than
-- deleted: products reference base_uom_id, and a UOM a product points at must
-- stay resolvable or the product's quantities stop meaning anything.
--
-- DRUM is deliberately kept ACTIVE despite being absent from the export: raw
-- material arrives in drums and the 200 kg-per-drum conversion (D-10) is how
-- receiving turns one scanned drum into a stock quantity.
update uoms set is_active = false
where code in ('L', 'BAG', 'ROLL');

comment on table uoms is
  'Final list confirmed against the AccCloud export, 20 Aug 2026 (D-65). The '
  'export uses nine units; DRUM is kept for raw material receiving (D-10). '
  'decimal_places is an accounting decision — see D-65 before changing one.';


-- -------------------------------------------------------------------------
-- Product categories carry the AccCloud group code
--
-- The export's รหัสกลุ่มสินค้า is how the business already thinks about its
-- items, and it is the field the importer filters on to decide what is stock at
-- all (SVC services, FA fixed assets, TRANS transport are not). Keeping the
-- group as the category code means the classification survives the import
-- instead of being thrown away after being used once.
--
-- No rows are inserted here: which groups exist is a fact about the file, and
-- the importer creates the categories for the groups the owner ticks as
-- inventory. Inventing all thirteen now would create categories for the ones
-- deliberately excluded.
-- -------------------------------------------------------------------------

comment on column product_categories.code is
  'For imported items this is the AccCloud รหัสกลุ่มสินค้า (PK, GE, FG, 1RM, ...), '
  'so the group filter used at import time stays visible afterwards (D-65).';
