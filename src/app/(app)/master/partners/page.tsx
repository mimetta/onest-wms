import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { SourceBadge } from "@/components/source-badge";
import { createClient } from "@/lib/supabase/server";
import { SearchBox } from "@/components/search-box";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { RecordList } from "@/components/record-list";

export default async function PartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const { q } = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("partners")
    .select(
      "id, code, type, name_th, name_en, phone, is_active, source, acccloud_linked_at",
      {
        count: "exact",
      },
    )
    .order("code");

  if (q) query = query.or(`code.ilike.%${q}%,name_th.ilike.%${q}%`);

  const { data: partners, count } = await query;

  const typeLabel = {
    supplier: t("supplier"),
    customer: t("customer"),
    both: t("both"),
  } as const;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title={t("partners")} subtitle={t("count", { count: count ?? 0 })} />
      <SearchBox placeholder={t("searchPartners")} />

      <RecordList
        items={partners ?? []}
        rowKey={(p) => p.id}
        empty={<EmptyState title={t("noResults")} hint={t("noResultsHint")} />}
        columns={[
          { key: "code", header: t("code"), role: "primary", cell: (p) => p.code },
          {
            key: "name",
            header: t("nameTh"),
            role: "secondary",
            cell: (p) => (
              <span className="flex flex-col">
                <span>{p.name_th}</span>
                {p.name_en && (
                  <span className="text-brand-subtle text-xs">{p.name_en}</span>
                )}
              </span>
            ),
          },
          {
            key: "phone",
            header: t("phone"),
            role: "meta",
            cell: (p) => p.phone ?? "—",
          },
          {
            key: "type",
            header: t("partnerType"),
            role: "trailing",
            cell: (p) => (
              <span className="flex flex-wrap justify-end gap-1">
                <Badge tone={p.type === "supplier" ? "info" : "neutral"}>
                  {typeLabel[p.type as keyof typeof typeLabel]}
                </Badge>
                {!p.is_active && <Badge tone="bad">{t("inactive")}</Badge>}
                <SourceBadge source={p.source} linkedAt={p.acccloud_linked_at} />
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
