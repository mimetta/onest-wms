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

        <div className="flex flex-col gap-1">
          <Barcode value={label.barcode} heightMm={22} />
          <div className="text-center font-mono text-[11pt] tracking-tight text-black">
            {label.primary}
          </div>
        </div>

        {label.qc ? (
          <div className="border-t-2 border-black pt-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[9pt] text-neutral-600">QC</span>
              <span className="text-[14pt] leading-none font-bold text-black">
                {label.qc.statusLabel}
              </span>
            </div>
            {(label.qc.decidedBy || label.qc.decidedAt) && (
              <div className="mt-0.5 flex justify-between gap-2 text-[8pt] text-neutral-700">
                <span>{label.qc.decidedBy ?? ""}</span>
                <span>{label.qc.decidedAt ?? ""}</span>
              </div>
            )}
            {/* The printed status can go stale the moment QC changes its mind.
                Saying so on the label is cheaper than a wrong assumption. */}
            <div className="mt-0.5 text-[6.5pt] leading-tight text-neutral-500">
              {label.qc.caveat}
            </div>
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
