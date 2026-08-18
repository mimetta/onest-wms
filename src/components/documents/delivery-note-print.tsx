import type { DocumentLine } from "./document-lines";

/**
 * The printed ใบส่งสินค้า.
 *
 * This sheet leaves the building with the goods and comes back signed, so it is
 * a paper form first and a screen second. Two things follow from that:
 *
 *  - It prints on plain A4 on whatever office printer exists. No label stock,
 *    no driver.
 *  - The signature blocks are BLANK, ruled, and sized for a pen. Same reasoning
 *    as the drum label's QC box (D-37): printing a name that the system happens
 *    to hold would create a second source of truth, and the whole purpose of
 *    this sheet is to capture something the system does NOT yet know — that a
 *    named human at the customer's gate accepted these goods.
 *
 * Sizes are in millimetres rather than points because the rules are writing
 * targets, not type. 7mm clear height keeps the rule below the writing rather
 * than through it, matching the drum label.
 */

export type DeliveryNotePrintData = {
  docNo: string | null;
  docDate: string;
  soReference: string | null;
  isConsignment: boolean;
  partnerName: string;
  partnerCode: string;
  partnerAddress: string | null;
  warehouseName: string;
  notes: string | null;
  lines: DocumentLine[];
};

export function DeliveryNotePrint({ data }: { data: DeliveryNotePrintData }) {
  return (
    <article className="mx-auto w-full max-w-[190mm] bg-white p-[10mm] text-black print:p-0">
      <style>{`
        @page { size: A4 portrait; margin: 12mm; }
      `}</style>

      {/* Header ------------------------------------------------------------ */}
      <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-[4mm]">
        <div className="flex flex-col">
          <h1 className="text-[20pt] leading-none font-bold">ใบส่งสินค้า</h1>
          <p className="text-[9pt] tracking-wide">DELIVERY NOTE</p>
          {data.isConsignment && (
            /* A consignment despatch is not a sale: the stock is still ours
               until it is settled. Saying so on the paper matters, because the
               person receiving it is being asked to hold goods, not buy them. */
            <p className="mt-[2mm] inline-block border border-black px-2 py-0.5 text-[9pt] font-bold">
              ฝากขาย · CONSIGNMENT
            </p>
          )}
        </div>

        <table className="text-[10pt]">
          <tbody>
            <Row label="เลขที่ / No." value={data.docNo ?? "—"} mono />
            <Row label="วันที่ / Date" value={data.docDate} />
            {data.soReference && <Row label="อ้างอิง / Ref." value={data.soReference} />}
            <Row label="คลัง / Warehouse" value={data.warehouseName} />
          </tbody>
        </table>
      </header>

      {/* Consignee -------------------------------------------------------- */}
      <section className="mt-[4mm] flex flex-col gap-1">
        <span className="text-[8pt] tracking-wider">ลูกค้า / CUSTOMER</span>
        <p className="text-[12pt] font-bold">{data.partnerName}</p>
        <p className="text-[9pt]">{data.partnerCode}</p>
        {data.partnerAddress && (
          <p className="max-w-[110mm] text-[9pt] whitespace-pre-line">
            {data.partnerAddress}
          </p>
        )}
      </section>

      {/* Lines ------------------------------------------------------------ */}
      <table className="mt-[5mm] w-full border-collapse text-[9.5pt]">
        <thead>
          <tr className="border-y border-black">
            <th className="w-[10mm] px-1 py-[1.5mm] text-left font-bold">ลำดับ</th>
            <th className="px-1 py-[1.5mm] text-left font-bold">
              รายละเอียดสินค้า / Description
            </th>
            <th className="w-[32mm] px-1 py-[1.5mm] text-left font-bold">ล็อต / Lot</th>
            <th className="w-[24mm] px-1 py-[1.5mm] text-right font-bold">จำนวน</th>
            <th className="w-[16mm] px-1 py-[1.5mm] text-left font-bold">หน่วย</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.id} className="border-b border-neutral-400 align-top">
              <td className="px-1 py-[1.5mm]">{l.lineNo}</td>
              <td className="px-1 py-[1.5mm]">
                <span className="font-mono text-[8.5pt]">{l.sku}</span>
                <br />
                {l.nameTh}
              </td>
              <td className="px-1 py-[1.5mm] font-mono text-[8.5pt]">
                {l.serialNo ?? l.lotNo ?? ""}
              </td>
              <td className="px-1 py-[1.5mm] text-right tabular-nums">
                {l.qty.toLocaleString()}
              </td>
              <td className="px-1 py-[1.5mm]">{l.uomCode}</td>
            </tr>
          ))}

          {/* A short delivery note should still fill the page, so the sheet
              cannot have lines added to it after signing. */}
          {Array.from({ length: Math.max(0, 8 - data.lines.length) }).map((_, i) => (
            <tr key={`blank-${i}`} className="border-b border-neutral-300">
              <td className="px-1 py-[1.5mm]">&nbsp;</td>
              <td />
              <td />
              <td />
              <td />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-black">
            <td colSpan={3} className="px-1 py-[1.5mm] text-right font-bold">
              รวม / Total lines
            </td>
            <td className="px-1 py-[1.5mm] text-right font-bold tabular-nums">
              {data.lines.length}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>

      {data.notes && (
        <p className="mt-[3mm] text-[9pt]">
          <span className="font-bold">หมายเหตุ / Notes: </span>
          {data.notes}
        </p>
      )}

      {/* Signatures ------------------------------------------------------- */}
      <section className="mt-[10mm] grid grid-cols-2 gap-[10mm]">
        <SignatureBlock caption="ผู้ส่งสินค้า" english="Delivered by" />
        <SignatureBlock caption="ผู้รับสินค้า" english="Received by" />
      </section>

      {/* No pricing anywhere on this sheet. It is a warehouse document handled
          by warehouse staff and a customer's storeman; cost and price are
          admin/manager information (owner's constraint, carried through from
          Phase 1). */}
    </article>
  );
}

/**
 * One blank signature block: a ruled line to sign on, then name and date.
 *
 * The same three-part shape as the drum label's QC box — sign, who, when —
 * because it is the same job: a person confirming by hand something the system
 * cannot know on its own.
 */
function SignatureBlock({ caption, english }: { caption: string; english: string }) {
  return (
    <div className="flex flex-col gap-[2mm]">
      <div className="flex flex-col gap-0">
        <span className="text-[11pt] font-bold">{caption}</span>
        <span className="text-[8pt]">{english}</span>
      </div>

      {/* Signing space first: the widest, tallest rule, because a signature is
          bigger than a printed name. */}
      <span aria-hidden className="mt-[6mm] h-[10mm] border-b-[0.4mm] border-black" />

      {[
        { th: "ชื่อ", en: "Name" },
        { th: "วันที่", en: "Date" },
      ].map((row) => (
        <div key={row.th} className="flex items-end gap-2">
          <span className="w-[20mm] shrink-0 text-[9pt]">
            {row.th} / {row.en}
          </span>
          <span
            aria-hidden
            className="h-[7mm] min-w-0 flex-1 border-b-[0.4mm] border-black"
          />
        </div>
      ))}
    </div>
  );
}

function Row({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <tr>
      <td className="pr-3 whitespace-nowrap">{label}</td>
      <td className={mono ? "font-mono font-bold" : "font-bold"}>{value}</td>
    </tr>
  );
}
