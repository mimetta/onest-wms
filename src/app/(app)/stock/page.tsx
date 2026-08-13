import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ScanExplorer } from "./scan-explorer";

/**
 * Stock explorer, scan-first.
 *
 * This is where the Phase 1.4 scan engine earns its keep: one field resolves a
 * product barcode, a bin barcode or a lot number, and shows what is on hand.
 * Screen 1.7 extends it with the full movement path; the resolution and capture
 * machinery is already in place.
 */
export default async function StockPage() {
  const user = await requirePerm("report.read");
  const t = await getTranslations("scan");
  const supabase = await createClient();

  // Loaded here rather than fetched on demand: the link form needs them only
  // when a scan fails, but under 500 SKUs this is a small payload and a
  // receiver holding an unknown barcode should not wait for a round trip.
  const [{ data: products }, { data: uoms }] = await Promise.all([
    supabase
      .from("products")
      .select("id, sku, name_th")
      .eq("is_active", true)
      .order("sku"),
    supabase.from("uoms").select("id, code, name_th").eq("is_active", true).order("code"),
  ]);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title={t("stockTitle")} subtitle={t("stockSubtitle")} />
      <ScanExplorer
        products={products ?? []}
        uoms={uoms ?? []}
        canLink={can(user, "goods_receipt.create") || can(user, "master_data.write")}
      />
    </div>
  );
}
