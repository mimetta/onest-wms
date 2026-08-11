import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { SearchBox } from "@/components/search-box";
import {
  Badge,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  TableWrap,
  Td,
  Th,
} from "@/components/ui";

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
    <div className="flex flex-col gap-6">
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

      {!locations || locations.length === 0 ? (
        <TableWrap>
          <EmptyState title={t("noResults")} hint={t("noResultsHint")} />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t("code")}</Th>
                <Th>{t("zone")}</Th>
                <Th>{t("type")}</Th>
                <Th>{t("barcode")}</Th>
                <Th />
                <Th />
              </tr>
            </thead>
            <tbody>
              {locations.map((l) => {
                const zone = l.zones as unknown as {
                  code: string;
                  name_th: string;
                } | null;
                return (
                  <tr key={l.id} className="hover:bg-brand-cream/60">
                    <Td className="font-mono text-xs whitespace-nowrap">{l.code}</Td>
                    <Td className="text-brand-muted">{zone?.name_th ?? "—"}</Td>
                    <Td className="font-mono text-xs">{l.type}</Td>
                    <Td className="font-mono text-xs">
                      {/* A virtual bin is never physically visited, so its
                          barcode is not a label anyone can scan. */}
                      {l.is_virtual ? "—" : l.barcode}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {l.counts_as_available && (
                          <Badge tone="good">{t("availableForPicking")}</Badge>
                        )}
                        {l.is_virtual && <Badge tone="info">virtual</Badge>}
                        {!l.is_active && <Badge tone="bad">{t("inactive")}</Badge>}
                      </div>
                    </Td>
                    <Td className="text-right">
                      {/* Virtual bins are system-owned; there is nothing to edit. */}
                      {!l.is_virtual && (
                        <Link
                          href={`/master/locations/${l.id}`}
                          className="text-brand-brown hover:text-brand-accent text-sm font-medium"
                        >
                          {t("edit")}
                        </Link>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
