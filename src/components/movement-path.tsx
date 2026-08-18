"use client";

import { useFormatter, useTranslations } from "next-intl";
import type { MovementRow } from "@/app/(app)/stock/actions";

/**
 * The movement path — every hop, who, when, which document.
 *
 * This is the payoff of the from/to movement shape (D-02). Because one physical
 * hop is one row, history reads as a path:
 *
 *   outside → QC-HOLD-01 → IN-TRANSIT → PICK-01 → outside
 *
 * A signed-quantity ledger would show the same information as pairs of
 * half-entries the reader has to reassemble mentally.
 */
export function MovementPath({ movements }: { movements: MovementRow[] }) {
  const t = useTranslations("scan");
  const format = useFormatter();

  if (movements.length === 0) {
    return <p className="text-brand-muted text-sm">{t("noMovements")}</p>;
  }

  return (
    <ol className="divide-brand-border/60 flex flex-col divide-y">
      {movements.map((m) => (
        <li
          key={m.id}
          className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 sm:py-2"
        >
          <span className="text-brand-subtle order-1 shrink-0 text-xs sm:w-32">
            {format.dateTime(new Date(m.occurredAt), {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>

          {/* The hop itself, reading left to right. A null endpoint means the
              stock entered or left the company. */}
          <span className="order-3 flex min-w-0 basis-full items-baseline gap-1.5 font-mono text-xs sm:order-2 sm:basis-auto">
            <span className={m.fromCode ? "text-brand-dark" : "text-brand-subtle italic"}>
              {m.fromCode ?? t("external")}
            </span>
            <span aria-hidden className="text-brand-subtle">
              →
            </span>
            <span className={m.toCode ? "text-brand-dark" : "text-brand-subtle italic"}>
              {m.toCode ?? t("external")}
            </span>
          </span>

          <span className="tabular text-brand-dark order-2 ml-auto shrink-0 text-sm font-semibold sm:order-3 sm:ml-0">
            {m.qty.toLocaleString()} {m.uomCode}
          </span>

          {m.lotNo && (
            <span className="text-brand-subtle font-mono text-xs">{m.lotNo}</span>
          )}
          {m.serialNo && (
            <span className="text-brand-subtle font-mono text-xs">{m.serialNo}</span>
          )}

          <span className="text-brand-muted order-4 basis-full text-xs sm:ml-auto sm:basis-auto">
            {m.documentType} · {t("by")} {m.userName}
          </span>
        </li>
      ))}
    </ol>
  );
}
