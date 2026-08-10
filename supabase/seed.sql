-- =========================================================================
-- Onest WMS — demo seed
--
-- Runs automatically after `supabase db reset` on the LOCAL stack. It is not
-- applied by `supabase db push`, so the hosted project stays empty unless the
-- seed is run against it deliberately.
--
-- Opening balances are posted as real movements from the virtual OPENING bin
-- (D-05), so the seeded system already demonstrates a clean audit trail from
-- its very first row rather than starting from an unexplained number.
--
-- Demo login for every seeded user: onest1234
-- =========================================================================

-- `extensions` is on the path because Supabase installs pgcrypto there, and
-- the demo user passwords are hashed with crypt()/gen_salt().
set search_path = public, extensions;

do $$
begin
  if exists (select 1 from warehouses) then
    raise notice 'seed skipped: warehouses already exist';
    return;
  end if;

  -- =====================================================================
  -- Warehouse, zones, bins
  -- =====================================================================

  insert into warehouses (id, code, name_th, name_en, address_th, phone, is_default)
  values (
    '11111111-1111-1111-1111-111111111111',
    'WH01', 'คลังสินค้าหลัก', 'Main Warehouse',
    '88/9 นิคมอุตสาหกรรม ถ.บางนา-ตราด กม.23 อ.บางเสาธง จ.สมุทรปราการ 10570',
    '02-123-4567', true
  );

  insert into zones (warehouse_id, code, name_th, name_en) values
    ('11111111-1111-1111-1111-111111111111', 'RECV', 'พื้นที่รับสินค้า',      'Receiving'),
    ('11111111-1111-1111-1111-111111111111', 'RM',   'โซนวัตถุดิบ',           'Raw Materials'),
    ('11111111-1111-1111-1111-111111111111', 'FG',   'โซนสินค้าสำเร็จรูป',     'Finished Goods'),
    ('11111111-1111-1111-1111-111111111111', 'SHIP', 'พื้นที่จัดส่ง',          'Staging & Shipping');
end
$$;

-- Rack bins: RM zone A-01-01..A-04-03, FG zone B-01-01..B-04-03 (24 bins)
insert into locations (warehouse_id, zone_id, code, barcode, type)
select
  w.id, z.id,
  format('%s-%s-%s', prefix, lpad(bay::text, 2, '0'), lpad(level::text, 2, '0')),
  format('%s-%s-%s', prefix, lpad(bay::text, 2, '0'), lpad(level::text, 2, '0')),
  'storage'
from warehouses w
cross join (values ('RM', 'A'), ('FG', 'B')) as t(zone_code, prefix)
join zones z on z.warehouse_id = w.id and z.code = t.zone_code
cross join generate_series(1, 4) as bay
cross join generate_series(1, 3) as level;

-- Operational and virtual locations
-- The VALUES list has to be joined before `zones`, because the zone lookup
-- references v.zone_code.
insert into locations (warehouse_id, zone_id, code, barcode, type)
select w.id, z.id, v.code, v.code, v.type::location_type
from warehouses w
cross join (values
  ('RECV-01',   'receiving',  'RECV'),
  ('RECV-02',   'receiving',  'RECV'),
  ('QC-HOLD-01','qc_hold',    'RECV'),
  ('PICK-RM-01','picking',    'RM'),
  ('PICK-RM-02','picking',    'RM'),
  ('PICK-FG-01','picking',    'FG'),
  ('PICK-FG-02','picking',    'FG'),
  ('STAGE-01',  'staging',    'SHIP'),
  ('STAGE-02',  'staging',    'SHIP'),
  ('SHIP-01',   'shipping',   'SHIP'),
  ('QUAR-01',   'quarantine', 'RECV'),
  ('SCRAP-01',  'scrap',      'RECV')
) as v(code, type, zone_code)
left join zones z on z.warehouse_id = w.id and z.code = v.zone_code;

-- Virtual bins have no zone: they are never physically visited.
insert into locations (warehouse_id, zone_id, code, barcode, type)
select w.id, null, v.code, v.code, v.type::location_type
from warehouses w
cross join (values
  ('IN-TRANSIT-WH01', 'in_transit'),
  ('OPENING-WH01',    'opening')
) as v(code, type);

-- =====================================================================
-- Units, categories, departments
-- =====================================================================

insert into uoms (code, name_th, name_en, decimal_places) values
  ('PCS',  'ชิ้น',      'Pieces',    0),
  ('KG',   'กิโลกรัม',  'Kilogram',  3),
  ('L',    'ลิตร',      'Litre',     3),
  ('DRUM', 'ถัง',       'Drum',      2),
  ('BAG',  'ถุง',       'Bag',       0),
  ('BOX',  'กล่อง',     'Box',       0),
  ('ROLL', 'ม้วน',      'Roll',      0),
  ('SET',  'ชุด',       'Set',       0);

insert into product_categories (code, name_th, name_en) values
  ('RM-SOLV', 'วัตถุดิบ - ตัวทำละลาย',  'Raw Material - Solvents'),
  ('RM-RESIN','วัตถุดิบ - เรซิน',        'Raw Material - Resins'),
  ('RM-ADD',  'วัตถุดิบ - สารเติมแต่ง',   'Raw Material - Additives'),
  ('PKG',     'บรรจุภัณฑ์',              'Packaging'),
  ('FG',      'สินค้าสำเร็จรูป',          'Finished Goods'),
  ('SPARE',   'อะไหล่',                  'Spare Parts'),
  ('EQUIP',   'เครื่องมือและอุปกรณ์',      'Equipment');

insert into departments (code, name_th, name_en) values
  ('PROD',   'ฝ่ายผลิต',        'Production'),
  ('QCQA',   'ฝ่ายควบคุมคุณภาพ', 'QC / QA'),
  ('WH',     'ฝ่ายคลังสินค้า',   'Warehouse'),
  ('RETAIL', 'ฝ่ายค้าปลีก',      'Retail'),
  ('PROC',   'ฝ่ายจัดซื้อ',      'Procurement'),
  ('ACCT',   'ฝ่ายบัญชี',        'Accounting'),
  ('MKT',    'ฝ่ายการตลาด',      'Marketing');

-- =====================================================================
-- Partners
-- =====================================================================

insert into partners (code, type, name_th, name_en, phone, acccloud_partner_code) values
  ('SUP-001', 'supplier', 'บริษัท ไทยเคมิคอล ซัพพลาย จำกัด',  'Thai Chemical Supply Co., Ltd.', '02-555-0101', 'V0001'),
  ('SUP-002', 'supplier', 'บริษัท สยามเรซิน อินดัสทรี จำกัด',  'Siam Resin Industry Co., Ltd.',  '02-555-0102', 'V0002'),
  ('SUP-003', 'supplier', 'บริษัท เอเชีย แพ็คเกจจิ้ง จำกัด',    'Asia Packaging Co., Ltd.',       '02-555-0103', 'V0003'),
  ('SUP-004', 'supplier', 'ห้างหุ้นส่วนจำกัด บางกอกโซลเวนท์',   'Bangkok Solvent Ltd., Part.',    '02-555-0104', 'V0004'),
  ('SUP-005', 'supplier', 'บริษัท นิปปอน แอดดิทีฟ (ไทย) จำกัด', 'Nippon Additive (Thailand)',     '02-555-0105', 'V0005'),
  ('SUP-006', 'supplier', 'บริษัท พี.เอส. อะไหล่อุตสาหกรรม จำกัด','P.S. Industrial Parts Co., Ltd.','02-555-0106', 'V0006'),
  ('CUS-001', 'customer', 'บริษัท รุ่งเรืองการช่าง จำกัด',      'Rung Rueang Engineering',        '02-666-0201', 'C0001'),
  ('CUS-002', 'customer', 'บริษัท ไทยออโต้พาร์ท จำกัด',        'Thai Auto Parts Co., Ltd.',      '02-666-0202', 'C0002'),
  ('CUS-003', 'customer', 'บริษัท เอส.เค. อุตสาหกรรม จำกัด',   'S.K. Industry Co., Ltd.',        '02-666-0203', 'C0003'),
  ('CUS-004', 'customer', 'บริษัท โปรเทค โคทติ้ง จำกัด',       'Protech Coating Co., Ltd.',      '02-666-0204', 'C0004'),
  ('CUS-005', 'customer', 'ร้านค้าปลีก ออนเนสท์ สาขาบางนา',    'Onest Retail - Bangna',          '02-666-0205', 'C0005'),
  ('CUS-006', 'customer', 'บริษัท เมทัลเวิร์ค เอเชีย จำกัด',    'Metalwork Asia Co., Ltd.',       '02-666-0206', 'C0006'),
  ('CUS-007', 'customer', 'บริษัท ยูนิตี้ พลาสติก จำกัด',       'Unity Plastic Co., Ltd.',        '02-666-0207', 'C0007'),
  ('CUS-008', 'customer', 'บริษัท ไทยเพ้นท์ เซ็นเตอร์ จำกัด',   'Thai Paint Center Co., Ltd.',    '02-666-0208', 'C0008');

-- Consignment sites: our stock, physically at a customer. One location each.
insert into locations (warehouse_id, zone_id, code, barcode, type, partner_id)
select w.id, null, v.code, v.code, 'consignment_site', p.id
from warehouses w
cross join (values
  ('CONS-CUS001', 'CUS-001'),
  ('CONS-CUS002', 'CUS-002')
) as v(code, partner_code)
join partners p on p.code = v.partner_code;

-- =====================================================================
-- Products (50)
-- =====================================================================

insert into products
  (sku, name_th, name_en, category_id, base_uom_id, tracking_mode,
   shelf_life_days, requires_qc, is_consignment_eligible,
   acccloud_item_code, acccloud_master_id)
select
  p.sku, p.name_th, p.name_en,
  c.id, u.id, p.tracking::tracking_mode,
  p.shelf_life, p.requires_qc, p.consign,
  p.sku, p.master_id
from (values
  -- Solvents: lot-tracked drums, QC on receipt, one-year shelf life
  ('RM-SOLV-001','โทลูอีน เกรดอุตสาหกรรม',      'Toluene, industrial grade',     'RM-SOLV','KG','lot',365,true,false,10001),
  ('RM-SOLV-002','ไซลีน เกรดอุตสาหกรรม',        'Xylene, industrial grade',      'RM-SOLV','KG','lot',365,true,false,10002),
  ('RM-SOLV-003','อะซิโตน 99.5%',              'Acetone 99.5%',                 'RM-SOLV','KG','lot',540,true,false,10003),
  ('RM-SOLV-004','เมทิลเอทิลคีโตน (MEK)',       'Methyl Ethyl Ketone',           'RM-SOLV','KG','lot',365,true,false,10004),
  ('RM-SOLV-005','ไอโซโพรพิลแอลกอฮอล์ (IPA)',   'Isopropyl Alcohol',             'RM-SOLV','KG','lot',730,true,false,10005),
  ('RM-SOLV-006','บิวทิลอะซิเตท',               'Butyl Acetate',                 'RM-SOLV','KG','lot',365,true,false,10006),
  ('RM-SOLV-007','เอทิลอะซิเตท',                'Ethyl Acetate',                 'RM-SOLV','KG','lot',365,true,false,10007),
  ('RM-SOLV-008','ไวท์สปิริต',                  'White Spirit',                  'RM-SOLV','KG','lot',730,true,false,10008),
  -- Resins
  ('RM-RES-001','อัลคีดเรซิน AK-60',            'Alkyd Resin AK-60',             'RM-RESIN','KG','lot',180,true,false,10011),
  ('RM-RES-002','อะคริลิกเรซิน AC-200',         'Acrylic Resin AC-200',          'RM-RESIN','KG','lot',180,true,false,10012),
  ('RM-RES-003','อีพ็อกซี่เรซิน EP-828',        'Epoxy Resin EP-828',            'RM-RESIN','KG','lot',365,true,false,10013),
  ('RM-RES-004','โพลียูรีเทนเรซิน PU-100',      'Polyurethane Resin PU-100',     'RM-RESIN','KG','lot',180,true,false,10014),
  ('RM-RES-005','ฮาร์ดเดนเนอร์ H-25',           'Hardener H-25',                 'RM-RESIN','KG','lot',270,true,false,10015),
  -- Additives and pigments
  ('RM-ADD-001','ไทเทเนียมไดออกไซด์ (TiO2)',    'Titanium Dioxide',              'RM-ADD','KG','lot',730,true,false,10021),
  ('RM-ADD-002','แคลเซียมคาร์บอเนต',            'Calcium Carbonate',             'RM-ADD','KG','lot',730,false,false,10022),
  ('RM-ADD-003','ผงสีแดงออกไซด์',               'Red Oxide Pigment',             'RM-ADD','KG','lot',730,false,false,10023),
  ('RM-ADD-004','ผงสีเหลืองโครม',               'Chrome Yellow Pigment',         'RM-ADD','KG','lot',730,true,false,10024),
  ('RM-ADD-005','สารกันเชื้อรา BIT-20',          'Anti-fungal Agent BIT-20',      'RM-ADD','KG','lot',365,true,false,10025),
  ('RM-ADD-006','สารลดฟอง DF-10',               'Defoamer DF-10',                'RM-ADD','KG','lot',365,false,false,10026),
  ('RM-ADD-007','สารเพิ่มความข้น TH-50',        'Thickener TH-50',               'RM-ADD','KG','lot',365,false,false,10027),
  -- Packaging: untracked
  ('PKG-001','ถังเหล็ก 20 ลิตร พร้อมฝา',        'Steel Pail 20L with lid',       'PKG','PCS','none',null,false,false,20001),
  ('PKG-002','ถังเหล็ก 5 ลิตร พร้อมฝา',         'Steel Pail 5L with lid',        'PKG','PCS','none',null,false,false,20002),
  ('PKG-003','กระป๋อง 1 ลิตร',                  'Tin Can 1L',                    'PKG','PCS','none',null,false,false,20003),
  ('PKG-004','ถังพลาสติก 200 ลิตร',             'Plastic Drum 200L',             'PKG','PCS','none',null,false,false,20004),
  ('PKG-005','กล่องกระดาษลูกฟูก A',             'Corrugated Box, size A',        'PKG','PCS','none',null,false,false,20005),
  ('PKG-006','เทปพันสาย OPP ใส',                'OPP Clear Tape',                'PKG','ROLL','none',null,false,false,20006),
  ('PKG-007','ฟิล์มยืดพันพาเลท',                'Pallet Stretch Film',           'PKG','ROLL','none',null,false,false,20007),
  ('PKG-008','ฉลากสินค้า 100x50 มม.',           'Product Label 100x50mm',        'PKG','ROLL','none',null,false,false,20008),
  -- Finished goods, several consignment-eligible
  ('FG-001','สีรองพื้นกันสนิม สีแดง 20L',        'Anti-rust Primer, Red 20L',     'FG','PCS','none',730,false,true,30001),
  ('FG-002','สีรองพื้นกันสนิม สีเทา 20L',        'Anti-rust Primer, Grey 20L',    'FG','PCS','none',730,false,true,30002),
  ('FG-003','สีน้ำมันเคลือบเงา สีขาว 5L',        'Gloss Enamel, White 5L',        'FG','PCS','none',730,false,true,30003),
  ('FG-004','สีน้ำมันเคลือบเงา สีดำ 5L',         'Gloss Enamel, Black 5L',        'FG','PCS','none',730,false,true,30004),
  ('FG-005','สีน้ำมันเคลือบเงา สีน้ำเงิน 5L',    'Gloss Enamel, Blue 5L',         'FG','PCS','none',730,false,true,30005),
  ('FG-006','สีอีพ็อกซี่ 2 ส่วน ชุด 4L',         'Epoxy Paint 2-part, 4L set',    'FG','SET','none',365,false,true,30006),
  ('FG-007','สีโพลียูรีเทน ใส 4L',              'Polyurethane Clear 4L',         'FG','PCS','none',365,false,true,30007),
  ('FG-008','ทินเนอร์ผสมสี เบอร์ 21 20L',        'Paint Thinner No.21, 20L',      'FG','PCS','none',730,false,false,30008),
  ('FG-009','ทินเนอร์ล้างอุปกรณ์ 20L',           'Equipment Cleaning Thinner 20L','FG','PCS','none',730,false,false,30009),
  ('FG-010','สีสเปรย์อเนกประสงค์ สีเงิน',        'Aerosol Spray, Silver',         'FG','PCS','none',365,false,true,30010),
  ('FG-011','สีสเปรย์อเนกประสงค์ สีดำด้าน',      'Aerosol Spray, Matt Black',     'FG','PCS','none',365,false,true,30011),
  ('FG-012','น้ำยาเคลือบผิวโลหะ 1L',            'Metal Surface Coating 1L',      'FG','PCS','none',540,false,false,30012),
  ('FG-013','สีทาถนน สีเหลือง 20L',             'Road Marking Paint, Yellow 20L','FG','PCS','none',540,false,false,30013),
  ('FG-014','สีทาถนน สีขาว 20L',                'Road Marking Paint, White 20L', 'FG','PCS','none',540,false,false,30014),
  ('FG-015','น้ำยารองพื้นปูน 20L',              'Masonry Primer 20L',            'FG','PCS','none',730,false,false,30015),
  -- Spare parts
  ('SP-001','ปะเก็นยาง NBR 50 มม.',            'NBR Gasket 50mm',               'SPARE','PCS','none',null,false,false,40001),
  ('SP-002','ตลับลูกปืน 6205',                 'Bearing 6205',                  'SPARE','PCS','none',null,false,false,40002),
  ('SP-003','สายพาน A-45',                     'V-Belt A-45',                   'SPARE','PCS','none',null,false,false,40003),
  ('SP-004','ไส้กรองอากาศ AF-120',             'Air Filter AF-120',             'SPARE','PCS','none',null,false,false,40004),
  ('SP-005','วาล์วลูกลอย 1 นิ้ว',               'Ball Valve 1 inch',             'SPARE','PCS','none',null,false,false,40005),
  -- Serialised equipment
  ('EQ-001','ปั๊มจ่ายสารเคมี DP-500',           'Chemical Dosing Pump DP-500',   'EQUIP','PCS','serial',null,false,false,50001),
  ('EQ-002','เครื่องผสมสีอัตโนมัติ MX-200',     'Automatic Paint Mixer MX-200',  'EQUIP','PCS','serial',null,false,false,50002)
) as p(sku, name_th, name_en, cat, uom, tracking, shelf_life, requires_qc, consign, master_id)
join product_categories c on c.code = p.cat
join uoms u on u.code = p.uom;

-- Internal barcodes: one primary per product, in its base unit.
insert into product_barcodes (product_id, barcode, uom_id, type, is_primary)
select id, '885' || lpad((row_number() over (order by sku))::text, 10, '0'), base_uom_id, 'internal', true
from products;

-- Case barcodes for the finished goods that ship by the box.
insert into product_barcodes (product_id, barcode, uom_id, type, is_primary)
select p.id, '886' || lpad((row_number() over (order by p.sku))::text, 10, '0'), u.id, 'case', false
from products p
join uoms u on u.code = 'BOX'
where p.sku like 'FG-%';

-- Drum conversions: per product, because litres-to-kilos is density (D-10).
insert into product_uom_conversions (product_id, from_uom_id, to_uom_id, factor)
select p.id, d.id, k.id, v.kg_per_drum
from (values
  ('RM-SOLV-001', 180.0), ('RM-SOLV-002', 180.0), ('RM-SOLV-003', 160.0),
  ('RM-SOLV-004', 162.0), ('RM-SOLV-005', 157.0), ('RM-SOLV-006', 176.0),
  ('RM-SOLV-007', 180.0), ('RM-SOLV-008', 154.0),
  ('RM-RES-001',  200.0), ('RM-RES-002', 200.0), ('RM-RES-003', 220.0),
  ('RM-RES-004',  195.0), ('RM-RES-005', 190.0)
) as v(sku, kg_per_drum)
join products p on p.sku = v.sku
join uoms d on d.code = 'DRUM'
join uoms k on k.code = 'KG';

-- 25 kg bags for the powder additives.
insert into product_uom_conversions (product_id, from_uom_id, to_uom_id, factor)
select p.id, b.id, k.id, 25.0
from products p
join uoms b on b.code = 'BAG'
join uoms k on k.code = 'KG'
where p.sku in ('RM-ADD-001','RM-ADD-002','RM-ADD-003','RM-ADD-004');

-- Min/max levels
insert into product_stock_rules (product_id, warehouse_id, min_qty, max_qty, reorder_qty)
select p.id, w.id,
       case when p.sku like 'RM-%' then 500 when p.sku like 'FG-%' then 50 else 20 end,
       case when p.sku like 'RM-%' then 5000 when p.sku like 'FG-%' then 600 else 300 end,
       case when p.sku like 'RM-%' then 1000 when p.sku like 'FG-%' then 200 else 100 end
from products p cross join warehouses w;

-- =====================================================================
-- Adjustment reasons
-- =====================================================================

insert into adjustment_reasons (code, name_th, name_en, direction, is_disposal) values
  ('DAMAGE',    'สินค้าเสียหาย',        'Damaged goods',        'decrease', true),
  ('SPILL',     'หกหล่น/รั่วไหล',       'Spillage',             'decrease', true),
  ('EVAP',      'ระเหย/สูญเสียตามธรรมชาติ','Evaporation loss',   'decrease', true),
  ('EXPIRED',   'หมดอายุ - ตัดจำหน่าย',  'Expired write-off',    'decrease', true),
  ('SCRAP',     'ทำลายทิ้ง',            'Scrapped',             'decrease', true),
  ('RETURN_SUP','คืนผู้ขาย',            'Return to supplier',   'decrease', true),
  ('COUNT_VAR', 'ผลต่างจากการตรวจนับ',   'Cycle count variance', 'both',     false),
  ('SAMPLE',    'เบิกตัวอย่างทดสอบ',     'Sample for testing',   'decrease', false),
  ('FOUND',     'พบสินค้าเพิ่ม',         'Found stock',          'increase', false),
  ('SYS_CORR',  'ปรับปรุงตามระบบ',       'System correction',    'both',     false),
  ('OPENING',   'ยอดยกมา ณ วันเริ่มระบบ', 'Opening balance',      'increase', false);

-- =====================================================================
-- Users
--
-- Password for every demo account: onest1234
-- =====================================================================

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at
)
select
  gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', u.email,
  crypt('onest1234', gen_salt('bf')),
  now(), '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', u.full_name),
  now(), now()
from (values
  ('admin@onest.co.th',    'สมชาย ผู้ดูแลระบบ'),
  ('manager@onest.co.th',  'วิชัย หัวหน้าคลัง'),
  ('staff1@onest.co.th',   'ประเสริฐ พนักงานคลัง'),
  ('staff2@onest.co.th',   'มานะ พนักงานคลัง'),
  ('staff3@onest.co.th',   'สุนีย์ พนักงานคลัง'),
  ('qc@onest.co.th',       'อรทัย ควบคุมคุณภาพ'),
  ('qc2@onest.co.th',      'ธนพล ควบคุมคุณภาพ'),
  ('viewer@onest.co.th',   'จันทร์เพ็ญ ฝ่ายบัญชี')
) as u(email, full_name);

insert into user_profiles (id, full_name, role, warehouse_id, locale, is_active)
select
  au.id,
  au.raw_user_meta_data ->> 'full_name',
  r.role::user_role,
  (select id from warehouses where is_default),
  'th', true
from auth.users au
join (values
  ('admin@onest.co.th',   'admin'),
  ('manager@onest.co.th', 'warehouse_manager'),
  ('staff1@onest.co.th',  'warehouse_staff'),
  ('staff2@onest.co.th',  'warehouse_staff'),
  ('staff3@onest.co.th',  'warehouse_staff'),
  ('qc@onest.co.th',      'qc'),
  ('qc2@onest.co.th',     'qc'),
  ('viewer@onest.co.th',  'viewer')
) as r(email, role) on r.email = au.email;

-- =====================================================================
-- Lots
-- =====================================================================

insert into lots (product_id, lot_no, supplier_lot_no, mfg_date, expiry_date, qc_status, qc_by, qc_at)
select
  p.id,
  -- date minus integer stays a date; date minus interval would become a
  -- timestamp and then refuse to add the shelf life.
  format('L%s-%s', to_char(bkk_today() - v.age_days, 'YYMM'), lpad(v.seq::text, 3, '0')),
  format('SUP-%s', lpad(v.seq::text, 5, '0')),
  bkk_today() - v.age_days,
  bkk_today() - v.age_days + coalesce(p.shelf_life_days, 365),
  v.qc::qc_status,
  case when v.qc = 'pending_qc' then null
       else (select id from user_profiles where full_name like 'อรทัย%') end,
  case when v.qc = 'pending_qc' then null else now() end
from (values
  ('RM-SOLV-001', 1, 40,  'passed'),
  ('RM-SOLV-001', 2, 10,  'passed'),
  ('RM-SOLV-002', 3, 35,  'passed'),
  ('RM-SOLV-003', 4, 25,  'passed'),
  ('RM-SOLV-004', 5, 20,  'passed'),
  ('RM-SOLV-005', 6, 15,  'passed'),
  ('RM-SOLV-006', 7, 3,   'pending_qc'),
  ('RM-SOLV-007', 8, 2,   'pending_qc'),
  ('RM-SOLV-008', 9, 340, 'passed'),
  ('RM-RES-001', 10, 150, 'passed'),
  ('RM-RES-002', 11, 30,  'passed'),
  ('RM-RES-003', 12, 60,  'passed'),
  ('RM-RES-004', 13, 165, 'passed'),
  ('RM-RES-005', 14, 5,   'failed'),
  ('RM-ADD-001', 15, 90,  'passed'),
  ('RM-ADD-002', 16, 120, 'passed'),
  ('RM-ADD-003', 17, 200, 'passed'),
  ('RM-ADD-004', 18, 1,   'pending_qc'),
  ('RM-ADD-005', 19, 300, 'passed'),
  ('RM-ADD-006', 20, 45,  'passed'),
  ('RM-ADD-007', 21, 50,  'passed')
) as v(sku, seq, age_days, qc)
join products p on p.sku = v.sku;

-- Serial numbers for the two serialised products.
insert into serials (product_id, serial_no, status)
select p.id, format('%s-SN%s', p.sku, lpad(n::text, 4, '0')), 'in_stock'
from products p
cross join generate_series(1, 6) as n
where p.tracking_mode = 'serial';

-- =====================================================================
-- Opening balances
--
-- Posted as a real goods receipt sourcing from the virtual OPENING bin, so
-- go-live stock arrives through exactly the same audited path as every later
-- receipt. OPENING ends up holding the negative of everything that existed
-- before the system did -- see D-05 and D-21.
-- =====================================================================

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', (select up.id from user_profiles up
            join auth.users au on au.id = up.id
            where au.email = 'admin@onest.co.th'),
    'role', 'authenticated'
  )::text,
  false
);

do $$
declare
  v_wh      uuid := (select id from warehouses where is_default);
  v_admin   uuid := (select up.id from user_profiles up
                     join auth.users au on au.id = up.id
                     where au.email = 'admin@onest.co.th');
  v_opening uuid := (select id from locations where code = 'OPENING-WH01');
  v_gr      uuid;
  v_line    integer := 0;
  r         record;
begin
  insert into goods_receipts (warehouse_id, status, created_by, notes)
  values (v_wh, 'approved', v_admin, 'ยอดยกมา ณ วันเริ่มใช้ระบบ / Opening balance at go-live')
  returning id into v_gr;

  -- Lot-tracked raw materials land in their RM storage bins, spread across
  -- the 12 A-bins in round-robin. The row number has to be computed in a
  -- subquery first: a window function cannot appear in a WHERE clause.
  for r in
    with numbered as (
      select l.id as lot_id, l.product_id, p.base_uom_id, l.qc_status,
             row_number() over (order by p.sku, l.lot_no) - 1 as rn
      from lots l
      join products p on p.id = l.product_id
    )
    select n.lot_id, n.product_id, n.base_uom_id,
           loc.id as bin,
           case when n.qc_status = 'passed' then 1 else 0 end as is_passed,
           round((random() * 800 + 200)::numeric, 2) as qty
    from numbered n
    left join locations loc
      on loc.code = format('A-%s-%s',
           lpad((1 + (n.rn / 3) % 4)::text, 2, '0'),
           lpad((1 + n.rn % 3)::text, 2, '0'))
    order by n.rn
  loop
    v_line := v_line + 1;
    insert into goods_receipt_lines
      (header_id, line_no, product_id, lot_id, qty, uom_id, from_location_id, to_location_id)
    values (
      v_gr, v_line, r.product_id, r.lot_id, r.qty, r.base_uom_id, v_opening,
      -- Anything not yet cleared by QC starts in the QC hold bin, exactly as
      -- it would if it had just been unloaded off a lorry.
      case when r.is_passed = 1
           then coalesce(r.bin, (select id from locations where code = 'A-01-01'))
           else (select id from locations where code = 'QC-HOLD-01') end
    );
  end loop;

  -- Untracked finished goods, packaging and spares into FG bins.
  for r in
    with numbered as (
      select p.id as product_id, p.base_uom_id, p.sku,
             row_number() over (order by p.sku) - 1 as rn
      from products p
      where p.tracking_mode = 'none'
    )
    select n.product_id, n.base_uom_id,
           loc.id as bin,
           (floor(random() * 300) + 40)::numeric as qty
    from numbered n
    left join locations loc
      on loc.code = format('B-%s-%s',
           lpad((1 + (n.rn / 3) % 4)::text, 2, '0'),
           lpad((1 + n.rn % 3)::text, 2, '0'))
    order by n.rn
  loop
    v_line := v_line + 1;
    insert into goods_receipt_lines
      (header_id, line_no, product_id, qty, uom_id, from_location_id, to_location_id)
    values (v_gr, v_line, r.product_id, r.qty, r.base_uom_id, v_opening,
            coalesce(r.bin, (select id from locations where code = 'B-01-01')));
  end loop;

  -- Serialised equipment, one line per unit.
  for r in
    select s.id as serial_id, s.product_id, p.base_uom_id
    from serials s join products p on p.id = s.product_id
    order by s.serial_no
  loop
    v_line := v_line + 1;
    insert into goods_receipt_lines
      (header_id, line_no, product_id, serial_id, qty, uom_id, from_location_id, to_location_id)
    values (v_gr, v_line, r.product_id, r.serial_id, 1, r.base_uom_id, v_opening,
            (select id from locations where code = 'B-04-03'));
  end loop;

  perform post_document('goods_receipt', v_gr);

  raise notice 'opening balance posted: % lines', v_line;
end
$$;

-- =====================================================================
-- A little consignment stock, so the settlement screens have something real
-- =====================================================================

do $$
declare
  v_wh      uuid := (select id from warehouses where is_default);
  v_admin   uuid := (select up.id from user_profiles up
                     join auth.users au on au.id = up.id
                     where au.email = 'admin@onest.co.th');
  v_dn      uuid;
  v_site    record;
  v_stock   record;
  v_line    integer;
begin
  -- One despatch per consignment site, each to that site's own location.
  for v_site in
    select l.id as loc_id, l.partner_id
    from locations l
    where l.type = 'consignment_site'
    order by l.code
  loop
    insert into delivery_notes
      (warehouse_id, partner_id, status, is_consignment, created_by, notes)
    values (v_wh, v_site.partner_id, 'approved', true, v_admin,
            'ส่งสินค้าฝากขาย / Consignment despatch')
    returning id into v_dn;

    v_line := 0;
    for v_stock in
      select soh.product_id, soh.location_id, p.base_uom_id
      from stock_on_hand soh
      join products p on p.id = soh.product_id
      join locations l on l.id = soh.location_id
      where p.is_consignment_eligible
        and soh.qty > 20
        and l.counts_as_available
      order by p.sku
      limit 3
    loop
      v_line := v_line + 1;
      insert into delivery_note_lines
        (header_id, line_no, product_id, qty, uom_id, from_location_id, to_location_id)
      values (v_dn, v_line, v_stock.product_id, 15, v_stock.base_uom_id,
              v_stock.location_id, v_site.loc_id);
    end loop;

    if v_line > 0 then
      perform post_document('delivery_note', v_dn);
    else
      delete from delivery_notes where id = v_dn;
    end if;
  end loop;
end
$$;

select set_config('request.jwt.claims', null, false);

-- =====================================================================
-- Summary
-- =====================================================================

do $$
declare
  v_products integer := (select count(*) from products);
  v_locs     integer := (select count(*) from locations);
  v_lots     integer := (select count(*) from lots);
  v_moves    integer := (select count(*) from stock_movements);
  v_users    integer := (select count(*) from user_profiles);
  v_opening  numeric := (select coalesce(sum(qty), 0) from stock_on_hand
                         where location_id = (select id from locations where code = 'OPENING-WH01'));
begin
  raise notice 'Onest WMS seed complete: % products, % locations, % lots, % users, % movements',
    v_products, v_locs, v_lots, v_users, v_moves;
  raise notice 'OPENING-WH01 balance: % (negative by design -- stock that predates the ledger)', v_opening;
  raise notice 'Demo login: admin@onest.co.th / onest1234';
end
$$;
