import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, PageHeader } from "@/components/ui";
import { PrintLabelLink } from "@/components/print-label-link";
import { LocationForm } from "../location-form";

export default async function EditLocationPage({
  params,
}: PageProps<"/master/locations/[id]">) {
  await requirePerm("master_data.write");
  const { id } = await params;
  const t = await getTranslations("master");
  const supabase = await createClient();

  const [{ data: location }, { data: zones }, { data: customers }] = await Promise.all([
    supabase.from("locations").select("*").eq("id", id).maybeSingle(),
    supabase
      .from("zones")
      .select("id, code, name_th")
      .eq("is_active", true)
      .order("code"),
    supabase
      .from("partners")
      .select("id, code, name_th")
      .in("type", ["customer", "both"])
      .eq("is_active", true)
      .order("code"),
  ]);

  if (!location) notFound();

  // IN-TRANSIT and OPENING are created by migration, exactly one per warehouse,
  // and the posting routines look them up by type. Editing one would break
  // transfers or opening balances, so the form is not offered at all.
  if (location.is_virtual) {
    return (
      <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
        <PageHeader title={location.code} subtitle={location.type} />
        <Banner tone="warn">{t("systemLocation")}</Banner>
      </div>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
      <PageHeader
        title={location.code}
        subtitle={t("editLocation")}
        action={<PrintLabelLink kind="location" id={location.id} />}
      />
      <LocationForm
        values={{
          id: location.id,
          code: location.code,
          barcode: location.barcode,
          type: location.type,
          zone_id: location.zone_id ?? "",
          partner_id: location.partner_id ?? "",
          counts_as_available: location.counts_as_available,
          blocks_consumption: location.blocks_consumption,
          is_active: location.is_active,
        }}
        zones={zones ?? []}
        customers={customers ?? []}
      />
    </div>
  );
}
