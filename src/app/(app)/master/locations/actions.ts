"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requirePerm } from "@/lib/auth";

export type LocationFormState = { error?: string; created?: number; skipped?: number };

/**
 * Types a user may create by hand.
 *
 * `in_transit` and `opening` are deliberately absent: they are virtual system
 * bins, exactly one of each per warehouse, created by the migration. A second
 * in_transit bin would silently break transfers, because in_transit_location()
 * picks one — so the safest place to prevent that is the form that would
 * otherwise offer it.
 */
const CREATABLE_TYPES = [
  "receiving",
  "qc_hold",
  "storage",
  "picking",
  "staging",
  "shipping",
  "quarantine",
  "scrap",
  "consignment_site",
] as const;

type CreatableType = (typeof CREATABLE_TYPES)[number];

function isCreatable(v: unknown): v is CreatableType {
  return typeof v === "string" && (CREATABLE_TYPES as readonly string[]).includes(v);
}

function mapError(code?: string, message?: string): string {
  if (code === "23505") return "errorDuplicate";
  // The consignment_needs_partner check constraint, surfaced in the user's
  // language rather than as constraint text.
  if (message?.includes("consignment_needs_partner")) return "partnerRequired";
  return "errorSave";
}

// ---------------------------------------------------------------- zones

export async function saveZone(
  _prev: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  await requirePerm("master_data.write");
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const name_th = String(formData.get("name_th") ?? "").trim();
  const name_en = String(formData.get("name_en") ?? "").trim() || null;
  const is_active = formData.get("is_active") === "on";

  if (!code || !name_th) return { error: "errorRequired" };

  if (id) {
    const { error } = await supabase
      .from("zones")
      .update({ code, name_th, name_en, is_active, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { error: mapError(error.code, error.message) };
  } else {
    const { data: warehouse } = await supabase
      .from("warehouses")
      .select("id")
      .eq("is_default", true)
      .single();

    const { error } = await supabase
      .from("zones")
      .insert({ warehouse_id: warehouse!.id, code, name_th, name_en, is_active });
    if (error) return { error: mapError(error.code, error.message) };
  }

  revalidatePath("/master/zones");
  revalidatePath("/master/locations");
  redirect("/master/zones");
}

// ------------------------------------------------------------ locations

export async function saveLocation(
  _prev: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  await requirePerm("master_data.write");
  const supabase = await createClient();

  const id = String(formData.get("id") ?? "");
  const code = String(formData.get("code") ?? "")
    .trim()
    .toUpperCase();
  const rawType = formData.get("type");
  const zone_id = String(formData.get("zone_id") ?? "") || null;
  const partner_id = String(formData.get("partner_id") ?? "") || null;
  // A blank barcode means "same as the code" — which is what a printed bin
  // label shows anyway, so it saves typing the value twice.
  const barcode = String(formData.get("barcode") ?? "").trim() || code;
  const is_active = formData.get("is_active") === "on";

  if (!code || !isCreatable(rawType)) return { error: "errorRequired" };
  const type: CreatableType = rawType;

  if (type === "consignment_site" && !partner_id) return { error: "partnerRequired" };

  const values = {
    code,
    barcode,
    type,
    // A consignment site sits at a customer and has no zone in our building.
    zone_id: type === "consignment_site" ? null : zone_id,
    partner_id: type === "consignment_site" ? partner_id : null,
    counts_as_available: formData.get("counts_as_available") === "on",
    blocks_consumption: formData.get("blocks_consumption") === "on",
    is_active,
  };

  if (id) {
    const { error } = await supabase
      .from("locations")
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { error: mapError(error.code, error.message) };
  } else {
    const { data: warehouse } = await supabase
      .from("warehouses")
      .select("id")
      .eq("is_default", true)
      .single();

    const { error } = await supabase.from("locations").insert({
      ...values,
      warehouse_id: warehouse!.id,
      is_virtual: false,
    });
    if (error) return { error: mapError(error.code, error.message) };
  }

  revalidatePath("/master/locations");
  redirect("/master/locations");
}

/**
 * Create a rack of bins in one go: PREFIX-bay-level for every combination.
 *
 * Typing forty bins by hand before go-live is an hour of work and a typo
 * waiting to happen, and a mistyped bin code becomes a mislabelled shelf.
 * Existing codes are skipped rather than erroring, so the form is safe to run
 * twice — which is what happens when someone adds a fifth bay later.
 */
export async function generateBins(
  _prev: LocationFormState,
  formData: FormData,
): Promise<LocationFormState> {
  await requirePerm("master_data.write");
  const supabase = await createClient();

  const prefix = String(formData.get("prefix") ?? "")
    .trim()
    .toUpperCase();
  const zone_id = String(formData.get("zone_id") ?? "") || null;
  const rawType = formData.get("type");
  const bays = Number(formData.get("bays") ?? 0);
  const levels = Number(formData.get("levels") ?? 0);

  if (!prefix || !isCreatable(rawType)) return { error: "errorRequired" };
  if (!Number.isInteger(bays) || !Number.isInteger(levels))
    return { error: "errorRequired" };
  if (bays < 1 || levels < 1 || bays > 99 || levels > 99)
    return { error: "errorRequired" };

  const codes: string[] = [];
  for (let bay = 1; bay <= bays; bay++) {
    for (let level = 1; level <= levels; level++) {
      codes.push(
        `${prefix}-${String(bay).padStart(2, "0")}-${String(level).padStart(2, "0")}`,
      );
    }
  }

  const { data: warehouse } = await supabase
    .from("warehouses")
    .select("id")
    .eq("is_default", true)
    .single();

  const { data: existing } = await supabase
    .from("locations")
    .select("code")
    .in("code", codes);

  const taken = new Set((existing ?? []).map((l) => l.code));
  const fresh = codes.filter((c) => !taken.has(c));

  if (fresh.length > 0) {
    const { error } = await supabase.from("locations").insert(
      fresh.map((code) => ({
        warehouse_id: warehouse!.id,
        zone_id,
        code,
        barcode: code,
        type: rawType,
        counts_as_available: rawType === "storage" || rawType === "picking",
        blocks_consumption: false,
        is_virtual: false,
        is_active: true,
      })),
    );
    if (error) return { error: mapError(error.code, error.message) };
  }

  revalidatePath("/master/locations");
  return { created: fresh.length, skipped: taken.size };
}
