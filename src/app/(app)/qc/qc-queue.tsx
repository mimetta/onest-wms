"use client";

import Link from "next/link";
import type { Route } from "next";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Badge, Banner, Button, Card, Input, Select } from "@/components/ui";
import { beepAccept, beepReject } from "@/lib/audio/beep";
import { scrapLot, setQcStatus } from "./actions";

export type QcLot = {
  id: string;
  lotNo: string;
  sku: string;
  nameTh: string;
  qcStatus: string;
  expiryDate: string | null;
  waitingDays: number;
  onHand: number;
  locations: string[];
};

type Confirming =
  | { kind: "status"; lotId: string; status: "passed" | "failed" | "quarantined" }
  | { kind: "scrap"; lotId: string }
  | null;

export function QcQueue({
  lots,
  reasons,
  canDecide,
  canScrap,
  canApproveScrap,
}: {
  lots: QcLot[];
  reasons: { id: string; nameTh: string }[];
  canDecide: boolean;
  canScrap: boolean;
  /** False for `qc`, who raises a write-off but cannot approve it (D-20). */
  canApproveScrap: boolean;
}) {
  const t = useTranslations("qc");
  const tq = useTranslations("qcStatus");
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [note, setNote] = useState("");
  const [reasonId, setReasonId] = useState(reasons[0]?.id ?? "");
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(
    null,
  );
  const [busy, startTransition] = useTransition();

  function close() {
    setConfirming(null);
    setNote("");
  }

  function decide(lotId: string, status: "passed" | "failed" | "quarantined") {
    startTransition(async () => {
      const result = await setQcStatus(lotId, status, note);
      if (!result.ok) {
        beepReject();
        setMessage({ tone: "bad", text: t(result.error) });
        return;
      }
      beepAccept();
      setMessage({ tone: "good", text: t("decisionSaved") });
      close();
    });
  }

  function scrap(lotId: string) {
    startTransition(async () => {
      const result = await scrapLot(lotId, reasonId);
      if (!result.ok) {
        beepReject();
        setMessage({ tone: "bad", text: t(result.error) });
        return;
      }
      beepAccept();
      setMessage({
        tone: "good",
        text: result.awaitingApproval
          ? t("scrapAwaitingApproval")
          : t("scrapped", { docNo: result.docNo ?? "" }),
      });
      close();
    });
  }

  if (lots.length === 0) {
    return (
      <Card className="px-6 py-12 text-center">
        <p className="text-brand-muted text-sm">{t("queueEmpty")}</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {message && <Banner tone={message.tone}>{message.text}</Banner>}

      <ul className="flex flex-col gap-3">
        {lots.map((lot) => {
          const isConfirming =
            confirming && "lotId" in confirming && confirming.lotId === lot.id;

          return (
            <Card key={lot.id} className="flex flex-col gap-3 px-6 py-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-brand-dark font-mono text-lg font-semibold">
                    {lot.lotNo}
                  </span>
                  <span className="text-brand-dark text-sm">{lot.nameTh}</span>
                  <span className="text-brand-subtle font-mono text-xs">{lot.sku}</span>
                </div>

                <div className="flex flex-col items-end gap-1">
                  {/* Age is the number that matters in a QC queue: a lot sitting
                      for a week is the problem, not the newest arrival. */}
                  <span
                    className={
                      lot.waitingDays >= 3
                        ? "text-warning-text text-sm font-semibold"
                        : "text-brand-muted text-sm"
                    }
                  >
                    {lot.waitingDays === 0
                      ? t("waitingToday")
                      : t("waiting", { days: lot.waitingDays })}
                  </span>
                  <Badge tone={lot.qcStatus === "passed" ? "good" : "warn"}>
                    {tq(lot.qcStatus)}
                  </Badge>
                </div>
              </div>

              <div className="text-brand-muted flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span>
                  {t("onHand")}{" "}
                  <span className="tabular text-brand-dark font-semibold">
                    {lot.onHand.toLocaleString()}
                  </span>
                </span>
                {lot.locations.length > 0 && (
                  <span className="font-mono text-xs">
                    {t("atLocations")} {lot.locations.join(", ")}
                  </span>
                )}
                {lot.expiryDate && (
                  <span className="text-xs">
                    {t("expiry")} {lot.expiryDate}
                  </span>
                )}
              </div>

              {isConfirming ? (
                <div className="border-brand-border flex flex-col gap-3 border-t pt-3">
                  {confirming.kind === "status" && (
                    <>
                      <p className="text-brand-dark text-sm font-medium">
                        {confirming.status === "passed" && t("confirmPass")}
                        {confirming.status === "failed" && t("confirmFail")}
                        {confirming.status === "quarantined" && t("confirmQuarantine")}
                      </p>
                      <p className="text-brand-subtle text-xs">
                        {confirming.status === "passed"
                          ? t("effectPass")
                          : t("effectFail")}
                      </p>
                      <Input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder={t("notePlaceholder")}
                      />
                      <div className="flex gap-2">
                        <Button
                          onClick={() => decide(lot.id, confirming.status)}
                          disabled={busy}
                        >
                          {t("confirm")}
                        </Button>
                        <Button variant="secondary" onClick={close} disabled={busy}>
                          {t("cancel")}
                        </Button>
                      </div>
                    </>
                  )}

                  {confirming.kind === "scrap" && (
                    <>
                      <p className="text-destructive text-sm font-medium">
                        {t("confirmScrap")}
                      </p>
                      {/* Said before the click, not after: a QC user needs to
                          know this leaves the shelf until a manager approves
                          (D-20). */}
                      {!canApproveScrap && (
                        <p className="text-warning-text text-xs">
                          {t("scrapNeedsApproval")}
                        </p>
                      )}
                      <label className="text-brand-dark text-sm font-medium">
                        {t("scrapReason")}
                      </label>
                      <Select
                        value={reasonId}
                        onChange={(e) => setReasonId(e.target.value)}
                      >
                        {reasons.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.nameTh}
                          </option>
                        ))}
                      </Select>
                      <div className="flex gap-2">
                        <Button
                          variant="danger"
                          onClick={() => scrap(lot.id)}
                          disabled={busy || !reasonId}
                        >
                          {t("confirm")}
                        </Button>
                        <Button variant="secondary" onClick={close} disabled={busy}>
                          {t("cancel")}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="border-brand-border flex flex-wrap gap-2 border-t pt-3">
                  {canDecide && lot.qcStatus !== "passed" && (
                    <Button
                      onClick={() =>
                        setConfirming({ kind: "status", lotId: lot.id, status: "passed" })
                      }
                    >
                      {t("pass")}
                    </Button>
                  )}
                  {canDecide && lot.qcStatus !== "failed" && (
                    <Button
                      variant="danger"
                      onClick={() =>
                        setConfirming({ kind: "status", lotId: lot.id, status: "failed" })
                      }
                    >
                      {t("fail")}
                    </Button>
                  )}
                  {canDecide && lot.qcStatus === "pending_qc" && (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        setConfirming({
                          kind: "status",
                          lotId: lot.id,
                          status: "quarantined",
                        })
                      }
                    >
                      {t("quarantine")}
                    </Button>
                  )}

                  {/* Write-off is offered only where it is possible: a lot that
                      has not passed, that still has stock, for a user holding
                      lot.dispose_unpassed (D-14). */}
                  {canScrap && lot.qcStatus !== "passed" && lot.onHand > 0 && (
                    <Button
                      variant="danger"
                      onClick={() => setConfirming({ kind: "scrap", lotId: lot.id })}
                    >
                      {t("scrap")}
                    </Button>
                  )}

                  <Link
                    href={`/labels?kind=lot&ids=${lot.id}` as Route}
                    className="border-brand-border text-brand-dark hover:bg-brand-cream inline-flex h-9 items-center rounded-md border px-4 text-sm"
                  >
                    {t("printLabel")}
                  </Link>
                </div>
              )}
            </Card>
          );
        })}
      </ul>
    </div>
  );
}
