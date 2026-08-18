"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { ScanField } from "@/components/scan/scan-field";
import { beepAccept, beepReject, beepWarn } from "@/lib/audio/beep";
import { Badge, Banner, Button, Card, SectionLabel } from "@/components/ui";
import { scan } from "../stock/actions";
import { addLine, postReceipt, removeLine, type ReceiptLine } from "./actions";

/**
 * The acceptance test of Phase 1, made real: a full goods receipt completed
 * with a scanner and number keys, no mouse.
 *
 * The screen is a small state machine. Each step knows what input it wants and
 * moves on by itself, so the receiver's hands never leave the scanner and the
 * number pad:
 *
 *   bin → product → [lot → expiry] | [serial] → quantity → commit → product
 *
 * The scanner listener is disabled during the quantity and expiry steps. Those
 * are typed by a human, and a fast typist hitting Enter would otherwise be
 * mistaken for a scan.
 */

type Step = "bin" | "product" | "lot" | "expiry" | "serial" | "qty";

type Pending = {
  productId: string;
  sku: string;
  nameTh: string;
  trackingMode: "none" | "lot" | "serial";
  requiresQc: boolean;
  uomId: string;
  uomCode: string;
  /** False when the SKU was scanned from a shelf label rather than the goods. */
  hasOwnBarcode: boolean;
  lotNo?: string;
  expiryDate?: string;
  serialNo?: string;
};

export function ReceiveClient({
  receiptId,
  initialLines,
  initialBin,
}: {
  receiptId: string;
  initialLines: ReceiptLine[];
  initialBin: { id: string; code: string } | null;
}) {
  const t = useTranslations("receive");
  const [lines, setLines] = useState<ReceiptLine[]>(initialLines);
  const [bin, setBin] = useState(initialBin);
  const [step, setStep] = useState<Step>(initialBin ? "product" : "bin");
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{
    tone: "bad" | "warn" | "good";
    text: string;
  } | null>(null);
  const [postedAs, setPostedAs] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const typedRef = useRef<HTMLInputElement>(null);

  const fail = useCallback((text: string) => {
    beepReject();
    setMessage({ tone: "bad", text });
  }, []);

  // Focus follows the step. This is the whole ergonomic promise of the screen:
  // the field that wants input is always the one that has focus.
  useEffect(() => {
    if (step === "qty" || step === "expiry" || step === "lot" || step === "serial") {
      typedRef.current?.focus();
      typedRef.current?.select();
    }
  }, [step, pending]);

  const [typed, setTyped] = useState("");

  /**
   * Move to a step and clear whatever was typed for the previous one.
   *
   * Done here rather than in an effect on `step`: clearing state inside an
   * effect triggers a second render pass for something that is really just
   * part of the transition.
   */
  const goTo = useCallback((next: Step) => {
    setTyped("");
    setStep(next);
  }, []);

  const resetLine = useCallback(() => {
    setPending(null);
    goTo("product");
  }, [goTo]);

  // ---------------------------------------------------------------- scanning

  const handleScan = useCallback(
    (event: { value: string }) => {
      setMessage(null);
      startTransition(async () => {
        const result = await scan(event.value);
        const r = result.resolution;

        if (step === "bin") {
          if (r.kind !== "location") return fail(t("notALocation"));
          beepAccept();
          setBin({ id: r.locationId, code: r.code });
          goTo("product");
          return;
        }

        // A location scanned during the product step means "change bin" — a
        // receiver moving to another shelf should not have to find a button.
        if (r.kind === "location") {
          beepAccept();
          setBin({ id: r.locationId, code: r.code });
          goTo("product");
          return;
        }

        if (r.kind === "unknown") return fail(t("notAProduct"));

        // A lot label resolves its product, which is how a drum with only a lot
        // sticker is received (D-35).
        const productId = r.kind === "lot" ? r.productId : r.productId;
        const next: Pending =
          r.kind === "lot"
            ? {
                productId,
                sku: r.sku,
                nameTh: r.nameTh,
                trackingMode: "lot",
                requiresQc: false,
                uomId: "",
                uomCode: "",
                hasOwnBarcode: true,
                lotNo: r.lotNo,
              }
            : {
                productId,
                sku: r.sku,
                nameTh: r.nameTh,
                trackingMode: r.trackingMode,
                requiresQc: r.requiresQc,
                uomId: r.uomId,
                uomCode: r.uomCode,
                hasOwnBarcode: r.hasOwnBarcode,
              };

        if (r.kind === "product" && r.requiresQc) beepWarn();
        else beepAccept();

        setPending(next);

        if (next.trackingMode === "lot") goTo(next.lotNo ? "expiry" : "lot");
        else if (next.trackingMode === "serial") goTo("serial");
        else goTo("qty");
      });
    },
    [step, t, fail, goTo],
  );

  // ------------------------------------------------------------ typed steps

  const submitLine = useCallback(
    (line: Pending, qty: number) => {
      if (!bin) return;
      startTransition(async () => {
        const result = await addLine({
          receiptId,
          productId: line.productId,
          locationId: bin.id,
          qty,
          uomId: line.uomId,
          lotNo: line.lotNo,
          expiryDate: line.expiryDate,
          serialNo: line.serialNo,
        });

        if (!result.ok) return fail(t(result.error));

        beepAccept();
        setLines((prev) => [...prev, result.data!]);
        setMessage(
          result.data!.toQcHold
            ? { tone: "warn", text: t("qcRouted") }
            : { tone: "good", text: t("lineAdded") },
        );
        resetLine();
      });
    },
    [bin, receiptId, t, fail, resetLine],
  );

  const commitTyped = useCallback(() => {
    if (!pending) return;

    if (step === "lot") {
      if (!typed.trim()) return fail(t("lotRequired"));
      setPending({ ...pending, lotNo: typed.trim() });
      goTo("expiry");
      return;
    }

    if (step === "expiry") {
      // Blank is allowed: the database defaults the expiry from the product's
      // shelf life, so Enter on an empty field is the fast path.
      setPending({ ...pending, expiryDate: typed.trim() || undefined });
      goTo("qty");
      return;
    }

    if (step === "serial") {
      if (!typed.trim()) return fail(t("serialRequired"));
      // A serial is one unit by definition, so quantity is never asked.
      submitLine({ ...pending, serialNo: typed.trim() }, 1);
      return;
    }

    if (step === "qty") {
      const qty = Number(typed);
      if (!Number.isFinite(qty) || qty <= 0) return fail(t("stepQty"));
      submitLine(pending, qty);
    }
  }, [pending, step, typed, t, fail, goTo, submitLine]);

  // ------------------------------------------------------------- post (F9)

  const post = useCallback(() => {
    if (lines.length === 0) return fail(t("noLines"));
    startTransition(async () => {
      const result = await postReceipt(receiptId);
      if (!result.ok) return fail(t(result.error));
      beepAccept();
      setPostedAs(result.data!);
      setLines([]);
    });
  }, [lines.length, receiptId, t, fail]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F9") {
        e.preventDefault();
        post();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        resetLine();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [post, resetLine]);

  // ------------------------------------------------------------------ view

  if (postedAs) {
    return (
      <Card className="flex flex-col items-start gap-4 px-6 py-8">
        <Banner tone="good">{t("posted", { docNo: postedAs })}</Banner>
        <Button onClick={() => window.location.reload()}>{t("newReceipt")}</Button>
      </Card>
    );
  }

  const typedStep =
    step === "lot" || step === "expiry" || step === "serial" || step === "qty";

  return (
    <div className="flex flex-col gap-4">
      {/* Destination is always visible: a receiver must never be unsure where
          the stock they are scanning is going. */}
      <div className="border-brand-border flex flex-wrap items-center justify-between gap-2 rounded-[10px] border bg-white px-4 py-3">
        <div className="flex flex-col">
          <SectionLabel>{t("currentBin")}</SectionLabel>
          <span className="text-brand-dark font-mono text-xl font-semibold">
            {bin?.code ?? "—"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => goTo("bin")}
          className="text-brand-brown text-sm"
        >
          {t("changeBin")}
        </button>
      </div>

      {/* Scanner is live except while a human is typing a value. */}
      <ScanField
        onScan={handleScan}
        label={step === "bin" ? t("stepBin") : t("stepProduct")}
        disabled={busy || typedStep}
        autoFocus={!typedStep}
      />

      {pending && typedStep && (
        <Card className="border-l-scan-ok flex flex-col gap-3 border-l-8 px-4 py-3 sm:px-6 sm:py-5">
          <div className="flex flex-col">
            <span className="text-brand-dark text-lg font-semibold">
              {pending.nameTh}
            </span>
            <span className="text-brand-muted font-mono text-xs">{pending.sku}</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {pending.lotNo && <Badge tone="info">{pending.lotNo}</Badge>}
              {pending.requiresQc && <Badge tone="warn">QC</Badge>}
              {pending.uomCode && <Badge tone="neutral">{pending.uomCode}</Badge>}
            </div>
          </div>

          <label className="text-brand-dark text-sm font-medium">
            {step === "lot" && t("stepLot")}
            {step === "expiry" && t("stepExpiry")}
            {step === "serial" && t("stepSerial")}
            {step === "qty" && t("stepQty")}
          </label>

          <input
            ref={typedRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTyped();
              }
            }}
            // A numeric keypad on mobile for quantity; a date field for expiry.
            type={step === "qty" ? "text" : step === "expiry" ? "date" : "text"}
            inputMode={step === "qty" ? "decimal" : undefined}
            placeholder={step === "qty" ? t("qtyPlaceholder") : undefined}
            autoComplete="off"
            className="border-brand-border text-brand-dark h-16 w-full rounded-md border-2 bg-white px-4 font-mono text-2xl"
          />

          {step === "expiry" && (
            <p className="text-brand-subtle text-xs">{t("expiryHint")}</p>
          )}

          {/* Day-one path for packaging and other unbarcoded goods (D-35).
              The scan matched the SKU, which means a shelf-edge label — so the
              receiver is told the flow is working as intended rather than
              wondering why no barcode was found, and is offered the label if
              the bin does not have one yet. */}
          {!pending.hasOwnBarcode && step === "qty" && (
            <div className="border-brand-border bg-warning-bg rounded-md border px-3 py-2">
              <p className="text-warning-text text-sm font-medium">
                {t("noBarcodePrompt")}
              </p>
              <p className="text-warning-text mt-1 text-xs">{t("noBarcodeHelp")}</p>
              <Link
                href={`/labels?kind=shelf&ids=${pending.productId}` as Route}
                target="_blank"
                className="text-brand-brown mt-1 inline-block text-xs font-medium underline"
              >
                {t("printShelfLabel")}
              </Link>
            </div>
          )}

          <button
            type="button"
            onClick={resetLine}
            className="text-brand-accent self-start text-xs"
          >
            {t("cancelLine")}
          </button>
        </Card>
      )}

      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <Card className="flex flex-col gap-3 px-4 py-3 sm:px-6 sm:py-5">
        <div className="flex items-baseline justify-between">
          <SectionLabel>{t("lines")}</SectionLabel>
          <span className="text-brand-subtle text-xs">
            {t("totalLines", { count: lines.length })}
          </span>
        </div>

        {lines.length === 0 ? (
          <p className="text-brand-muted text-sm">{t("noLines")}</p>
        ) : (
          <ul className="divide-brand-border/60 flex flex-col divide-y">
            {/* Newest first: the line just scanned is the one worth checking. */}
            {[...lines].reverse().map((line) => (
              <li key={line.id} className="flex items-center gap-3 py-2">
                <span className="text-brand-subtle tabular w-6 shrink-0 text-xs">
                  {line.lineNo}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-brand-dark truncate text-sm">{line.nameTh}</div>
                  <div className="text-brand-subtle flex flex-wrap gap-2 font-mono text-xs">
                    <span>{line.sku}</span>
                    {line.lotNo && <span>· {line.lotNo}</span>}
                    {line.serialNo && <span>· {line.serialNo}</span>}
                    <span>· {line.toLocationCode}</span>
                    {line.toQcHold && <Badge tone="warn">{t("toQcHold")}</Badge>}
                  </div>
                </div>
                <span className="tabular text-brand-dark shrink-0 text-base font-semibold">
                  {line.qty.toLocaleString()} {line.uomCode}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    startTransition(async () => {
                      await removeLine(line.id);
                      setLines((prev) => prev.filter((l) => l.id !== line.id));
                    })
                  }
                  className="text-brand-muted hover:text-destructive shrink-0 text-xs"
                >
                  {t("remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={post} disabled={busy || lines.length === 0}>
          {t("post")}
        </Button>
        <span className="text-brand-subtle text-xs">{t("postHint")}</span>
      </div>

      <p className="text-brand-subtle text-xs">{t("keyboardHelp")}</p>
    </div>
  );
}
