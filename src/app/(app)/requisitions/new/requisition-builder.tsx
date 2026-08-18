"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Banner,
  Button,
  Card,
  Field,
  Input,
  SectionLabel,
  Select,
} from "@/components/ui";
import { ScanField } from "@/components/scan/scan-field";
import { submitDocument } from "@/app/(app)/documents/actions";
import {
  addLine,
  ensureDraft,
  removeLine,
  scanProduct,
  setHeader,
  type RequisitionLine,
} from "../actions";

export type ProductOption = {
  id: string;
  sku: string;
  nameTh: string;
  baseUomId: string;
  baseUomCode: string;
};

export type DeptOption = { id: string; nameTh: string };

/**
 * ใบขอเบิก — raise a request.
 *
 * A requisition names products and quantities; it does not name bins or lots.
 * Which drum comes off which shelf is the warehouse's decision at fulfilment,
 * and suggest_picks() makes it (D-50). Letting the requester pin a bin here
 * would be a promise the warehouse cannot keep.
 *
 * Two ways to add a line, both first-class: scan the product's barcode, or pick
 * it from the list. Scanning wins on a shop floor where the person is standing
 * next to the empty box; the list wins for someone requesting something they do
 * not have in front of them, which for a requisition is the common case.
 */
export function RequisitionBuilder({
  departments,
  products,
  defaultDepartmentId,
}: {
  departments: DeptOption[];
  products: ProductOption[];
  defaultDepartmentId: string | null;
}) {
  const t = useTranslations("requisitions");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [departmentId, setDepartmentId] = useState(
    defaultDepartmentId ?? departments[0]?.id ?? "",
  );
  const [draftId, setDraftId] = useState<string | null>(null);
  const [lines, setLines] = useState<RequisitionLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The line being built.
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [requiredDate, setRequiredDate] = useState("");

  const product = products.find((p) => p.id === productId) ?? null;

  // The draft is created as soon as a department is chosen, so the first line
  // has somewhere to go and a lost connection loses nothing.
  useEffect(() => {
    if (!departmentId) return;
    let cancelled = false;

    void (async () => {
      const result = await ensureDraft(departmentId);
      if (cancelled) return;
      if (result.ok && result.data) {
        setDraftId(result.data);
      } else if (!result.ok) {
        setError(result.detail ?? t(result.error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [departmentId, t]);

  const handleScan = async (value: string) => {
    setError(null);
    const result = await scanProduct(value);

    if (!result.ok) {
      setError(t(result.error));
      return;
    }

    // Select the scanned product and put the cursor on quantity — the one thing
    // the scan cannot tell us.
    setProductId(result.data!.productId);
    document.getElementById("req-qty")?.focus();
  };

  const handleAdd = async () => {
    if (!draftId || !product) return;
    const amount = Number(qty);
    if (!(amount > 0)) {
      setError(t("qtyPositive"));
      return;
    }

    setBusy(true);
    setError(null);
    const result = await addLine({
      requisitionId: draftId,
      productId: product.id,
      qty: amount,
      uomId: product.baseUomId,
      note: note || undefined,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    setLines((prev) => [...prev, result.data!]);
    setProductId("");
    setQty("");
    setNote("");
  };

  const handleRemove = async (lineId: string) => {
    const result = await removeLine(lineId);
    if (result.ok) setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  const handleSubmit = async () => {
    if (!draftId) return;
    setBusy(true);
    setError(null);

    if (requiredDate) await setHeader(draftId, { requiredDate });

    const result = await submitDocument("requisition", draftId);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    startTransition(() => router.push(`/requisitions/${draftId}`));
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("requestFor")}</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("department")}>
            <Select
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              // Changing department mid-requisition would move lines between
              // cost centres, so it locks once the first line exists.
              disabled={lines.length > 0}
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.nameTh}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("requiredDate")} hint={t("requiredDateHint")}>
            <Input
              type="date"
              value={requiredDate}
              onChange={(e) => setRequiredDate(e.target.value)}
            />
          </Field>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("addLine")}</SectionLabel>

        <ScanField onScan={(e) => void handleScan(e.value)} label={t("scanProduct")} />

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end">
          <Field label={t("product")}>
            <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">{t("choose")}</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} · {p.nameTh}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={product ? `${t("qty")} (${product.baseUomCode})` : t("qty")}>
            <Input
              id="req-qty"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAdd();
                }
              }}
            />
          </Field>

          <Field label={t("note")}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>

          <Button onClick={() => void handleAdd()} disabled={busy || !product || !draftId}>
            {t("add")}
          </Button>
        </div>
      </Card>

      {error && <Banner tone="bad">{error}</Banner>}

      {lines.length > 0 && (
        <Card className="flex flex-col gap-2">
          <SectionLabel>{t("linesLabel", { count: lines.length })}</SectionLabel>
          <ul className="divide-brand-border/60 flex flex-col divide-y">
            {lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="text-brand-subtle w-6 text-xs">{l.lineNo}</span>
                <span className="text-brand-dark font-mono text-xs">{l.sku}</span>
                <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
                  {l.nameTh}
                </span>
                <span className="tabular text-brand-dark text-sm font-semibold">
                  {l.qty.toLocaleString()} {l.uomCode}
                </span>
                {/* Advisory, not a block: a requisition may legitimately ask
                    for more than is on the shelf — that is how a purchase gets
                    triggered. It is shown so the requester is not surprised
                    later. */}
                {l.qtyAvailable < l.qty && (
                  <span className="text-warning-text text-xs">
                    {t("onlyAvailable", { qty: l.qtyAvailable.toLocaleString() })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void handleRemove(l.id)}
                  className="text-destructive text-xs"
                >
                  {tCommon("cancel")}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex justify-end gap-2">
        <Button
          onClick={() => void handleSubmit()}
          disabled={busy || lines.length === 0}
        >
          {t("submitRequest")}
        </Button>
      </div>
    </div>
  );
}
