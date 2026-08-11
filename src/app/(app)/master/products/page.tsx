import Link from "next/link";
import type { Route } from "next";
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

const PAGE_SIZE = 50;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const { q, page } = await searchParams;
  const supabase = await createClient();

  const pageNo = Math.max(1, Number(page) || 1);
  const from = (pageNo - 1) * PAGE_SIZE;

  let query = supabase
    .from("products")
    .select(
      "id, sku, name_th, name_en, tracking_mode, requires_qc, is_active, uoms(code), product_categories(name_th)",
      { count: "exact" },
    )
    .order("sku")
    .range(from, from + PAGE_SIZE - 1);

  if (q) {
    // Matches either the code or the Thai name — a user searching "SOLV" and a
    // user searching "ตัวทำละลาย" are both looking for the same thing.
    query = query.or(`sku.ilike.%${q}%,name_th.ilike.%${q}%,name_en.ilike.%${q}%`);
  }

  const { data: products, count } = await query;

  const trackingLabel = {
    none: t("trackingNone"),
    lot: t("trackingLot"),
    serial: t("trackingSerial"),
  } as const;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("products")}
        subtitle={t("count", { count: count ?? 0 })}
        action={
          <LinkButton href="/master/products/new" variant="primary">
            {t("new")}
          </LinkButton>
        }
      />

      <SearchBox placeholder={t("searchProducts")} />

      {!products || products.length === 0 ? (
        <TableWrap>
          <EmptyState title={t("noResults")} hint={t("noResultsHint")} />
        </TableWrap>
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr>
                <Th>{t("sku")}</Th>
                <Th>{t("nameTh")}</Th>
                <Th>{t("category")}</Th>
                <Th>{t("baseUom")}</Th>
                <Th>{t("tracking")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const uom = p.uoms as unknown as { code: string } | null;
                const cat = p.product_categories as unknown as {
                  name_th: string;
                } | null;
                return (
                  <tr key={p.id} className="hover:bg-brand-cream/60">
                    <Td className="font-mono text-xs whitespace-nowrap">{p.sku}</Td>
                    <Td>
                      <div className="flex flex-col">
                        <span className="text-brand-dark">{p.name_th}</span>
                        {p.name_en && (
                          <span className="text-brand-subtle text-xs">{p.name_en}</span>
                        )}
                      </div>
                    </Td>
                    <Td className="text-brand-muted">{cat?.name_th ?? "—"}</Td>
                    <Td className="font-mono text-xs">{uom?.code ?? "—"}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Badge tone={p.tracking_mode === "none" ? "neutral" : "info"}>
                          {trackingLabel[p.tracking_mode as keyof typeof trackingLabel]}
                        </Badge>
                        {p.requires_qc && <Badge tone="warn">QC</Badge>}
                        {!p.is_active && <Badge tone="bad">{t("inactive")}</Badge>}
                      </div>
                    </Td>
                    <Td className="text-right">
                      <Link
                        href={`/master/products/${p.id}`}
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

      {(count ?? 0) > PAGE_SIZE && <Pagination page={pageNo} total={count ?? 0} q={q} />}
    </div>
  );
}

function Pagination({ page, total, q }: { page: number; total: number; q?: string }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  // typedRoutes cannot know a route built from a query string at runtime. The
  // path half is a literal, so the cast is narrow and safe.
  const href = (n: number) =>
    `/master/products?${new URLSearchParams({
      ...(q ? { q } : {}),
      page: String(n),
    })}` as Route;

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-brand-subtle text-xs">
        {page} / {pages}
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link
            href={href(page - 1)}
            className="border-brand-border text-brand-dark hover:bg-brand-cream inline-flex h-9 items-center rounded-md border px-4 text-sm"
          >
            ←
          </Link>
        )}
        {page < pages && (
          <Link
            href={href(page + 1)}
            className="border-brand-border text-brand-dark hover:bg-brand-cream inline-flex h-9 items-center rounded-md border px-4 text-sm"
          >
            →
          </Link>
        )}
      </div>
    </div>
  );
}
