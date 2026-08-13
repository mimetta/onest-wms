import { Barcode } from "./barcode";
import type { LabelSize, LabelSpec } from "@/lib/labels/types";

/**
 * The browser-printable LabelRenderer.
 *
 * Labels are laid out on an A4 grid because no label printer has been bought
 * yet, and a sheet of adhesive labels works on any office printer. The
 * `@page` rule and the mm-based sizing mean a future roll printer needs only a
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
  // Small stock gets a tighter layout: a 50x25 bin label has room for a barcode
  // and its code, nothing else.
  const compact = size.heightMm <= 30;

  return (
    <div
      className="label-cell flex flex-col justify-center overflow-hidden border border-dashed border-neutral-300 px-2 py-1 print:border-transparent"
      style={{ width: `${size.widthMm}mm`, height: `${size.heightMm}mm` }}
    >
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
