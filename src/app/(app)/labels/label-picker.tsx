"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, Button, Card, Field, SectionLabel, Select } from "@/components/ui";
import { LabelSheet } from "@/components/label-sheet";
import {
  DEFAULT_SIZE_FOR,
  LABEL_SIZES,
  sizesFor,
  type LabelKind,
  type LabelSpec,
} from "@/lib/labels/types";

export type PickableItem = {
  id: string;
  /** Falls back to the code when no barcode exists — see noBarcodeWarning. */
  barcode: string;
  primary: string;
  secondary?: string;
  details?: { label: string; value: string }[];
  /** Larger fields for the 100x150 drum label. */
  fields?: { label: string; value: string }[];
  qcBox?: true;
  /** True when this row had no barcode row of its own. */
  synthesised?: boolean;
  /** Short right-aligned note in the picker list, e.g. QC status. */
  hint?: string;
};

export function LabelPicker({
  kind,
  items,
  preselectedIds = [],
}: {
  kind: LabelKind;
  items: PickableItem[];
  /** Ids passed in the URL, so a "print label" link arrives ready to print. */
  preselectedIds?: string[];
}) {
  const t = useTranslations("labels");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(preselectedIds.filter((id) => items.some((i) => i.id === id))),
  );
  const [sizeId, setSizeId] = useState(DEFAULT_SIZE_FOR[kind]);

  const size = LABEL_SIZES[sizeId];
  const anySynthesised = items.some((i) => i.synthesised && selected.has(i.id));

  const labels: LabelSpec[] = useMemo(
    () =>
      items
        .filter((i) => selected.has(i.id))
        .map((i) => ({
          kind,
          barcode: i.barcode,
          primary: i.primary,
          secondary: i.secondary,
          details: i.details,
          fields: i.fields,
          qcBox: i.qcBox,
        })),
    [items, selected, kind],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 px-4 py-3 sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <SectionLabel>{t("selectItems")}</SectionLabel>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelected(new Set(items.map((i) => i.id)))}
              className="text-brand-brown text-xs font-medium"
            >
              {t("selectAll")}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-brand-accent text-xs"
            >
              {t("clearSelection")}
            </button>
          </div>
        </div>

        {/* Scrolls rather than paginating: choosing what to print is a
            scanning task, and pagination would hide half the selection. */}
        <div className="border-brand-border max-h-80 overflow-y-auto rounded-md border">
          <ul className="divide-brand-border/60 divide-y">
            {items.map((item) => (
              <li key={item.id}>
                <label className="hover:bg-brand-cream/60 flex cursor-pointer items-center gap-3 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    className="border-brand-border accent-brand-brown size-4 rounded border"
                  />
                  <span className="text-brand-dark shrink-0 font-mono text-xs">
                    {item.primary}
                  </span>
                  {item.secondary && (
                    <span className="text-brand-muted truncate text-sm">
                      {item.secondary}
                    </span>
                  )}
                  {item.hint && (
                    <span className="text-brand-subtle ml-auto shrink-0 text-xs">
                      {item.hint}
                    </span>
                  )}
                </label>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-end gap-4">
          <Field label={t("labelSize")}>
            <Select
              value={sizeId}
              onChange={(e) => setSizeId(e.target.value)}
              className="w-40"
            >
              {sizesFor(kind).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.widthMm} × {s.heightMm} mm
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex flex-col gap-1">
            <span className="text-brand-subtle text-xs">
              {t("selected", { count: selected.size })} ·{" "}
              {t("sheetHint", { perSheet: size.columns * size.rows })}
            </span>
            <Button
              type="button"
              onClick={() => window.print()}
              disabled={selected.size === 0}
            >
              {t("print")}
            </Button>
          </div>
        </div>

        {anySynthesised && <Banner tone="warn">{t("noBarcodeWarning")}</Banner>}
        <p className="text-brand-subtle text-xs">{t("printHint")}</p>
      </Card>

      {labels.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="text-brand-dark text-sm font-medium">{t("nothingSelected")}</p>
          <p className="text-brand-muted mt-1 text-sm">{t("nothingSelectedHint")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          <SectionLabel>{t("preview")}</SectionLabel>
          {/* The preview is the print output: what is on screen inside this
              container is exactly what @page renders, so there is no separate
              print template to drift out of step. */}
          <div className="border-brand-border overflow-x-auto rounded-[10px] border bg-white p-3">
            <LabelSheet labels={labels} size={size} />
          </div>
        </div>
      )}
    </div>
  );
}
