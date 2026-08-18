"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Banner, Button, Input } from "@/components/ui";
import {
  approveDocument,
  cancelDocument,
  postDocument,
  submitDocument,
} from "@/app/(app)/documents/actions";
import { STATUS_TONE, type DocStatus, type DocType } from "@/lib/documents/config";

/**
 * The workflow controls for one document, driven by its status and the viewer's
 * permissions.
 *
 * Only the legal next steps are offered. A draft shows Submit; a submitted
 * document shows Approve to someone who may approve it and nothing to anyone
 * else; an approved document shows Post. The RPCs enforce all of this anyway —
 * this is about not presenting a warehouse user with a button that exists only
 * to tell them no.
 *
 * `canApprove` and `canPost` are computed on the SERVER and passed in, so a
 * user's permission set is never shipped to the browser to be filtered there.
 */
export function WorkflowBar({
  type,
  id,
  status,
  docNo,
  lineCount,
  canApprove,
  canPost,
  isAuthor,
  /** Second post confirms receipt of a cross-warehouse transfer (D-44). */
  postLabelKey,
}: {
  type: DocType;
  id: string;
  status: DocStatus;
  docNo: string | null;
  lineCount: number;
  canApprove: boolean;
  canPost: boolean;
  isAuthor: boolean;
  postLabelKey?: string;
}) {
  const t = useTranslations("workflow");
  const tStatus = useTranslations("status");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(
    null,
  );
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");

  const working = pending || busy;

  const run = async (fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => {
    setBusy(true);
    setMessage(null);
    const result = await fn();
    setBusy(false);

    if (!result.ok) {
      // The detail is the database's own sentence. It is shown rather than
      // swallowed: "insufficient stock: bin A-01-01 holds 3, need 10" tells the
      // operator what to do next, and a generic failure message does not.
      setMessage({ tone: "bad", text: result.detail ?? t(result.error ?? "failed") });
      return;
    }

    setMessage({ tone: "good", text: t("done") });
    startTransition(() => router.refresh());
  };

  const empty = lineCount === 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[status]}>{tStatus(status)}</Badge>
        {docNo && (
          <span className="text-brand-dark font-mono text-sm font-semibold">{docNo}</span>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {status === "draft" && isAuthor && (
            <Button
              onClick={() => run(() => submitDocument(type, id))}
              disabled={working || empty}
              variant="secondary"
            >
              {t("submit")}
            </Button>
          )}

          {(status === "draft" || status === "submitted") && canApprove && (
            <Button
              onClick={() => run(() => approveDocument(type, id))}
              disabled={working || empty}
            >
              {t("approve")}
            </Button>
          )}

          {(status === "approved" || status === "dispatched") && canPost && (
            <Button
              onClick={() => run(() => postDocument(type, id))}
              disabled={working || empty}
            >
              {t(postLabelKey ?? "post")}
            </Button>
          )}

          {status !== "posted" && status !== "cancelled" && (
            <Button variant="danger" onClick={() => setCancelling((v) => !v)}>
              {t("cancel")}
            </Button>
          )}
        </div>
      </div>

      {empty && status === "draft" && (
        <p className="text-brand-subtle text-xs">{t("addLinesFirst")}</p>
      )}

      {cancelling && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label className="text-brand-dark text-sm font-medium">
              {t("cancelReason")}
            </label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("cancelReasonHint")}
            />
          </div>
          <Button
            variant="danger"
            disabled={working || !reason.trim()}
            onClick={() =>
              run(async () => {
                const r = await cancelDocument(type, id, reason);
                if (r.ok) {
                  setCancelling(false);
                  setReason("");
                }
                return r;
              })
            }
          >
            {t("confirmCancel")}
          </Button>
        </div>
      )}

      {message && <Banner tone={message.tone}>{message.text}</Banner>}
    </div>
  );
}
