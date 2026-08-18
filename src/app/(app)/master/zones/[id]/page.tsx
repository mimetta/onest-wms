import { notFound } from "next/navigation";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ZoneForm } from "../zone-form";

export default async function EditZonePage({ params }: PageProps<"/master/zones/[id]">) {
  await requirePerm("master_data.write");
  const { id } = await params;
  const supabase = await createClient();

  const { data: zone } = await supabase
    .from("zones")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!zone) notFound();

  return (
    <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
      <PageHeader title={zone.code} subtitle={zone.name_th} />
      <ZoneForm
        values={{
          id: zone.id,
          code: zone.code,
          name_th: zone.name_th,
          name_en: zone.name_en ?? "",
          is_active: zone.is_active,
        }}
      />
    </div>
  );
}
