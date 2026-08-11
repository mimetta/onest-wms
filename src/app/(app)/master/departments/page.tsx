import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, EmptyState, PageHeader, Table, TableWrap, Td, Th } from "@/components/ui";

export default async function DepartmentsPage() {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const supabase = await createClient();

  const { data: departments, count } = await supabase
    .from("departments")
    .select("id, code, name_th, name_en, is_active", { count: "exact" })
    .order("code");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("departments")} subtitle={t("count", { count: count ?? 0 })} />

      {!departments || departments.length === 0 ? (
        <TableWrap>
          <EmptyState title={t("noResults")} />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t("code")}</Th>
                <Th>{t("nameTh")}</Th>
                <Th>{t("nameEn")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {departments.map((d) => (
                <tr key={d.id} className="hover:bg-brand-cream/60">
                  <Td className="font-mono text-xs whitespace-nowrap">{d.code}</Td>
                  <Td className="text-brand-dark">{d.name_th}</Td>
                  <Td className="text-brand-muted">{d.name_en ?? "—"}</Td>
                  <Td>{!d.is_active && <Badge tone="bad">{t("inactive")}</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
