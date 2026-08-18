import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { RecordList } from "@/components/record-list";

export default async function DepartmentsPage() {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const supabase = await createClient();

  const { data: departments, count } = await supabase
    .from("departments")
    .select("id, code, name_th, name_en, is_active", { count: "exact" })
    .order("code");

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title={t("departments")} subtitle={t("count", { count: count ?? 0 })} />

      <RecordList
        items={departments ?? []}
        rowKey={(d) => d.id}
        empty={<EmptyState title={t("noResults")} />}
        columns={[
          { key: "code", header: t("code"), role: "primary", cell: (d) => d.code },
          {
            key: "name",
            header: t("nameTh"),
            role: "secondary",
            cell: (d) => d.name_th,
          },
          {
            key: "nameEn",
            header: t("nameEn"),
            role: "meta",
            cell: (d) => d.name_en ?? "—",
          },
          {
            key: "status",
            header: "",
            role: "trailing",
            cell: (d) =>
              !d.is_active ? <Badge tone="bad">{t("inactive")}</Badge> : null,
          },
        ]}
      />
    </div>
  );
}
