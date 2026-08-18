"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Banner, Button, Card, Field, Input, SectionLabel } from "@/components/ui";
import { ScanField } from "@/components/scan/scan-field";
import { approveAndPost, submitDocument } from "@/app/(app)/documents/actions";
import {
  addLine,
  ensureDraft,
  readBin,
  readDestination,
  removeLine,
  type BinItem,
  type TransferLine,
} from "../actions";

/**
 * ใบโอนย้าย — putaway and internal moves, scan first.
 *
 * The sequence is the physical job in order: scan the bin you are standing at,
 * tap what you are picking up, say how much, scan where you put it. Nothing is
 * typed except the quantity, and nothing is searched — the screen offers only
 * what that bin actually contains, read back from the ledger.
 *
 * Reading from stock_on_hand rather than stock_available is deliberate: a
 * putaway moves stock out of receiving and QC hold, which stock_available
 * excludes by design (D-13). Filtering by availability would hide exactly the
 * stock this screen exists to move.
 */
export function PutawayClient({ canApprove }: { canApprove: boolean }) {
  const t = useTranslations("transfers");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [draftId, setDraftId] = useState<string | null>(null);
  const [lines, setLines] = useState<TransferLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const [source, setSource] = useState<{
    id: string;
    code: string;
    items: BinItem[];
  } | null>(null);
  const [item, setItem] = useState<BinItem | null>(null);
  const [qty, setQty] = useState("");
  const [dest, setDest] = useState<{ id: string; code: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const result = await ensureDraft();
      if (result.ok && result.data) setDraftId(result.data);
      else if (!result.ok) setError(result.detail ?? t(result.error));
    })();
  }, [t]);

  // Which stage the operator is at, so one scan field can serve the whole flow
  // without them choosing which box to aim at.
  const stage: "source" | "item" | "dest" = !source ? "source" : !item ? "item" : "dest";

  const handleScan = async (value: string) => {
    setError(null);

    if (stage === "source") {
      const result = await readBin(value);
      if (!result.ok) {
        setError(result.detail ?? t(result.error));
        return;
      }
      const bin = result.data!;
      if (bin.items.length === 0) {
        setError(t("binEmpty", { code: bin.code }));
        return;
      }
      setSource({ id: bin.locationId, code: bin.code, items: bin.items });
      // One thing in the bin is the common case for a drum: skip the choosing.
      if (bin.items.length === 1) {
        setItem(bin.items[0]);
        setQty(String(bin.items[0].qty));
      }
      return;
    }

    // At the destination stage a bin scan finishes the move.
    const result = await readDestination(value);
    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }
    if (result.data!.locationId === source?.id) {
      setError(t("sameBin"));
      return;
    }
    setDest({ id: result.data!.locationId, code: result.data!.code });
  };

  const handleAdd = async () => {
    if (!draftId || !source || !item || !dest) return;
    const amount = Number(qty);
    if (!(amount > 0)) {
      setError(t("qtyPositive"));
      return;
    }
    if (amount > item.qty) {
      setError(t("moreThanBin", { qty: item.qty.toLocaleString() }));
      return;
    }

    setBusy(true);
    setError(null);
    const result = await addLine({
      transferId: draftId,
      productId: item.productId,
      lotId: item.lotId,
      serialId: item.serialId,
      qty: amount,
      uomId: item.baseUomId,
      fromLocationId: source.id,
      toLocationId: dest.id,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    setLines((prev) => [...prev, result.data!]);
    // Reset to the start: the next move begins with a new bin scan, because the
    // operator has physically walked somewhere else.
    setSource(null);
    setItem(null);
    setDest(null);
    setQty("");
  };

  const handleRemove = async (lineId: string) => {
    const result = await removeLine(lineId);
    if (result.ok) setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  const handleFinish = async () => {
    if (!draftId) return;
    setBusy(true);
    setError(null);

    // Adapts to the signed-in user rather than assuming, the same pattern as the
    // QC write-off (D-39): a manager approves and posts in one action, and
    // warehouse staff — who do not hold transfer.approve — submit and wait.
    // Offering staff an Approve button would only produce a permission error,
    // and quietly granting them the permission would remove a control the
    // owner set deliberately.
    const result = canApprove
      ? await approveAndPost("transfer", draftId)
      : await submitDocument("transfer", draftId);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    if (canApprove && "data" in result && result.data) {
      setDone((result.data as { docNo: string }).docNo);
      setLines([]);
      setDraftId(null);
      startTransition(() => router.refresh());
      // A new draft for the next round of putaway.
      void ensureDraft().then((r) => {
        if (r.ok && r.data) setDraftId(r.data);
      });
    } else {
      startTransition(() => router.push(`/transfers/${draftId}`));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {done && <Banner tone="good">{t("postedAs", { docNo: done })}</Banner>}

      <Card className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <SectionLabel>{t(`stage_${stage}`)}</SectionLabel>
          {source && (
            <Badge tone="info">
              {source.code}
              {dest ? ` → ${dest.code}` : ""}
            </Badge>
          )}
        </div>

        <ScanField
          onScan={(e) => void handleScan(e.value)}
          label={t(`scanPrompt_${stage}`)}
          disabled={stage === "item"}
        />

        {source && !item && (
          <>
            <SectionLabel>{t("inThisBin")}</SectionLabel>
            <ul className="flex flex-col gap-1.5">
              {source.items.map((i) => (
                <li key={`${i.productId}-${i.lotId ?? ""}-${i.serialId ?? ""}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setItem(i);
                      setQty(String(i.qty));
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
                    {i.serialNo && (
                      <span className="text-brand-muted font-mono text-xs">
                        {i.serialNo}
                      </span>
                    )}
                    {/* Shown, not blocked: moving a pending lot from receiving
                        to QC hold is a legitimate and necessary putaway
                        (D-14). The QC gate applies to consumption, not to
                        moving stock around inside the warehouse. */}
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

        {item && (
          <div className="border-brand-border/60 flex flex-wrap items-end gap-3 border-t pt-3">
            <div className="min-w-0 flex-1">
              <p className="text-brand-dark text-sm">
                <span className="font-mono">{item.sku}</span> {item.nameTh}
                {item.lotNo && (
                  <span className="text-brand-muted font-mono text-xs">
                    {" "}
                    {item.lotNo}
                  </span>
                )}
              </p>
            </div>
            <div className="w-32">
              <Field label={`${t("qty")} (${item.baseUomCode})`}>
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
            <Button onClick={() => void handleAdd()} disabled={busy || !dest}>
              {t("addMove")}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setItem(null);
                setDest(null);
              }}
            >
              {tCommon("cancel")}
            </Button>
          </div>
        )}
      </Card>

      {error && <Banner tone="bad">{error}</Banner>}

      {lines.length > 0 && (
        <Card className="flex flex-col gap-2">
          <SectionLabel>{t("movesLabel", { count: lines.length })}</SectionLabel>
          <ul className="divide-brand-border/60 flex flex-col divide-y">
            {lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="text-brand-subtle w-6 text-xs">{l.lineNo}</span>
                <span className="text-brand-dark font-mono text-xs">{l.sku}</span>
                <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
                  {l.nameTh}
                </span>
                <span className="text-brand-muted font-mono text-xs">
                  {l.fromCode} → {l.toCode}
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

      <div className="flex flex-col items-end gap-1">
        <Button onClick={() => void handleFinish()} disabled={busy || lines.length === 0}>
          {canApprove ? t("postNow") : t("submitForApproval")}
        </Button>
        {!canApprove && lines.length > 0 && (
          <p className="text-brand-subtle text-xs">{t("needsManagerApproval")}</p>
        )}
      </div>
    </div>
  );
}
