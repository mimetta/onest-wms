import Link from "next/link";
import type { Route } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { can, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { QcQueue, type QcLot } from "./qc-queue";

const TABS = ["pending_qc", "failed", "quarantined", "passed"] as const;
type Tab = (typeof TABS)[number];

/**
 * QC review queue.
 *
 * The other half of the receiving story: receiving routes QC-required stock to
 * the hold bin (screen 1.5), and this is where it is released or rejected.
 *
 * Includes the write-off action, which is the point of D-14 — without it a
 * failed lot is visible, unusable and unremovable, which is worse than not
 * having a QC gate at all.
 */
export default async function QcPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await requireUser();
  const t = await getTranslations("qc");
  const tq = await getTranslations("qcStatus");
  const format = await getFormatter();
  const { status } = await searchParams;

  const tab: Tab = TABS.includes(status as Tab) ? (status as Tab) : "pending_qc";
  const supabase = await createClient();

  // lot_qc_queue does the age arithmetic in Bangkok days and the stock roll-up,
  // so this screen and the Phase 3 alert cannot disagree about either (D-31).
  const { data: rows, count } = await supabase
    .from("lot_qc_queue")
    .select("*", { count: "exact" })
    .eq("qc_status", tab)
    // Longest waiting first while triaging; newest first when reviewing history.
    .order("created_at", { ascending: tab === "pending_qc" })
    .limit(100);

  const { data: reasons } = await supabase
    .from("adjustment_reasons")
    .select("id, name_th")
    .eq("is_disposal", true)
    .eq("is_active", true)
    .order("code");

  const lots: QcLot[] = (rows ?? []).map((row) => ({
    id: row.lot_id,
    lotNo: row.lot_no,
    sku: row.sku,
    nameTh: row.product_name_th,
    qcStatus: row.qc_status,
    expiryDate: row.expiry_date
      ? format.dateTime(new Date(row.expiry_date), {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null,
    waitingDays: Number(row.waiting_days ?? 0),
    onHand: Number(row.qty_on_hand ?? 0),
    locations: (row.location_codes ?? []) as string[],
  }));

  const tabLabel: Record<Tab, string> = {
    pending_qc: t("tabPending"),
    failed: t("tabFailed"),
    quarantined: t("tabQuarantined"),
    passed: t("tabPassed"),
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title={t("title")}
        subtitle={tab === "pending_qc" ? t("oldestFirst") : t("subtitle")}
      />

      <nav className="border-brand-border flex gap-1 overflow-x-auto border-b">
        {TABS.map((value) => (
          <Link
            key={value}
            href={(value === "pending_qc" ? "/qc" : `/qc?status=${value}`) as Route}
            className={
              value === tab
                ? "border-brand-brown text-brand-dark -mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold whitespace-nowrap"
                : "text-brand-muted hover:text-brand-dark -mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap"
            }
          >
            {tabLabel[value]}
          </Link>
        ))}
      </nav>

      <p className="text-brand-subtle text-xs">
        {t("count", { count: count ?? 0 })} · {tq(tab)}
      </p>

      <QcQueue
        lots={lots}
        reasons={(reasons ?? []).map((r) => ({ id: r.id, nameTh: r.name_th }))}
        canDecide={can(user, "lot.set_qc_status")}
        canScrap={can(user, "lot.dispose_unpassed") && can(user, "adjustment.create")}
        canApproveScrap={can(user, "adjustment.approve") && can(user, "adjustment.post")}
      />
    </div>
  );
}
