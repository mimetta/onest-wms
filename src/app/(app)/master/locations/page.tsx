import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SearchBox } from "@/components/search-box";
import { PrintLabelLink } from "@/components/print-label-link";
import { Badge, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { RecordList } from "@/components/record-list";

export default async function LocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const { q } = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("locations")
    .select(
      "id, code, barcode, type, counts_as_available, is_virtual, is_active, zones(code, name_th)",
      { count: "exact" },
    )
    .order("code");

  if (q) query = query.or(`code.ilike.%${q}%,barcode.ilike.%${q}%`);

  const { data: locations, count } = await query;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader
        title={t("locations")}
        subtitle={t("count", { count: count ?? 0 })}
        action={
          <div className="flex gap-2">
            <LinkButton href="/master/zones">{t("zones")}</LinkButton>
            <LinkButton href="/master/locations/new" variant="primary">
              {t("newLocation")}
            </LinkButton>
          </div>
        }
      />
      <SearchBox placeholder={t("searchLocations")} />

      <RecordList
        items={locations ?? []}
        rowKey={(l) => l.id}
        empty={<EmptyState title={t("noResults")} hint={t("noResultsHint")} />}
        columns={[
          { key: "code", header: t("code"), role: "primary", cell: (l) => l.code },
          {
            key: "zone",
            header: t("zone"),
            role: "secondary",
            cell: (l) => {
              const zone = l.zones as unknown as { name_th: string } | null;
              return zone?.name_th ?? "—";
            },
          },
          { key: "type", header: t("type"), role: "meta", cell: (l) => l.type },
          {
            key: "barcode",
            header: t("barcode"),
            role: "meta",
            // A virtual bin is never physically visited, so its barcode is not
            // a label anyone can scan.
            cell: (l) => (l.is_virtual ? "—" : l.barcode),
          },
          {
            key: "flags",
            header: "",
            role: "trailing",
            cell: (l) => (
              <span className="flex flex-wrap justify-end gap-1">
                {l.counts_as_available && (
                  <Badge tone="good">{t("availableForPicking")}</Badge>
                )}
                {l.is_virtual && <Badge tone="info">virtual</Badge>}
                {!l.is_active && <Badge tone="bad">{t("inactive")}</Badge>}
              </span>
            ),
          },
        ]}
        action={(l) =>
          l.is_virtual ? null : (
            <>
              <PrintLabelLink kind="location" id={l.id} compact />
              <Link
                href={`/master/locations/${l.id}`}
                className="text-brand-brown hover:text-brand-accent text-sm font-medium"
              >
                {t("edit")}
              </Link>
            </>
          )
        }
      />
    </div>
  );
}
