import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, PageHeader } from "@/components/ui";
import { LocationForm } from "../location-form";
import { BinGenerator } from "../bin-generator";

export default async function NewLocationPage() {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const supabase = await createClient();

  const [{ data: zones }, { data: customers }] = await Promise.all([
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

  return (
    <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
      <PageHeader title={t("newLocation")} />

      {(!zones || zones.length === 0) && <Banner tone="warn">{t("noZone")}</Banner>}

      <LocationForm
        values={{
          code: "",
          barcode: "",
          type: "storage",
          zone_id: "",
          partner_id: "",
          counts_as_available: true,
          blocks_consumption: false,
          is_active: true,
        }}
        zones={zones ?? []}
        customers={customers ?? []}
      />

      <BinGenerator zones={zones ?? []} />
    </div>
  );
}
