import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import {
  RequisitionBuilder,
  type DeptOption,
  type ProductOption,
} from "./requisition-builder";

/**
 * Raise a requisition.
 *
 * Departments and products are loaded on the server and passed down: under 500
 * SKUs fits comfortably in one payload, and a plain <select> that works offline
 * beats a search box that needs a round trip on warehouse Wi-Fi.
 */
export default async function Page() {
  await requirePerm("requisition.create");
  const t = await getTranslations("requisitions");
  const supabase = await createClient();

  const [{ data: depts }, { data: products }] = await Promise.all([
    supabase
      .from("departments")
      .select("id, name_th")
      .eq("is_active", true)
      .order("code"),
    supabase
      .from("products")
      .select("id, sku, name_th, base_uom_id, uoms:base_uom_id(code)")
      .eq("is_active", true)
      .order("sku"),
  ]);

  const departments: DeptOption[] = (depts ?? []).map((d) => ({
    id: d.id,
    nameTh: d.name_th,
  }));

  const productOptions: ProductOption[] = (products ?? []).map((p) => ({
    id: p.id,
    sku: p.sku,
    nameTh: p.name_th,
    baseUomId: p.base_uom_id,
    baseUomCode: (p.uoms as unknown as { code: string } | null)?.code ?? "",
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("newTitle")} subtitle={t("newSubtitle")} />
      <RequisitionBuilder
        departments={departments}
        products={productOptions}
        defaultDepartmentId={null}
      />
    </div>
  );
}
