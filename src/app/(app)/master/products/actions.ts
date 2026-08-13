"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/auth";

export type ProductFormState = { error?: string; fieldErrors?: Record<string, string> };

function readForm(formData: FormData) {
  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const num = (k: string) => {
    const v = str(k);
    return v === null ? null : Number(v);
  };

  return {
    sku: str("sku"),
    name_th: str("name_th"),
    name_en: str("name_en"),
    category_id: str("category_id"),
    base_uom_id: str("base_uom_id"),
    tracking_mode: str("tracking_mode") ?? "none",
    shelf_life_days: num("shelf_life_days"),
    requires_qc: formData.get("requires_qc") === "on",
    is_consignment_eligible: formData.get("is_consignment_eligible") === "on",
    acccloud_item_code: str("acccloud_item_code"),
    // Enrichment the WMS owns: AccCloud may never supply it (D-33, D-34).
    supplier_moq: num("supplier_moq"),
    is_active: formData.get("is_active") === "on",
  };
}

/**
 * Errors are returned as message keys, so the browser renders them in the
 * user's language. Postgres error codes are mapped to those keys rather than
 * shown raw — "duplicate key value violates unique constraint products_sku_key"
 * is not a sentence for a warehouse manager.
 */
function mapError(code?: string): string {
  if (code === "23505") return "errorDuplicate";
  return "errorSave";
}

export async function createProduct(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  await requirePerm("master_data.write");
  const values = readForm(formData);

  if (!values.sku || !values.name_th || !values.base_uom_id) {
    return { error: "errorRequired" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("products")
    .insert(values)
    .select("id")
    .single();

  if (error) return { error: mapError(error.code) };

  revalidatePath("/master/products");
  redirect(`/master/products/${data.id}?created=1`);
}

export async function updateProduct(
  _prev: ProductFormState,
  formData: FormData,
): Promise<ProductFormState> {
  await requirePerm("master_data.write");
  const id = String(formData.get("id") ?? "");
  const values = readForm(formData);

  if (!id) return { error: "errorSave" };
  if (!values.sku || !values.name_th || !values.base_uom_id) {
    return { error: "errorRequired" };
  }

  const supabase = await createClient();

  // tracking_mode is omitted from the update entirely rather than sent
  // unchanged. The database refuses to change it once movements exist (D-12),
  // and sending the same value would still trip that trigger on a product whose
  // mode is being "kept" — so the safe move is never to send it at all.
  const { tracking_mode, ...rest } = values;
  const patch: Record<string, unknown> = {
    ...rest,
    updated_at: new Date().toISOString(),
  };

  // Only include it when the product has no movements yet, which the form has
  // already established by rendering the field as editable.
  if (formData.get("tracking_editable") === "1") {
    patch.tracking_mode = tracking_mode;
  }

  const { error } = await supabase.from("products").update(patch).eq("id", id);
  if (error) return { error: mapError(error.code) };

  revalidatePath("/master/products");
  revalidatePath(`/master/products/${id}`);
  return { error: undefined };
}
