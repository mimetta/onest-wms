"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Banner, Button, Card, Field, SectionLabel, Select } from "@/components/ui";
import { submitDocument } from "@/app/(app)/documents/actions";
import { ensureDraft, removeLine, type IssueLine, type Requirement } from "../actions";
import { PickList } from "./pick-list";

export type RequisitionOption = {
  id: string;
  docNo: string | null;
  departmentId: string;
  departmentName: string;
  requirements: Requirement[];
};

export type ProductOption = {
  id: string;
  sku: string;
  nameTh: string;
  baseUomId: string;
  baseUomCode: string;
  trackingMode: "none" | "lot" | "serial";
};

/**
 * ใบเบิก — fulfil a requisition, or raise a direct issue.
 *
 * Two entry paths with one picking flow:
 *
 *  - against an approved requisition, which supplies the requirements
 *  - directly, for a manager, who names the products themselves (D-46)
 *
 * Either way the operator ends up at the same pick list, because the physical
 * job is identical and the difference is only where the list of what to fetch
 * came from.
 */
export function IssueBuilder({
  requisitions,
  products,
  departments,
  canIssueDirect,
}: {
  requisitions: RequisitionOption[];
  products: ProductOption[];
  departments: { id: string; nameTh: string }[];
  canIssueDirect: boolean;
}) {
  const t = useTranslations("issues");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [mode, setMode] = useState<"requisition" | "direct">(
    requisitions.length > 0 || !canIssueDirect ? "requisition" : "direct",
  );
  const [requisitionId, setRequisitionId] = useState(requisitions[0]?.id ?? "");
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? "");

  const [draftId, setDraftId] = useState<string | null>(null);
  const [lines, setLines] = useState<IssueLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // For a direct issue the operator builds the requirement list themselves.
  const [directItems, setDirectItems] = useState<Requirement[]>([]);
  const [directProductId, setDirectProductId] = useState("");
  const [directQty, setDirectQty] = useState("");

  const requisition = requisitions.find((r) => r.id === requisitionId) ?? null;
  const effectiveDeptId =
    mode === "requisition" ? (requisition?.departmentId ?? "") : departmentId;

  // How much of each product has been picked so far, so a part-picked line
  // reduces rather than disappearing.
  const pickedByProduct = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of lines) {
      // Lines carry the SKU rather than the product id, which is enough to
      // aggregate against the requirement list.
      map.set(line.sku, (map.get(line.sku) ?? 0) + line.qty);
    }
    return map;
  }, [lines]);

  const requirements: Requirement[] = useMemo(() => {
    const base = mode === "requisition" ? (requisition?.requirements ?? []) : directItems;
    return base.map((r) => ({ ...r, qtyPicked: pickedByProduct.get(r.sku) ?? 0 }));
  }, [mode, requisition, directItems, pickedByProduct]);

  useEffect(() => {
    if (!effectiveDeptId) return;
    if (mode === "requisition" && !requisitionId) return;

    let cancelled = false;
    void (async () => {
      const result = await ensureDraft(
        effectiveDeptId,
        mode === "requisition" ? requisitionId : null,
      );
      if (cancelled) return;
      if (result.ok && result.data) setDraftId(result.data);
      else if (!result.ok) setError(result.detail ?? t(result.error));
    })();

    return () => {
      cancelled = true;
    };
  }, [effectiveDeptId, mode, requisitionId, t]);

  const handleAddDirectItem = () => {
    const product = products.find((p) => p.id === directProductId);
    const amount = Number(directQty);
    if (!product || !(amount > 0)) return;

    setDirectItems((prev) => [
      ...prev,
      {
        productId: product.id,
        sku: product.sku,
        nameTh: product.nameTh,
        baseUomId: product.baseUomId,
        baseUomCode: product.baseUomCode,
        trackingMode: product.trackingMode,
        qtyRequested: amount,
        qtyPicked: 0,
      },
    ]);
    setDirectProductId("");
    setDirectQty("");
  };

  const handleSubmit = async () => {
    if (!draftId) return;
    setBusy(true);
    setError(null);

    // Submitted, not approved: an issue needs a manager (D-20), and this screen
    // is used by warehouse staff who do not hold issue.approve. Offering them an
    // Approve button here would only produce a permission error.
    const result = await submitDocument("issue", draftId);
    setBusy(false);

    if (!result.ok) {
      setError(result.detail ?? t(result.error));
      return;
    }

    startTransition(() => router.push(`/issues/${draftId}`));
  };

  const handleRemove = async (lineId: string) => {
    const result = await removeLine(lineId);
    if (result.ok) setLines((prev) => prev.filter((l) => l.id !== lineId));
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("issueAgainst")}</SectionLabel>

        {canIssueDirect && (
          <div className="flex gap-2">
            <Button
              variant={mode === "requisition" ? "primary" : "secondary"}
              onClick={() => setMode("requisition")}
              disabled={lines.length > 0}
            >
              {t("fromRequisition")}
            </Button>
            <Button
              variant={mode === "direct" ? "primary" : "secondary"}
              onClick={() => setMode("direct")}
              disabled={lines.length > 0}
            >
              {t("directIssue")}
            </Button>
          </div>
        )}

        {mode === "requisition" ? (
          requisitions.length === 0 ? (
            <Banner tone="info">{t("noApprovedRequisitions")}</Banner>
          ) : (
            <Field label={t("requisition")}>
              <Select
                value={requisitionId}
                onChange={(e) => setRequisitionId(e.target.value)}
                disabled={lines.length > 0}
              >
                {requisitions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.docNo ?? "—"} · {r.departmentName}
                  </option>
                ))}
              </Select>
            </Field>
          )
        ) : (
          <>
            <Field label={t("department")}>
              <Select
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
                disabled={lines.length > 0}
              >
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.nameTh}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid gap-3 sm:grid-cols-[3fr_1fr_auto] sm:items-end">
              <Field label={t("product")}>
                <Select
                  value={directProductId}
                  onChange={(e) => setDirectProductId(e.target.value)}
                >
                  <option value="">{t("choose")}</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sku} · {p.nameTh}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("qty")}>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={directQty}
                  onChange={(e) => setDirectQty(e.target.value)}
                  className="border-brand-border text-brand-dark h-9 w-full rounded-md border bg-white px-3 text-sm"
                />
              </Field>
              <Button variant="secondary" onClick={handleAddDirectItem}>
                {t("addItem")}
              </Button>
            </div>
          </>
        )}
      </Card>

      {error && <Banner tone="bad">{error}</Banner>}

      {draftId &&
        requirements.map((req) => (
          <PickList
            key={req.productId}
            issueId={draftId}
            requirement={req}
            onLineAdded={(line) => setLines((prev) => [...prev, line])}
          />
        ))}

      {lines.length > 0 && (
        <Card className="flex flex-col gap-2">
          <SectionLabel>{t("pickedLines", { count: lines.length })}</SectionLabel>
          <ul className="divide-brand-border/60 flex flex-col divide-y">
            {lines.map((l) => (
              <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <span className="text-brand-subtle w-6 text-xs">{l.lineNo}</span>
                <span className="text-brand-dark font-mono text-xs">{l.sku}</span>
                <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
                  {l.nameTh}
                </span>
                <span className="text-brand-muted font-mono text-xs">
                  {l.fromLocationCode}
                </span>
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
        <Button onClick={() => void handleSubmit()} disabled={busy || lines.length === 0}>
          {t("submitForApproval")}
        </Button>
      </div>
    </div>
  );
}
