"use client";

import { useCallback, useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ScanField } from "@/components/scan/scan-field";
import { LinkBarcodeForm } from "./link-barcode-form";
import { beepAccept, beepReject, beepWarn } from "@/lib/audio/beep";
import { Badge, Banner, Card, SectionLabel, Table, Td, Th } from "@/components/ui";
import { scan, type ScanOutcome } from "./actions";
import type { ScanSource } from "@/hooks/use-scanner";

export function ScanExplorer({
  products,
  uoms,
  canLink,
}: {
  products: { id: string; sku: string; name_th: string }[];
  uoms: { id: string; code: string; name_th: string }[];
  canLink: boolean;
}) {
  const t = useTranslations("scan");
  const tq = useTranslations("qcStatus");
  const format = useFormatter();
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const [source, setSource] = useState<ScanSource | null>(null);
  const [pending, startTransition] = useTransition();

  const handleScan = useCallback((event: { value: string; source: ScanSource }) => {
    setSource(event.source);
    startTransition(async () => {
      const result = await scan(event.value);
      setOutcome(result);

      // Feedback happens the moment the answer arrives, and distinguishes three
      // states rather than two: found, found-but-restricted, and not found.
      if (result.resolution.kind === "unknown") {
        beepReject();
      } else if (
        result.resolution.kind === "lot" &&
        result.resolution.qcStatus !== "passed"
      ) {
        beepWarn();
      } else {
        beepAccept();
      }
    });
  }, []);

  const resolution = outcome?.resolution;
  const total = (outcome?.onHand ?? []).reduce((sum, row) => sum + row.qty, 0);

  return (
    <div className="flex flex-col gap-4">
      <ScanField onScan={handleScan} label={t("scanPrompt")} disabled={pending} />

      {source && (
        <p className="text-brand-subtle text-xs">
          {t("lastScan")}: {t(`source${source[0].toUpperCase()}${source.slice(1)}`)}
        </p>
      )}

      {resolution?.kind === "unknown" && (
        <div className="flex flex-col gap-3">
          {/* The scan-bad tone plus a red banner plus text: colour is never the
              only signal (D-25). */}
          <div className="border-brand-border bg-scan-bad-bg border-l-scan-bad rounded-[10px] border-2 border-l-8 px-4 py-3">
            <p className="text-scan-bad text-base font-semibold">{t("notFound")}</p>
            <p className="text-brand-muted mt-1 font-mono text-sm">{resolution.value}</p>
            <p className="text-brand-muted mt-1 text-sm">{t("notFoundHint")}</p>
          </div>

          {outcome?.capture?.checkDigitFailed && (
            <Banner tone="warn">{t("checkDigitWarning")}</Banner>
          )}

          {canLink && (
            <LinkBarcodeForm
              barcode={resolution.value}
              suggestion={outcome!.capture!}
              products={products}
              uoms={uoms}
              onLinked={() => handleScan({ value: resolution.value, source: "manual" })}
            />
          )}
        </div>
      )}

      {resolution && resolution.kind !== "unknown" && (
        <Card className="border-l-scan-ok flex flex-col gap-4 border-l-8 px-6 py-5">
          {resolution.kind === "product" && (
            <div className="flex flex-col gap-1">
              <SectionLabel>{t("product")}</SectionLabel>
              <p className="text-brand-dark text-xl font-semibold">{resolution.nameTh}</p>
              <p className="text-brand-muted font-mono text-sm">{resolution.sku}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge tone="info">{resolution.trackingMode}</Badge>
                {resolution.requiresQc && <Badge tone="warn">QC</Badge>}
                {/* Which unit this barcode meant matters: a case code is not a
                    piece, and the receiver needs to see that before typing a
                    quantity. */}
                <Badge tone="neutral">
                  {resolution.barcodeType} · {resolution.uomCode}
                </Badge>
              </div>
            </div>
          )}

          {resolution.kind === "location" && (
            <div className="flex flex-col gap-1">
              <SectionLabel>{t("location")}</SectionLabel>
              <p className="text-brand-dark font-mono text-xl font-semibold">
                {resolution.code}
              </p>
              {resolution.zoneName && (
                <p className="text-brand-muted text-sm">{resolution.zoneName}</p>
              )}
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge tone="neutral">{resolution.locationType}</Badge>
                {resolution.countsAsAvailable && <Badge tone="good">pickable</Badge>}
                {resolution.blocksConsumption && <Badge tone="bad">blocked</Badge>}
              </div>
            </div>
          )}

          {resolution.kind === "lot" && (
            <div className="flex flex-col gap-1">
              <SectionLabel>{t("lot")}</SectionLabel>
              <p className="text-brand-dark font-mono text-xl font-semibold">
                {resolution.lotNo}
              </p>
              <p className="text-brand-dark text-sm">{resolution.nameTh}</p>
              <p className="text-brand-muted font-mono text-xs">{resolution.sku}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge tone={resolution.qcStatus === "passed" ? "good" : "warn"}>
                  {tq(resolution.qcStatus)}
                </Badge>
                {resolution.expiryDate && (
                  <Badge tone="neutral">
                    {/* Formatted, not raw ISO: the Thai locale renders this in
                        Buddhist era, which is what the warehouse reads. */}
                    {format.dateTime(new Date(resolution.expiryDate), {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </Badge>
                )}
              </div>
              {resolution.qcStatus !== "passed" && (
                <p className="text-warning-text mt-2 text-sm font-medium">
                  {t("qcBlocked")}
                </p>
              )}
            </div>
          )}

          <div className="border-brand-border flex flex-col gap-2 border-t pt-4">
            <div className="flex items-baseline justify-between">
              <SectionLabel>{t("onHandAt")}</SectionLabel>
              <span className="tabular text-brand-dark text-lg font-semibold">
                {total.toLocaleString()}
              </span>
            </div>

            {outcome?.onHandError ? (
              /* An empty list and a failed query look identical to a user, so
                 they must not be rendered identically. */
              <Banner tone="bad">{t("stockLookupFailed")}</Banner>
            ) : !outcome?.onHand || outcome.onHand.length === 0 ? (
              <p className="text-brand-muted text-sm">{t("noStock")}</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <tr>
                      <Th>
                        {resolution.kind === "location" ? t("product") : t("location")}
                      </Th>
                      <Th>{t("lot")}</Th>
                      <Th>{t("qty")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {outcome.onHand.map((row, i) => (
                      <tr key={`${row.label}-${row.lotNo}-${i}`}>
                        <Td className="font-mono text-xs">{row.label}</Td>
                        <Td className="font-mono text-xs">{row.lotNo ?? "—"}</Td>
                        <Td className="tabular">{row.qty.toLocaleString()}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
