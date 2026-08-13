"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner, Button, Card, Field, SectionLabel, Select } from "@/components/ui";
import { linkBarcode, type LinkBarcodeState } from "./actions";
import type { CaptureSuggestion } from "@/lib/barcodes/symbology";

/**
 * Turn an unrecognised barcode into a known one.
 *
 * This is the capture half of D-35: AccCloud supplies no barcodes, so the
 * warehouse teaches the system supplier codes during normal receiving. The
 * unknown-barcode dead end becomes the mechanism.
 *
 * Defaults come from the symbology guess, which is the ONLY place a scanned
 * value's shape is inspected (D-36).
 */
export function LinkBarcodeForm({
  barcode,
  suggestion,
  products,
  uoms,
  onLinked,
}: {
  barcode: string;
  suggestion: CaptureSuggestion;
  products: { id: string; sku: string; name_th: string }[];
  uoms: { id: string; code: string; name_th: string }[];
  onLinked: () => void;
}) {
  const t = useTranslations("scan");
  const [state, formAction, pending] = useActionState<LinkBarcodeState, FormData>(
    linkBarcode,
    {},
  );
  const [type, setType] = useState(suggestion.barcodeType);

  // Re-scan after a successful link, so the operator sees the product they just
  // taught the system rather than a success message they have to act on.
  useEffect(() => {
    if (state.linkedTo) onLinked();
    // onLinked is stable for the life of this form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.linkedTo]);

  return (
    <Card className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-col gap-1">
        <SectionLabel>{t("linkTitle")}</SectionLabel>
        <p className="text-brand-muted text-sm">{t("linkExplain")}</p>
        <p className="text-brand-dark mt-1 font-mono text-base">{barcode}</p>
      </div>

      {state.error && <Banner tone="bad">{t(state.error)}</Banner>}
      {state.linkedTo && (
        <Banner tone="good">{t("linked", { sku: state.linkedTo })}</Banner>
      )}

      <form action={formAction} className="flex flex-col gap-4">
        <input type="hidden" name="barcode" value={barcode} />

        <Field label={t("chooseProduct")}>
          <Select name="product_id" required defaultValue="">
            <option value="">—</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} · {p.name_th}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("barcodeType")}>
            <Select
              name="type"
              value={type}
              onChange={(e) =>
                setType(e.target.value as CaptureSuggestion["barcodeType"])
              }
            >
              <option value="supplier">{t("typeSupplier")}</option>
              <option value="case">{t("typeCase")}</option>
              <option value="internal">{t("typeInternal")}</option>
              <option value="other">{t("typeOther")}</option>
            </Select>
          </Field>

          <Field
            label={t("unitPerScan")}
            // A 14-digit code is almost always a case. Guessing pieces would
            // make every receipt of it wrong by the case quantity, so the
            // prompt is explicit rather than a quiet default.
            hint={
              suggestion.needsUomPrompt || type === "case" ? t("unitPrompt") : undefined
            }
          >
            <Select name="uom_id" required defaultValue="">
              <option value="">—</option>
              {uoms.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} · {u.name_th}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div>
          <Button type="submit" disabled={pending}>
            {t("link")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
