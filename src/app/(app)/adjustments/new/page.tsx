import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, PageHeader } from "@/components/ui";
import { AdjustmentClient, type ProductOption } from "./adjustment-client";
import type { ReasonOption } from "../actions";

export default async function Page() {
  const user = await requirePerm("adjustment.create");
  const t = await getTranslations("adjustments");
  const supabase = await createClient();

  const [{ data: reasonRows }, { data: productRows }] = await Promise.all([
    supabase
      .from("adjustment_reasons")
      .select("id, code, name_th, direction, is_disposal")
      .eq("is_active", true)
      .order("code"),
    supabase
      .from("products")
      .select("id, sku, name_th, base_uom_id, tracking_mode, uoms:base_uom_id(code)")
      .eq("is_active", true)
      .order("sku"),
  ]);

  const reasons: ReasonOption[] = (reasonRows ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    nameTh: r.name_th,
    direction: r.direction as "increase" | "decrease" | "both",
    isDisposal: r.is_disposal,
  }));

  const products: ProductOption[] = (productRows ?? []).map((p) => ({
    id: p.id,
    sku: p.sku,
    nameTh: p.name_th,
    baseUomId: p.base_uom_id,
    baseUomCode: (p.uoms as unknown as { code: string } | null)?.code ?? "",
    trackingMode: p.tracking_mode as "none" | "lot" | "serial",
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("newTitle")} subtitle={t("newSubtitle")} />

      {reasons.length === 0 ? (
        // Without reason codes an adjustment cannot say why stock changed, which
        // is the only thing that makes the history worth keeping.
        <Banner tone="bad">{t("noReasons")}</Banner>
      ) : (
        <AdjustmentClient
          reasons={reasons}
          products={products}
          canApprove={can(user, "adjustment.approve")}
        />
      )}
    </div>
  );
}
