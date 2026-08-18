import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { PriceHistory } from "../price-history";
import { PrintLabelLink } from "@/components/print-label-link";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, PageHeader, SectionLabel } from "@/components/ui";
import { ProductForm } from "../product-form";

export default async function EditProductPage({
  params,
  searchParams,
}: PageProps<"/master/products/[id]">) {
  const user = await requirePerm("master_data.write");
  const { id } = await params;
  const { created } = await searchParams;
  const t = await getTranslations("master");
  const supabase = await createClient();

  const [{ data: product }, { data: categories }, { data: uoms }, { count: movements }] =
    await Promise.all([
      supabase.from("products").select("*").eq("id", id).maybeSingle(),
      supabase.from("product_categories").select("id, name_th").order("code"),
      supabase.from("uoms").select("id, code, name_th").order("code"),
      supabase
        .from("stock_movements")
        .select("id", { count: "exact", head: true })
        .eq("product_id", id),
    ]);

  if (!product) notFound();

  const { data: barcodes } = await supabase
    .from("product_barcodes")
    .select("id, barcode, type, is_primary, uoms(code)")
    .eq("product_id", id)
    .order("is_primary", { ascending: false });

  // tracking_mode is frozen once any movement exists (D-12). The form shows why
  // rather than silently disabling the control.
  const trackingEditable = (movements ?? 0) === 0;

  return (
    <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
      <PageHeader
        title={product.sku}
        subtitle={product.name_th}
        action={<PrintLabelLink kind="product" id={product.id} />}
      />

      <ProductForm
        values={{
          id: product.id,
          sku: product.sku,
          name_th: product.name_th,
          name_en: product.name_en ?? "",
          category_id: product.category_id ?? "",
          base_uom_id: product.base_uom_id,
          tracking_mode: product.tracking_mode,
          shelf_life_days: product.shelf_life_days?.toString() ?? "",
          requires_qc: product.requires_qc,
          is_consignment_eligible: product.is_consignment_eligible,
          acccloud_item_code: product.acccloud_item_code ?? "",
          supplier_moq: product.supplier_moq?.toString() ?? "",
          is_active: product.is_active,
          source: product.source,
          acccloud_linked_at: product.acccloud_linked_at,
        }}
        categories={categories ?? []}
        uoms={uoms ?? []}
        trackingEditable={trackingEditable}
        identityEditable={can(user, "master_data.create")}
        created={created === "1"}
      />

      {/* Cost is admin/manager/viewer only — never on a warehouse screen (D-34). */}
      {can(user, "cost.read") && <PriceHistory productId={id} />}

      <Card className="flex flex-col gap-3 px-4 py-3 sm:px-6 sm:py-5">
        <SectionLabel>{t("barcodes")}</SectionLabel>
        {!barcodes || barcodes.length === 0 ? (
          <p className="text-brand-muted text-sm">{t("noBarcodes")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {barcodes.map((b) => {
              const uom = b.uoms as unknown as { code: string } | null;
              return (
                <li key={b.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-brand-dark font-mono text-sm">{b.barcode}</span>
                  <Badge tone={b.is_primary ? "info" : "neutral"}>{b.type}</Badge>
                  {uom && <span className="text-brand-subtle text-xs">{uom.code}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
