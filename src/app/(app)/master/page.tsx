import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, PageHeader } from "@/components/ui";

export default async function MasterDataPage() {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const supabase = await createClient();

  const [products, locations, partners, departments] = await Promise.all([
    supabase.from("products").select("id", { count: "exact", head: true }),
    supabase.from("locations").select("id", { count: "exact", head: true }),
    supabase.from("partners").select("id", { count: "exact", head: true }),
    supabase.from("departments").select("id", { count: "exact", head: true }),
  ]);

  const { count: zoneCount } = await supabase
    .from("zones")
    .select("id", { count: "exact", head: true });

  const sections = [
    {
      href: "/master/products",
      title: t("products"),
      hint: t("productsHint"),
      count: products.count ?? 0,
    },
    {
      href: "/master/locations",
      title: t("locations"),
      hint: t("locationsHint"),
      count: locations.count ?? 0,
    },
    {
      href: "/master/zones",
      title: t("zones"),
      hint: t("zonesHint"),
      count: zoneCount ?? 0,
    },
    {
      href: "/master/partners",
      title: t("partners"),
      hint: t("partnersHint"),
      count: partners.count ?? 0,
    },
    {
      href: "/master/departments",
      title: t("departments"),
      hint: t("departmentsHint"),
      count: departments.count ?? 0,
    },
  ] as const;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} className="group">
            <Card className="group-hover:border-brand-accent h-full px-6 py-5 transition-colors">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-brand-dark text-base font-semibold">{s.title}</h2>
                <span className="tabular text-brand-subtle text-xs">
                  {t("count", { count: s.count })}
                </span>
              </div>
              <p className="text-brand-muted mt-1 text-sm">{s.hint}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
