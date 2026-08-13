import { Barcode } from "./barcode";
import type { LabelSize, LabelSpec } from "@/lib/labels/types";

/**
 * The browser-printable LabelRenderer.
 *
 * Labels are laid out on an A4 grid because no label printer has been bought
 * yet, and a sheet of adhesive labels works on any office printer. The `@page`
 * rule and the mm-based sizing mean a future roll printer needs only a
 * different size entry, not different components.
 */
export function LabelSheet({ labels, size }: { labels: LabelSpec[]; size: LabelSize }) {
  return (
    <>
      <style>{`
        @page { size: A4; margin: 0; }
        @media print {
          /* Everything except the sheet disappears: nav, buttons, hints. */
          body > *:not(.label-sheet-root) { display: none !important; }
          .label-sheet-root { position: absolute; inset: 0; }
          .label-cell { break-inside: avoid; page-break-inside: avoid; }
          .label-page { break-after: page; page-break-after: always; }
          .label-page:last-child { break-after: auto; page-break-after: auto; }
        }
      `}</style>

      <div className="label-sheet-root bg-white">
        {chunk(labels, size.columns * size.rows).map((pageLabels, pageIndex) => (
          <div
            key={pageIndex}
            className="label-page grid bg-white"
            style={{
              gridTemplateColumns: `repeat(${size.columns}, ${size.widthMm}mm)`,
              gridAutoRows: `${size.heightMm}mm`,
              width: `${size.columns * size.widthMm}mm`,
            }}
          >
            {pageLabels.map((label, i) => (
              <LabelCell key={`${label.barcode}-${i}`} label={label} size={size} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function LabelCell({ label, size }: { label: LabelSpec; size: LabelSize }) {
  const cellStyle = { width: `${size.widthMm}mm`, height: `${size.heightMm}mm` };
  const frame =
    "label-cell flex flex-col overflow-hidden border border-dashed border-neutral-300 print:border-transparent";

  // The 100x150 drum label is its own template: it is the primary scan target
  // in the warehouse and carries the QC block, so it gets room rather than a
  // squeezed version of the small layout.
  if (size.heightMm >= 140) {
    return (
      <div className={`${frame} justify-between px-4 py-3`} style={cellStyle}>
        <div className="flex flex-col gap-1">
          {label.secondary && (
            <div className="text-[13pt] leading-tight font-bold text-black">
              {label.secondary}
            </div>
          )}
          {label.fields?.map((f) => (
            <div key={f.label} className="flex gap-2 text-[10pt] leading-snug">
              <span className="w-[22mm] shrink-0 text-neutral-600">{f.label}</span>
              <span className="font-medium text-black">{f.value}</span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-0.5">
          <Barcode value={label.barcode} heightMm={22} />
          <div className="text-center font-mono text-[11pt] tracking-tight text-black">
            {label.primary}
          </div>
          {/* Printed in Thai regardless of the operator's UI language: the
              label is read in the warehouse, and an English-speaking admin
              printing a sheet must not produce labels their staff cannot
              read (D-37). */}
          <div className="text-center text-[8pt] text-neutral-600">
            สแกนเพื่อดูข้อมูลล่าสุด
          </div>
        </div>

        {label.qcBox ? (
          /* A blank form completed by pen when QC passes. Nothing about the
             current QC state is printed: a printed status is a second source of
             truth that goes stale the moment QC changes its mind (D-37).

             Sizes are in millimetres rather than points because these are
             writing targets, not type — the box and the rules have to be big
             enough for a gloved hand with a marker pen. */
          <div className="flex flex-col gap-[2mm] border-t-2 border-black pt-[2mm]">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="inline-block h-[10mm] w-[10mm] shrink-0 border-[0.6mm] border-black"
              />
              <span className="text-[13pt] leading-tight font-bold text-black">
                ตรวจ QC แล้ว
              </span>
            </div>

            {/* Ruled lines at 7mm clear height — above the 6mm minimum, so the
                rule sits below the writing rather than through it. */}
            {/* Fixed label width so both rules start at the same x — they are
                a form to write on, and ragged rules read as a mistake. */}
            {["ตรวจโดย", "วันที่"].map((caption) => (
              <div key={caption} className="flex items-end gap-2">
                <span className="w-[18mm] shrink-0 text-[10pt] text-black">
                  {caption}
                </span>
                <span
                  aria-hidden
                  className="h-[7mm] min-w-0 flex-1 border-b-[0.4mm] border-black"
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // Shelf-edge strip: the bin's own label for a product with no barcode of its
  // own. Product name gets the space, because a person reads this to find the
  // right shelf and only then scans.
  if (label.kind === "shelf") {
    return (
      <div className={`${frame} justify-center gap-0.5 px-3 py-1`} style={cellStyle}>
        <div className="truncate text-[11pt] leading-tight font-bold text-black">
          {label.secondary}
        </div>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Barcode value={label.barcode} heightMm={9} />
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-[8pt] leading-tight text-black">
              {label.primary}
            </div>
            {label.details?.[0] && (
              <div className="text-[7pt] leading-tight text-neutral-600">
                {label.details[0].value}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const compact = size.heightMm <= 30;

  return (
    <div className={`${frame} justify-center px-2 py-1`} style={cellStyle}>
      {!compact && label.secondary && (
        <div
          className="truncate text-[9pt] leading-tight font-medium text-black"
          title={label.secondary}
        >
          {label.secondary}
        </div>
      )}

      <Barcode value={label.barcode} heightMm={compact ? 9 : 14} />

      <div className="flex items-baseline justify-between gap-1">
        <span className="font-mono text-[8pt] leading-tight tracking-tight text-black">
          {label.primary}
        </span>
        {!compact && label.details && label.details.length > 0 && (
          <span className="truncate text-[7pt] leading-tight text-neutral-700">
            {label.details.map((d) => `${d.label} ${d.value}`).join(" · ")}
          </span>
        )}
      </div>
    </div>
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size < 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
