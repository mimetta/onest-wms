"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Badge,
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
  readBin,
  removeLine,
  resolveLot,
  setNotes,
  type AdjustmentLine,
  type BinItem,
  type ReasonOption,
} from "../actions";

export type ProductOption = {
  id: string;
  sku: string;
  nameTh: string;
  baseUomId: string;
  baseUomCode: string;
  trackingMode: "none" | "lot" | "serial";
};

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * ใบปรับปรุงสต๊อก — the only way to correct the record.
 *
 * The ledger is append-only (D-03), so nothing here edits anything: a correction
 * is a new movement in the opposite direction, and this screen's whole job is to
 * make that as ordinary as typing over a number would have been.
 *
 * The operator never chooses a direction or a sign. The reason code carries it,
 * so picking "พบสินค้าเพิ่ม" (found) versus "ตัดจำหน่าย" (write-off) decides
 * whether the quantity hangs off the destination or the source endpoint. A sign
 * an operator can get backwards is a sign that will be got backwards, at 5pm,
 * on the stock that mattered.
 *
 * Two flows follow from that:
 *
 *   decrease — scan the bin, tap what is there, say the real quantity
 *   increase — name the product, because the point is that the bin listing is
 *              wrong and the thing you found is not in it
 */
export function AdjustmentClient({
  reasons,
  products,
  canApprove,
}: {
  reasons: ReasonOption[];
  products: ProductOption[];
  canApprove: boolean;
}) {
  const t = useTranslations("adjustments");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Default to the first code that can actually be used. Ordering is by code, so
  // before the directed split this defaulted to COUNT_VAR — alphabetically first
  // and the one code the screen refuses, meaning anyone opening the screen cold
  // met a red banner before doing anything.
  const [reasonId, setReasonId] = useState(
    (reasons.find((r) => r.direction !== "both") ?? reasons[0])?.id ?? "",
  );
  const [draftId, setDraftId] = useState<string | null>(null);
  const [lines, setLines] = useState<AdjustmentLine[]>([]);
  const [notes, setNotesValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // decrease flow
  const [bin, setBin] = useState<{ id: string; code: string; items: BinItem[] } | null>(
    null,
  );
  const [item, setItem] = useState<BinItem | null>(null);
  const [countedQty, setCountedQty] = useState("");

  // increase flow
  const [productId, setProductId] = useState("");
  const [foundBin, setFoundBin] = useState<{ id: string; code: string } | null>(null);
  const [lotNo, setLotNo] = useState("");
  const [foundQty, setFoundQty] = useState("");

  const reason = reasons.find((r) => r.id === reasonId) ?? null;
  const direction = reason?.direction ?? "both";
  const product = products.find((p) => p.id === productId) ?? null;

  useEffect(() => {
    if (!reasonId) return;
    let cancelled = false;
    void (async () => {
      const result = await ensureDraft(reasonId);
      if (cancelled) return;
      if (result.ok && result.data) setDraftId(result.data);
      else if (!result.ok) setError(result.detail ?? t(result.error));
    })();
    return () => {
      cancelled = true;
    };
  }, [reasonId, t]);

  const handleBinScan = async (value: string) => {
    setError(null);
    const result = await readBin(value);
    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }
    const b = result.data!;

    if (direction === "increase") {
      setFoundBin({ id: b.locationId, code: b.code });
      return;
    }

    if (b.items.length === 0) {
      setError(t("binEmpty", { code: b.code }));
      return;
    }
    setBin({ id: b.locationId, code: b.code, items: b.items });
    if (b.items.length === 1) {
      setItem(b.items[0]);
      setCountedQty("");
    }
  };

  /** Decrease: the operator types what is really there, not the difference. */
  const handleAddDecrease = async () => {
    if (!draftId || !bin || !item) return;
    const counted = Number(countedQty);
    if (!(counted >= 0)) {
      setError(t("qtyNotNegative"));
      return;
    }
    if (counted >= item.qty) {
      setError(t("countedNotLower", { qty: item.qty.toLocaleString() }));
      return;
    }

    // The difference is computed here so the operator never does arithmetic on a
    // handheld. They report the world; the system works out the delta.
    const delta = round4(item.qty - counted);

    setBusy(true);
    setError(null);
    const result = await addLine({
      adjustmentId: draftId,
      productId: item.productId,
      locationId: bin.id,
      lotId: item.lotId,
      serialId: item.serialId,
      qty: delta,
      uomId: item.baseUomId,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    setLines((prev) => [...prev, result.data!]);
    setBin(null);
    setItem(null);
    setCountedQty("");
  };

  /** Increase: found stock the ledger does not know about. */
  const handleAddIncrease = async () => {
    if (!draftId || !product || !foundBin) return;
    const amount = Number(foundQty);
    if (!(amount > 0)) {
      setError(t("qtyPositive"));
      return;
    }

    setBusy(true);
    setError(null);

    let lotId: string | null = null;
    if (product.trackingMode === "lot") {
      if (!lotNo.trim()) {
        setBusy(false);
        setError(t("lotRequired"));
        return;
      }
      const lot = await resolveLot(product.id, lotNo);
      if (!lot.ok) {
        setBusy(false);
        setError(lot.detail ?? t(lot.error));
        return;
      }
      lotId = lot.data!.lotId;
    }

    const result = await addLine({
      adjustmentId: draftId,
      productId: product.id,
      locationId: foundBin.id,
      lotId,
      serialId: null,
      qty: round4(amount),
      uomId: product.baseUomId,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    setLines((prev) => [...prev, result.data!]);
    setProductId("");
    setLotNo("");
    setFoundQty("");
    setFoundBin(null);
  };

  const handleRemove = async (lineId: string) => {
    const result = await removeLine(lineId);
    if (result.ok) setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  const handleSubmit = async () => {
    if (!draftId) return;
    setBusy(true);
    setError(null);

    if (notes) await setNotes(draftId, notes);

    // Always submit, never approve — even for a user who could approve. An
    // adjustment is the one document where a second pair of eyes is the entire
    // control (D-20, D-39), and a screen that offered its author a one-click
    // approve would quietly remove it.
    const result = await submitDocument("adjustment", draftId);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    startTransition(() => router.push(`/adjustments/${draftId}`));
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("reasonLabel")}</SectionLabel>
        <Field label={t("reason")} hint={t("reasonHint")}>
          <Select
            value={reasonId}
            onChange={(e) => setReasonId(e.target.value)}
            // Changing the reason mid-document would relabel lines already
            // entered under a different explanation.
            disabled={lines.length > 0}
          >
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nameTh} ({r.code})
              </option>
            ))}
          </Select>
        </Field>

        {reason && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={direction === "increase" ? "good" : "warn"}>
              {t(`direction_${direction}`)}
            </Badge>
            {reason.isDisposal && <Badge tone="bad">{t("disposal")}</Badge>}
          </div>
        )}

        {direction === "both" && (
          // A reason code with no direction cannot decide which way stock moves,
          // and guessing is exactly what this screen exists to avoid.
          <Banner tone="bad">{t("reasonNeedsDirection")}</Banner>
        )}

        {/* Shown for every decrease, not only for reasons flagged as disposals:
            the QC gate is derived from the movement's endpoints, so removing a
            non-passed lot needs the QC role whatever the reason says (D-62). */}
        {direction === "decrease" && <Banner tone="warn">{t("decreaseNeedsQc")}</Banner>}
      </Card>

      {direction !== "both" && (
        <Card className="flex flex-col gap-3">
          <SectionLabel>
            {direction === "decrease" ? t("countStep") : t("foundStep")}
          </SectionLabel>

          <ScanField
            onScan={(e) => void handleBinScan(e.value)}
            label={direction === "decrease" ? t("scanBinToCount") : t("scanBinFound")}
            disabled={direction === "decrease" && Boolean(bin) && !item}
          />

          {/* ---------------- decrease ---------------- */}
          {direction === "decrease" && bin && !item && (
            <>
              <SectionLabel>{t("inThisBin", { code: bin.code })}</SectionLabel>
              <ul className="flex flex-col gap-1.5">
                {bin.items.map((i) => (
                  <li key={`${i.productId}-${i.lotId ?? ""}-${i.serialId ?? ""}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setItem(i);
                        setCountedQty("");
                      }}
                      className="border-brand-border flex w-full flex-wrap items-baseline gap-x-3 rounded-md border bg-white px-3 py-2 text-left"
                    >
                      <span className="text-brand-dark font-mono text-sm font-semibold">
                        {i.sku}
                      </span>
                      <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
                        {i.nameTh}
                      </span>
                      {i.lotNo && (
                        <span className="text-brand-muted font-mono text-xs">
                          {i.lotNo}
                        </span>
                      )}
                      {i.qcStatus && i.qcStatus !== "passed" && (
                        <Badge tone="warn">{i.qcStatus}</Badge>
                      )}
                      <span className="tabular text-brand-dark text-sm font-semibold">
                        {i.qty.toLocaleString()} {i.baseUomCode}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {direction === "decrease" && item && (
            <div className="border-brand-border/60 flex flex-col gap-3 border-t pt-3">
              <p className="text-brand-dark text-sm">
                <span className="font-mono">{item.sku}</span> {item.nameTh}
                {item.lotNo && (
                  <span className="text-brand-muted font-mono text-xs">
                    {" "}
                    {item.lotNo}
                  </span>
                )}
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-40">
                  <Field
                    label={`${t("systemSays")}: ${item.qty.toLocaleString()} ${item.baseUomCode}`}
                    hint={t("countedHint")}
                  >
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="any"
                      value={countedQty}
                      onChange={(e) => setCountedQty(e.target.value)}
                      placeholder={t("countedPlaceholder")}
                    />
                  </Field>
                </div>
                {countedQty !== "" && Number(countedQty) < item.qty && (
                  <p className="text-warning-text pb-2 text-sm">
                    {t("willRemove", {
                      qty: round4(item.qty - Number(countedQty)).toLocaleString(),
                      uom: item.baseUomCode,
                    })}
                  </p>
                )}
                <Button onClick={() => void handleAddDecrease()} disabled={busy}>
                  {t("addLine")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setItem(null);
                    setBin(null);
                  }}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            </div>
          )}

          {/* ---------------- increase ---------------- */}
          {direction === "increase" && (
            <div className="flex flex-col gap-3">
              {foundBin && <Badge tone="info">{foundBin.code}</Badge>}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("product")}>
                  <Select
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                  >
                    <option value="">{t("chooseProduct")}</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sku} · {p.nameTh}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label={product ? `${t("qty")} (${product.baseUomCode})` : t("qty")}
                >
                  <Input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={foundQty}
                    onChange={(e) => setFoundQty(e.target.value)}
                  />
                </Field>
              </div>

              {product?.trackingMode === "lot" && (
                <Field label={t("lotNo")} hint={t("lotNoHint")}>
                  <Input value={lotNo} onChange={(e) => setLotNo(e.target.value)} />
                </Field>
              )}

              {product?.trackingMode === "serial" && (
                // Serial-tracked found stock needs a serial record, and inventing
                // one here would create a unit with no receipt history. Better to
                // refuse than to fabricate.
                <Banner tone="bad">{t("serialNotSupported")}</Banner>
              )}

              <div className="flex justify-end">
                <Button
                  onClick={() => void handleAddIncrease()}
                  disabled={
                    busy || !product || !foundBin || product.trackingMode === "serial"
                  }
                >
                  {t("addLine")}
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

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
                {l.lotNo && (
                  <span className="text-brand-subtle font-mono text-xs">{l.lotNo}</span>
                )}
                {/* Reads as a direction rather than a signed number: the ledger
                    has no negatives, and neither does this list (D-02). */}
                <span className="text-brand-muted font-mono text-xs">
                  {l.fromCode ? `${l.fromCode} → —` : `— → ${l.toCode}`}
                </span>
                <span className="tabular text-brand-dark text-sm font-semibold">
                  {l.qty.toLocaleString()} {l.uomCode}
                </span>
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

      <Card className="flex flex-col gap-3">
        <Field label={t("notes")} hint={t("notesHint")}>
          <Input value={notes} onChange={(e) => setNotesValue(e.target.value)} />
        </Field>
      </Card>

      <div className="flex flex-col items-end gap-1">
        <Button onClick={() => void handleSubmit()} disabled={busy || lines.length === 0}>
          {t("submitForApproval")}
        </Button>
        <p className="text-brand-subtle text-xs">
          {canApprove ? t("youMayApproveLater") : t("needsApproval")}
        </p>
      </div>
    </div>
  );
}
