import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ProductForm } from "../product-form";

export default async function NewProductPage() {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const supabase = await createClient();

  const [{ data: categories }, { data: uoms }] = await Promise.all([
    supabase.from("product_categories").select("id, name_th").order("code"),
    supabase.from("uoms").select("id, code, name_th").order("code"),
  ]);

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title={`${t("products")} · ${t("new")}`} />
      <ProductForm
        values={{
          sku: "",
          name_th: "",
          name_en: "",
          category_id: "",
          base_uom_id: "",
          tracking_mode: "none",
          shelf_life_days: "",
          requires_qc: false,
          is_consignment_eligible: false,
          acccloud_item_code: "",
          is_active: true,
        }}
        categories={categories ?? []}
        uoms={uoms ?? []}
        trackingEditable
      />
    </div>
  );
}
