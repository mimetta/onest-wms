"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Banner, Button, Card, Field, Input, SectionLabel } from "@/components/ui";
import { ScanField } from "@/components/scan/scan-field";
import {
  addLine,
  getSuggestions,
  verifyBinScan,
  type IssueLine,
  type Requirement,
  type Suggestion,
} from "../actions";

/**
 * Pick one product, guided by suggest_picks().
 *
 * The screen tells the operator where to go and what to take, they scan the bin
 * to confirm they are in the right place, and the quantity is pre-filled with
 * what was suggested. In the common case the whole interaction is: read a line,
 * walk, scan, press Add.
 *
 * Overriding a suggestion is allowed and visible rather than blocked. The
 * suggested drum may be behind a pallet or physically damaged, and a system that
 * insists on the fiction gets worked around — usually by picking the easy drum
 * and telling the system it picked the suggested one, which is the worst of all
 * outcomes because the record then lies. So a mismatch is recorded as what
 * actually happened, and flagged on screen so nobody thinks FEFO was followed
 * when it was not. The QC and sufficiency guards still apply at posting either
 * way (D-13, D-14).
 */
export function PickList({
  issueId,
  requirement,
  onLineAdded,
}: {
  issueId: string;
  requirement: Requirement;
  onLineAdded: (line: IssueLine, qty: number) => void;
}) {
  const t = useTranslations("issues");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The pick being confirmed.
  const [active, setActive] = useState<Suggestion | null>(null);
  const [scannedBin, setScannedBin] = useState<{ id: string; code: string } | null>(null);
  const [override, setOverride] = useState(false);
  const [qty, setQty] = useState("");

  const outstanding = requirement.qtyRequested - requirement.qtyPicked;

  useEffect(() => {
    // Nothing to fetch once the requirement is met — and nothing to clear
    // either, because the component renders the "picked" state from
    // `outstanding` rather than from an empty suggestion list.
    if (outstanding <= 0) return;

    let cancelled = false;
    void (async () => {
      const result = await getSuggestions(requirement.productId, outstanding);
      if (cancelled) return;
      if (result.ok) {
        setSuggestions(result.data ?? []);
        // Pre-select the first suggestion: it is the one FEFO wants picked, and
        // making the operator choose it every time adds a tap that always has
        // the same answer.
        setActive((result.data ?? [])[0] ?? null);
        setQty(String((result.data ?? [])[0]?.qtySuggested ?? ""));
      } else {
        setError(result.detail ?? t(result.error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requirement.productId, outstanding, t]);

  const handleScan = async (value: string) => {
    if (!active) return;
    setError(null);

    const result = await verifyBinScan(value, active.locationId);
    if (!result.ok) {
      setError(t(result.error));
      return;
    }

    const bin = result.data!;

    if (bin.blocksConsumption) {
      // QC hold, quarantine or scrap. Posting would refuse it anyway, so
      // refusing it here saves the operator carrying the drum back.
      setError(t("binBlocksConsumption", { code: bin.code }));
      return;
    }

    setScannedBin({ id: bin.locationId, code: bin.code });
    setOverride(!bin.matches);
  };

  const handleAdd = async () => {
    if (!active) return;
    const amount = Number(qty);
    if (!(amount > 0)) {
      setError(t("qtyPositive"));
      return;
    }

    // A bin scan is required before a line can be added: it is the one check
    // that the person is standing where the system thinks they are.
    if (!scannedBin) {
      setError(t("scanBinFirst"));
      return;
    }

    setBusy(true);
    setError(null);
    const result = await addLine({
      issueId,
      productId: requirement.productId,
      locationId: scannedBin.id,
      // When the operator overrode the bin, the suggested lot no longer applies
      // — a different bin holds different stock. The lot is dropped and left to
      // the posting guard, which reads the ledger at that exact bin.
      lotId: override ? null : active.lotId,
      serialId: override ? null : active.serialId,
      qty: amount,
      uomId: requirement.baseUomId,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    onLineAdded(result.data!, amount);
    setScannedBin(null);
    setOverride(false);
    setQty("");
  };

  if (outstanding <= 0) {
    return (
      <Card className="flex items-center gap-2">
        <Badge tone="good">{t("picked")}</Badge>
        <span className="text-brand-dark text-sm">
          {requirement.sku} · {requirement.nameTh}
        </span>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-brand-dark font-mono text-sm font-semibold">
          {requirement.sku}
        </span>
        <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
          {requirement.nameTh}
        </span>
        <span className="tabular text-brand-dark text-sm font-semibold">
          {outstanding.toLocaleString()} {requirement.baseUomCode}
        </span>
      </div>

      {suggestions === null && <p className="text-brand-muted text-sm">{t("loading")}</p>}

      {suggestions?.length === 0 && (
        <Banner tone="warn">{t("nothingAvailable")}</Banner>
      )}

      {suggestions && suggestions.length > 0 && (
        <>
          <SectionLabel>{t("pickFrom")}</SectionLabel>
          <ul className="flex flex-col gap-1.5">
            {suggestions.map((s) => {
              const chosen = active?.locationId === s.locationId && active?.lotId === s.lotId;
              return (
                <li key={`${s.locationId}-${s.lotId ?? "none"}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setActive(s);
                      setQty(String(s.qtySuggested));
                      setScannedBin(null);
                      setOverride(false);
                    }}
                    className={[
                      "flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md border px-3 py-2 text-left",
                      chosen
                        ? "border-brand-brown bg-brand-cream"
                        : "border-brand-border bg-white",
                    ].join(" ")}
                  >
                    <span className="text-brand-dark font-mono text-sm font-semibold">
                      {s.locationCode}
                    </span>
                    {s.lotNo && (
                      <span className="text-brand-muted font-mono text-xs">{s.lotNo}</span>
                    )}
                    {s.expiryDate && (
                      <span className="text-warning-text text-xs">
                        {t("expires", { date: s.expiryDate })}
                      </span>
                    )}
                    <span className="tabular text-brand-dark ml-auto text-sm">
                      {s.qtySuggested.toLocaleString()} {requirement.baseUomCode}
                    </span>
                    <Badge tone={s.strategy === "fefo" ? "info" : "neutral"}>
                      {t(s.strategy)}
                    </Badge>
                  </button>
                </li>
              );
            })}
          </ul>

          {active && (
            <div className="border-brand-border/60 flex flex-col gap-3 border-t pt-3">
              <ScanField
                onScan={(e) => void handleScan(e.value)}
                label={t("scanBin", { code: active.locationCode })}
              />

              {scannedBin && !override && (
                <Banner tone="good">{t("binConfirmed", { code: scannedBin.code })}</Banner>
              )}
              {scannedBin && override && (
                <Banner tone="warn">
                  {t("binOverridden", {
                    scanned: scannedBin.code,
                    suggested: active.locationCode,
                  })}
                </Banner>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-32 flex-1">
                  <Field label={`${t("qtyPicked")} (${requirement.baseUomCode})`}>
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
                <Button onClick={() => void handleAdd()} disabled={busy || !scannedBin}>
                  {t("addPick")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <Banner tone="bad">{error}</Banner>}
    </Card>
  );
}
