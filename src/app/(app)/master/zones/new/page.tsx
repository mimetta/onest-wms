import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ZoneForm } from "../zone-form";

export default async function NewZonePage() {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  return (
    <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
      <PageHeader title={t("newZone")} />
      <ZoneForm values={{ code: "", name_th: "", name_en: "", is_active: true }} />
    </div>
  );
}
