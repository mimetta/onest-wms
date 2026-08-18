import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, PageHeader } from "@/components/ui";
import {
  IssueBuilder,
  type ProductOption,
  type RequisitionOption,
} from "./issue-builder";

type ReqRow = {
  id: string;
  doc_no: string | null;
  department_id: string;
  departments: { name_th: string } | null;
  requisition_lines: {
    product_id: string;
    qty: number;
    products: {
      sku: string;
      name_th: string;
      base_uom_id: string;
      tracking_mode: "none" | "lot" | "serial";
      uoms: { code: string } | null;
    } | null;
  }[];
};

/**
 * Raise an issue.
 *
 * Approved requisitions are offered as the source of what to pick. Ones already
 * fulfilled are excluded — a requisition satisfied by a posted issue should not
 * still be sitting on the list inviting a second withdrawal against the same
 * request.
 */
export default async function Page() {
  const user = await requirePerm("issue.create");
  const t = await getTranslations("issues");
  const supabase = await createClient();

  const [
    { data: reqData },
    { data: productData },
    { data: deptData },
    { data: fulfilled },
  ] = await Promise.all([
    supabase
      .from("requisitions")
      .select(
        `id, doc_no, department_id, departments(name_th),
           requisition_lines(product_id, qty,
             products(sku, name_th, base_uom_id, tracking_mode, uoms:base_uom_id(code)))`,
      )
      .eq("status", "approved")
      .eq("warehouse_id", user.warehouseId)
      .order("doc_date", { ascending: true }),
    supabase
      .from("products")
      .select("id, sku, name_th, base_uom_id, tracking_mode, uoms:base_uom_id(code)")
      .eq("is_active", true)
      .order("sku"),
    supabase
      .from("departments")
      .select("id, name_th")
      .eq("is_active", true)
      .order("code"),
    // Requisition ids that a posted issue already drew against.
    supabase.from("issues").select("requisition_id").eq("status", "posted"),
  ]);

  const done = new Set(
    (fulfilled ?? []).map((i) => i.requisition_id).filter((v): v is string => Boolean(v)),
  );

  const requisitions: RequisitionOption[] = ((reqData ?? []) as unknown as ReqRow[])
    .filter((r) => !done.has(r.id))
    .map((r) => ({
      id: r.id,
      docNo: r.doc_no,
      departmentId: r.department_id,
      departmentName: r.departments?.name_th ?? "",
      requirements: r.requisition_lines.map((l) => ({
        productId: l.product_id,
        sku: l.products?.sku ?? "",
        nameTh: l.products?.name_th ?? "",
        baseUomId: l.products?.base_uom_id ?? "",
        baseUomCode: l.products?.uoms?.code ?? "",
        trackingMode: l.products?.tracking_mode ?? "none",
        qtyRequested: Number(l.qty),
        qtyPicked: 0,
      })),
    }));

  const products: ProductOption[] = (productData ?? []).map((p) => ({
    id: p.id,
    sku: p.sku,
    nameTh: p.name_th,
    baseUomId: p.base_uom_id,
    baseUomCode: (p.uoms as unknown as { code: string } | null)?.code ?? "",
    trackingMode: p.tracking_mode as "none" | "lot" | "serial",
  }));

  const canIssueDirect = can(user, "issue.create_direct");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("newTitle")} subtitle={t("newSubtitle")} />

      {!canIssueDirect && requisitions.length === 0 && (
        // Staff cannot raise a direct issue (D-46), so with nothing approved
        // there is genuinely nothing for them to do here. Saying so is kinder
        // than an empty screen with a disabled button.
        <Banner tone="info">{t("needApprovedRequisition")}</Banner>
      )}

      <IssueBuilder
        requisitions={requisitions}
        products={products}
        departments={(deptData ?? []).map((d) => ({ id: d.id, nameTh: d.name_th }))}
        canIssueDirect={canIssueDirect}
      />
    </div>
  );
}
