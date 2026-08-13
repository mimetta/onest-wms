import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { SourceBadge } from "@/components/source-badge";
import { createClient } from "@/lib/supabase/server";
import { SearchBox } from "@/components/search-box";
import { Badge, EmptyState, PageHeader, Table, TableWrap, Td, Th } from "@/components/ui";

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
    <div className="flex flex-col gap-6">
      <PageHeader title={t("partners")} subtitle={t("count", { count: count ?? 0 })} />
      <SearchBox placeholder={t("searchPartners")} />

      {!partners || partners.length === 0 ? (
        <TableWrap>
          <EmptyState title={t("noResults")} hint={t("noResultsHint")} />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t("code")}</Th>
                <Th>{t("nameTh")}</Th>
                <Th>{t("partnerType")}</Th>
                <Th>{t("phone")}</Th>
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.id} className="hover:bg-brand-cream/60">
                  <Td className="font-mono text-xs whitespace-nowrap">{p.code}</Td>
                  <Td>
                    <div className="flex flex-col">
                      <span className="text-brand-dark">{p.name_th}</span>
                      {p.name_en && (
                        <span className="text-brand-subtle text-xs">{p.name_en}</span>
                      )}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={p.type === "supplier" ? "info" : "neutral"}>
                        {typeLabel[p.type as keyof typeof typeLabel]}
                      </Badge>
                      {!p.is_active && <Badge tone="bad">{t("inactive")}</Badge>}
                      <SourceBadge source={p.source} linkedAt={p.acccloud_linked_at} />
                    </div>
                  </Td>
                  <Td className="text-brand-muted whitespace-nowrap">{p.phone ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
