import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
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

export default async function ZonesPage() {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const supabase = await createClient();

  const { data: zones, count } = await supabase
    .from("zones")
    .select("id, code, name_th, name_en, is_active, locations(count)", { count: "exact" })
    .order("code");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("zones")}
        subtitle={t("count", { count: count ?? 0 })}
        action={
          <LinkButton href="/master/zones/new" variant="primary">
            {t("newZone")}
          </LinkButton>
        }
      />

      {!zones || zones.length === 0 ? (
        <TableWrap>
          <EmptyState title={t("noZone")} />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t("zoneCode")}</Th>
                <Th>{t("nameTh")}</Th>
                <Th>{t("locations")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => {
                const rel = z.locations as unknown as { count: number }[] | null;
                return (
                  <tr key={z.id} className="hover:bg-brand-cream/60">
                    <Td className="font-mono text-xs whitespace-nowrap">{z.code}</Td>
                    <Td>
                      <div className="flex flex-col">
                        <span className="text-brand-dark">{z.name_th}</span>
                        {z.name_en && (
                          <span className="text-brand-subtle text-xs">{z.name_en}</span>
                        )}
                      </div>
                    </Td>
                    <Td className="tabular text-brand-muted">{rel?.[0]?.count ?? 0}</Td>
                    <Td className="text-right">
                      {!z.is_active && <Badge tone="bad">{t("inactive")}</Badge>}{" "}
                      <Link
                        href={`/master/zones/${z.id}`}
                        className="text-brand-brown hover:text-brand-accent text-sm font-medium"
                      >
                        {t("edit")}
                      </Link>
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
