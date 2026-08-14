import Link from "next/link";
import type { Route } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, PageHeader, SectionLabel } from "@/components/ui";
import { ActivityFeed, type ActivityRow } from "./activity-feed";

/**
 * Dashboard v1.
 *
 * Two of these panels are not decoration. Goods receipts post with no separate
 * approver (D-22), so "receipts posted today" and the live activity feed ARE
 * the review — they move the check from before the fact to after it. Everything
 * else on this page is context.
 */
export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations("dashboard");
  const format = await getFormatter();
  const supabase = await createClient();

  const [
    { data: byProduct },
    { data: expiry },
    { data: velocity },
    { data: recentMovements },
    { count: qcWaiting },
  ] = await Promise.all([
    supabase
      .from("stock_by_product")
      .select(
        "qty_on_hand, qty_available, qty_in_transit, qty_in_qc, qty_at_consignment",
      ),
    supabase
      .from("expiry_horizon")
      .select("bucket, qty, product_name_th, lot_no, days_to_expiry"),
    supabase
      .from("movement_velocity")
      .select("product_id, qty_out_90d, last_movement_at")
      .order("qty_out_90d", { ascending: false })
      .limit(5),
    supabase
      .from("stock_movement_path")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(30),
    supabase
      .from("lots")
      .select("id", { count: "exact", head: true })
      .eq("qc_status", "pending_qc"),
  ]);

  const totals = (byProduct ?? []).reduce(
    (acc, row) => ({
      onHand: acc.onHand + Number(row.qty_on_hand ?? 0),
      available: acc.available + Number(row.qty_available ?? 0),
      inQc: acc.inQc + Number(row.qty_in_qc ?? 0),
      inTransit: acc.inTransit + Number(row.qty_in_transit ?? 0),
      atConsignment: acc.atConsignment + Number(row.qty_at_consignment ?? 0),
    }),
    { onHand: 0, available: 0, inQc: 0, inTransit: 0, atConsignment: 0 },
  );

  // Receipts posted today, in Bangkok days — the same definition the rest of
  // the system uses (D-31), not the server's midnight.
  const todayBangkok = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Bangkok",
  });

  const { data: todayReceipts } = await supabase
    .from("goods_receipts")
    .select("id, doc_no, posted_at, partners(name_th), goods_receipt_lines(count)")
    .eq("status", "posted")
    .gte("posted_at", `${todayBangkok}T00:00:00+07:00`)
    .order("posted_at", { ascending: false });

  const receipts = (todayReceipts ?? []).map((r) => {
    const partner = r.partners as unknown as { name_th: string } | null;
    const lines = r.goods_receipt_lines as unknown as { count: number }[] | null;
    return {
      id: r.id,
      docNo: r.doc_no as string,
      postedAt: r.posted_at as string,
      partner: partner?.name_th ?? null,
      lines: lines?.[0]?.count ?? 0,
    };
  });

  const activity: ActivityRow[] = (recentMovements ?? []).map((row) => ({
    id: Number(row.movement_id),
    occurredAt: row.occurred_at,
    sku: row.sku,
    productName: row.product_name_th,
    qty: Number(row.qty),
    uomCode: row.uom_code,
    fromCode: row.from_location_code,
    toCode: row.to_location_code,
    documentType: row.document_type,
    userName: row.user_name,
  }));

  const buckets = ["expired", "within_30", "within_60", "within_90"] as const;
  const expiryByBucket = buckets.map((bucket) => ({
    bucket,
    qty: (expiry ?? [])
      .filter((e) => e.bucket === bucket)
      .reduce((sum, e) => sum + Number(e.qty), 0),
    lots: (expiry ?? []).filter((e) => e.bucket === bucket).length,
  }));

  const bucketLabel: Record<(typeof buckets)[number], string> = {
    expired: t("expired"),
    within_30: t("within30"),
    within_60: t("within60"),
    within_90: t("within90"),
  };

  const productIds = (velocity ?? []).map((v) => v.product_id);
  const { data: moverProducts } = productIds.length
    ? await supabase.from("products").select("id, sku, name_th").in("id", productIds)
    : { data: [] as { id: string; sku: string; name_th: string }[] };
  const productById = new Map((moverProducts ?? []).map((p) => [p.id, p]));

  const fmt = (n: number) => format.number(n, { maximumFractionDigits: 0 });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label={t("onHand")} value={fmt(totals.onHand)} />
        <Stat label={t("available")} value={fmt(totals.available)} tone="good" />
        <Stat label={t("inQc")} value={fmt(totals.inQc)} tone="warn" />
        <Stat label={t("inTransit")} value={fmt(totals.inTransit)} />
        <Stat label={t("atConsignment")} value={fmt(totals.atConsignment)} />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* D-22 compensating control, part one. */}
        <Card className="flex flex-col gap-3 px-6 py-5">
          <div className="flex items-baseline justify-between gap-2">
            <SectionLabel>{t("receiptsToday")}</SectionLabel>
            <span className="tabular text-brand-dark text-lg font-semibold">
              {receipts.length}
            </span>
          </div>
          <p className="text-brand-subtle text-xs">{t("receiptsTodayHint")}</p>

          {receipts.length === 0 ? (
            <p className="text-brand-muted text-sm">{t("noReceiptsToday")}</p>
          ) : (
            <ul className="divide-brand-border/60 flex flex-col divide-y">
              {receipts.map((r) => (
                <li key={r.id} className="flex items-baseline gap-3 py-2">
                  <span className="text-brand-dark font-mono text-xs">{r.docNo}</span>
                  <span className="text-brand-muted min-w-0 flex-1 truncate text-sm">
                    {r.partner ?? "—"}
                  </span>
                  <span className="text-brand-subtle text-xs">
                    {t("lineCount", { count: r.lines })}
                  </span>
                  <span className="text-brand-subtle text-xs">
                    {format.dateTime(new Date(r.postedAt), {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* D-22 compensating control, part two. */}
        <Card className="flex flex-col gap-3 px-6 py-5">
          <SectionLabel>{t("activity")}</SectionLabel>
          <ActivityFeed initial={activity} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-3 px-6 py-5">
          <div className="flex items-baseline justify-between gap-2">
            <SectionLabel>{t("expiryTimeline")}</SectionLabel>
            <Link href="/qc" className="text-brand-brown text-xs">
              {t("qcWaiting")}: {qcWaiting ?? 0}
            </Link>
          </div>

          {expiryByBucket.every((b) => b.lots === 0) ? (
            <p className="text-brand-muted text-sm">{t("noExpiring")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {expiryByBucket.map((b) => (
                <li key={b.bucket} className="flex items-center gap-3">
                  <Badge tone={b.bucket === "expired" ? "bad" : "warn"}>
                    {bucketLabel[b.bucket]}
                  </Badge>
                  <span className="text-brand-muted text-xs">
                    {b.lots} · {fmt(b.qty)}
                  </span>
                  {/* A bar rather than a number alone: relative size is the
                      question here — "is the 30-day bucket bigger than usual?" */}
                  <span className="bg-brand-cream h-2 min-w-0 flex-1 overflow-hidden rounded">
                    <span
                      className={
                        b.bucket === "expired"
                          ? "bg-destructive block h-full"
                          : "bg-warning-fg block h-full"
                      }
                      style={{
                        width: `${Math.min(
                          100,
                          (b.qty / Math.max(1, ...expiryByBucket.map((x) => x.qty))) *
                            100,
                        )}%`,
                      }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="flex flex-col gap-3 px-6 py-5">
          <SectionLabel>{t("movers")}</SectionLabel>
          {!velocity || velocity.length === 0 ? (
            <p className="text-brand-muted text-sm">{t("noMovement")}</p>
          ) : (
            <ul className="divide-brand-border/60 flex flex-col divide-y">
              {velocity.map((v) => {
                const product = productById.get(v.product_id);
                return (
                  <li key={v.product_id} className="flex items-baseline gap-3 py-2">
                    <span className="text-brand-subtle font-mono text-xs">
                      {product?.sku ?? "—"}
                    </span>
                    <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
                      {product?.name_th ?? ""}
                    </span>
                    <span className="tabular text-brand-dark text-sm font-semibold">
                      {fmt(Number(v.qty_out_90d ?? 0))}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card className="flex flex-col gap-1 px-6 py-5">
        <SectionLabel>{t("alerts")}</SectionLabel>
        <p className="text-brand-muted text-sm">{t("alertsPlaceholder")}</p>
      </Card>

      <p className="text-brand-subtle text-xs">
        {user.warehouseCode} ·{" "}
        <Link href={"/stock" as Route} className="text-brand-brown">
          {t("viewAll")}
        </Link>
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn";
}) {
  return (
    <Card className="px-6 py-5">
      <div className="text-brand-subtle text-xs tracking-wider uppercase">{label}</div>
      <div
        className={
          tone === "good"
            ? "tabular text-success-fg mt-1 text-2xl font-semibold"
            : tone === "warn"
              ? "tabular text-warning-text mt-1 text-2xl font-semibold"
              : "tabular text-brand-dark mt-1 text-2xl font-semibold"
        }
      >
        {value}
      </div>
    </Card>
  );
}
