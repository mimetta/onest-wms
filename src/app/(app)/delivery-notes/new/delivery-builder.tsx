"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionLabel,
  Select,
} from "@/components/ui";
import { approveAndPost, submitDocument } from "@/app/(app)/documents/actions";
import type { Suggestion } from "../../issues/actions";
import {
  addLine,
  ensureDraft,
  getSuggestions,
  removeLine,
  setHeader,
  type DeliveryLine,
} from "../actions";

export type PartnerOption = {
  id: string;
  code: string;
  nameTh: string;
  hasConsignmentSite: boolean;
};

export type ProductOption = {
  id: string;
  sku: string;
  nameTh: string;
  baseUomId: string;
  baseUomCode: string;
};

/**
 * ใบส่งสินค้า — despatch to a customer.
 *
 * The consignment flag is set once, before any line exists, and locks
 * afterwards: an outright sale sends stock out of the company while a
 * consignment move sends it to the customer's site location where it is still
 * ours (D-02). Those are different destinations, so a note cannot be half of
 * each — the header decides, and every line follows.
 */
export function DeliveryBuilder({
  partners,
  products,
  canApprove,
}: {
  partners: PartnerOption[];
  products: ProductOption[];
  canApprove: boolean;
}) {
  const t = useTranslations("deliveryNotes");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? "");
  const [isConsignment, setIsConsignment] = useState(false);
  const [soReference, setSoReference] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [lines, setLines] = useState<DeliveryLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The line being built.
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [chosen, setChosen] = useState<Suggestion | null>(null);

  const partner = partners.find((p) => p.id === partnerId) ?? null;
  const product = products.find((p) => p.id === productId) ?? null;

  useEffect(() => {
    if (!partnerId) return;
    let cancelled = false;
    void (async () => {
      const result = await ensureDraft(partnerId, isConsignment);
      if (cancelled) return;
      if (result.ok && result.data) setDraftId(result.data);
      else if (!result.ok) setError(result.detail ?? t(result.error));
    })();
    return () => {
      cancelled = true;
    };
  }, [partnerId, isConsignment, t]);

  // Suggestions refresh whenever the product or quantity changes, so the
  // operator sees where the stock is before committing to a line.
  const wantedQty = Number(qty);
  const readyToSuggest = Boolean(productId) && wantedQty > 0;

  useEffect(() => {
    // Guarded rather than cleared: `readyToSuggest` gates the render below, so
    // there is no stale list to wipe when the operator empties the quantity.
    // The draft id is part of the query now — suggestions subtract this
    // document's own un-posted lines — so there is nothing to ask for until it
    // exists.
    if (!readyToSuggest || !draftId) return;

    let cancelled = false;
    void (async () => {
      const result = await getSuggestions(productId, wantedQty, draftId!);
      if (cancelled) return;
      if (result.ok) {
        setSuggestions(result.data ?? []);
        setChosen((result.data ?? [])[0] ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [productId, wantedQty, readyToSuggest, draftId]);

  const handleAdd = async () => {
    if (!draftId || !product || !chosen) return;
    const amount = Number(qty);
    if (!(amount > 0)) {
      setError(t("qtyPositive"));
      return;
    }

    setBusy(true);
    setError(null);
    const result = await addLine({
      deliveryNoteId: draftId,
      productId: product.id,
      // The chosen suggestion caps the line: taking more from one bin than it
      // holds would be rejected at posting anyway (D-13).
      locationId: chosen.locationId,
      lotId: chosen.lotId,
      serialId: chosen.serialId,
      qty: Math.round(Math.min(amount, chosen.qtySuggested) * 1e4) / 1e4,
      uomId: product.baseUomId,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    setLines((prev) => [...prev, result.data!]);
    setProductId("");
    setQty("");
    setSuggestions([]);
    setChosen(null);
  };

  const handleRemove = async (lineId: string) => {
    const result = await removeLine(lineId);
    if (result.ok) setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  const handleFinish = async () => {
    if (!draftId) return;
    setBusy(true);
    setError(null);

    if (soReference) await setHeader(draftId, { soReference });

    // Warehouse staff DO hold delivery_note.approve — the owner kept the
    // approver as warehouse_staff so a despatch is not blocked waiting for a
    // manager while a lorry idles at the gate. So the common path here really is
    // approve-and-post in one action.
    const result = canApprove
      ? await approveAndPost("delivery_note", draftId)
      : await submitDocument("delivery_note", draftId);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    // Straight to the document, where the print button is: the sheet has to go
    // with the goods, so printing is the next thing that happens.
    startTransition(() => router.push(`/delivery-notes/${draftId}`));
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("deliverTo")}</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("customer")}>
            <Select
              value={partnerId}
              onChange={(e) => setPartnerId(e.target.value)}
              disabled={lines.length > 0}
            >
              {partners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.nameTh}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("soReference")} hint={t("soReferenceHint")}>
            <Input value={soReference} onChange={(e) => setSoReference(e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-col gap-1">
          <Checkbox
            checked={isConsignment}
            onChange={(e) => setIsConsignment(e.target.checked)}
            // Only offered when the customer actually has a site location:
            // consigning to a customer with nowhere to consign it would fail at
            // the first line, and failing at the checkbox is clearer.
            disabled={lines.length > 0 || !partner?.hasConsignmentSite}
            label={t("isConsignment")}
          />
          <p className="text-brand-subtle text-xs">
            {partner?.hasConsignmentSite
              ? t("isConsignmentHint")
              : t("noConsignmentSiteHint")}
          </p>
        </div>
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("addLine")}</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-[3fr_1fr]">
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
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </Field>
        </div>

        {readyToSuggest && suggestions.length > 0 && (
          <>
            <SectionLabel>{t("pickFrom")}</SectionLabel>
            <ul className="flex flex-col gap-1.5">
              {suggestions.map((s) => {
                const active =
                  chosen?.locationId === s.locationId && chosen?.lotId === s.lotId;
                return (
                  <li key={`${s.locationId}-${s.lotId ?? "none"}`}>
                    <button
                      type="button"
                      onClick={() => setChosen(s)}
                      className={[
                        "flex w-full flex-wrap items-baseline gap-x-3 rounded-md border px-3 py-2 text-left",
                        active
                          ? "border-brand-brown bg-brand-cream"
                          : "border-brand-border bg-white",
                      ].join(" ")}
                    >
                      <span className="text-brand-dark font-mono text-sm font-semibold">
                        {s.locationCode}
                      </span>
                      {s.lotNo && (
                        <span className="text-brand-muted font-mono text-xs">
                          {s.lotNo}
                        </span>
                      )}
                      {s.expiryDate && (
                        <span className="text-warning-text text-xs">{s.expiryDate}</span>
                      )}
                      <span className="tabular text-brand-dark ml-auto text-sm">
                        {s.qtySuggested.toLocaleString()}
                      </span>
                      <Badge tone={s.strategy === "fefo" ? "info" : "neutral"}>
                        {t(s.strategy)}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        {readyToSuggest && suggestions.length === 0 && (
          <Banner tone="warn">{t("nothingAvailable")}</Banner>
        )}

        <div className="flex justify-end">
          <Button
            onClick={() => void handleAdd()}
            disabled={busy || !product || !chosen || !draftId || !readyToSuggest}
          >
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
                <span className="text-brand-muted font-mono text-xs">{l.fromCode}</span>
                {l.lotNo && (
                  <span className="text-brand-subtle font-mono text-xs">{l.lotNo}</span>
                )}
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

      <div className="flex justify-end">
        <Button onClick={() => void handleFinish()} disabled={busy || lines.length === 0}>
          {canApprove ? t("postAndPrint") : t("submitForApproval")}
        </Button>
      </div>
    </div>
  );
}
