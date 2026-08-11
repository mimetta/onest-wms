import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Phase 1.1 health check — the dashboard proper is screen 1.7.
 *
 * This page exists to prove the whole stack end to end: a real session, RLS
 * letting this user read what their role allows, the derived-stock views
 * returning numbers, and the ledger balancing. If this page is right, the
 * foundation is wired correctly.
 */
export default async function HealthPage() {
  const user = await requireUser();
  const t = await getTranslations("health");
  const supabase = await createClient();

  // Every one of these reads goes through RLS as this user. A viewer sees the
  // same numbers; a user with no report.read would see nothing.
  const [products, locations, movements, onHandRows, openingRows] = await Promise.all([
    supabase.from("products").select("id", { count: "exact", head: true }),
    supabase.from("locations").select("id", { count: "exact", head: true }),
    supabase.from("stock_movements").select("id", { count: "exact", head: true }),
    supabase.from("stock_on_hand").select("qty, location_id"),
    supabase.from("locations").select("id").eq("type", "opening"),
  ]);

  const openingIds = new Set((openingRows.data ?? []).map((l) => l.id));
  const rows = onHandRows.data ?? [];

  const openingBalance = rows
    .filter((r) => openingIds.has(r.location_id as string))
    .reduce((sum, r) => sum + Number(r.qty), 0);

  const realBalance = rows
    .filter((r) => !openingIds.has(r.location_id as string))
    .reduce((sum, r) => sum + Number(r.qty), 0);

  // The ledger's own proof: opening balances are stock that predates the system,
  // so the OPENING bin holds the exact negative of everything in real bins
  // (D-21). If these ever stop cancelling, something is wrong at the foundation.
  const balanced = Math.abs(openingBalance + realBalance) < 0.0001;

  const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-brand-dark text-xl font-semibold">{t("title")}</h1>
        <p className="text-brand-muted text-sm">{t("subtitle")}</p>
      </header>

      <section className="border-brand-border rounded-[10px] border bg-white px-6 py-5">
        <h2 className="text-brand-subtle mb-4 text-xs font-semibold tracking-wider uppercase">
          {t("signedInAs")}
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t("signedInAs")} value={user.fullName} />
          <Field label={t("role")} value={user.role} mono />
          <Field label={t("warehouse")} value={user.warehouseCode ?? "—"} mono />
          <Field label={t("permissions")} value={String(user.permissions.size)} mono />
        </dl>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t("products")} value={fmt.format(products.count ?? 0)} />
        <Stat label={t("locations")} value={fmt.format(locations.count ?? 0)} />
        <Stat label={t("movements")} value={fmt.format(movements.count ?? 0)} />
        <Stat label={t("onHand")} value={fmt.format(realBalance)} />
      </section>

      <section
        className={
          balanced
            ? "border-brand-border bg-success-bg rounded-[10px] border px-6 py-5"
            : "border-brand-border bg-danger-bg rounded-[10px] border px-6 py-5"
        }
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span
            aria-hidden
            className={
              balanced
                ? "bg-brand-brown inline-block size-2.5 rounded-full"
                : "bg-destructive inline-block size-2.5 rounded-full"
            }
          />
          <span
            className={
              balanced
                ? "text-success-fg text-sm font-semibold"
                : "text-destructive text-sm font-semibold"
            }
          >
            {balanced ? t("ledgerBalanced") : t("ledgerUnbalanced")}
          </span>
          <span className="tabular text-brand-muted text-sm">
            {t("openingBin")} {fmt.format(openingBalance)} · {t("onHand")}{" "}
            {fmt.format(realBalance)}
          </span>
        </div>
        <p className="text-brand-muted mt-2 text-xs">{t("ledgerExplain")}</p>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-brand-subtle text-xs tracking-wider uppercase">{label}</dt>
      <dd
        className={
          mono
            ? "text-brand-dark font-mono text-sm"
            : "text-brand-dark text-sm font-medium"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-brand-border rounded-[10px] border bg-white px-6 py-5">
      <div className="text-brand-subtle text-xs tracking-wider uppercase">{label}</div>
      <div className="tabular text-brand-dark mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
