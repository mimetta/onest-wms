import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, PageHeader } from "@/components/ui";
import {
  DeliveryBuilder,
  type PartnerOption,
  type ProductOption,
} from "./delivery-builder";

export default async function Page() {
  const user = await requirePerm("delivery_note.create");
  const t = await getTranslations("deliveryNotes");
  const supabase = await createClient();

  const [{ data: partnerData }, { data: productData }, { data: sites }] =
    await Promise.all([
      supabase
        .from("partners")
        .select("id, code, name_th")
        .in("type", ["customer", "both"])
        .eq("is_active", true)
        .order("code"),
      supabase
        .from("products")
        .select("id, sku, name_th, base_uom_id, uoms:base_uom_id(code)")
        .eq("is_active", true)
        .order("sku"),
      // Which customers have somewhere to consign to. Loaded once rather than
      // asked per selection, because there are two of them.
      supabase
        .from("locations")
        .select("partner_id")
        .eq("type", "consignment_site")
        .eq("is_active", true),
    ]);

  const withSites = new Set(
    (sites ?? []).map((s) => s.partner_id).filter((v): v is string => Boolean(v)),
  );

  const partners: PartnerOption[] = (partnerData ?? []).map((p) => ({
    id: p.id,
    code: p.code,
    nameTh: p.name_th,
    hasConsignmentSite: withSites.has(p.id),
  }));

  const products: ProductOption[] = (productData ?? []).map((p) => ({
    id: p.id,
    sku: p.sku,
    nameTh: p.name_th,
    baseUomId: p.base_uom_id,
    baseUomCode: (p.uoms as unknown as { code: string } | null)?.code ?? "",
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("newTitle")} subtitle={t("newSubtitle")} />
      {partners.length === 0 && <Banner tone="info">{t("noCustomers")}</Banner>}
      <DeliveryBuilder
        partners={partners}
        products={products}
        canApprove={can(user, "delivery_note.approve")}
      />
    </div>
  );
}
