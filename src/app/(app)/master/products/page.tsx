import Link from "next/link";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { SourceBadge } from "@/components/source-badge";
import { PrintLabelLink } from "@/components/print-label-link";
import { createClient } from "@/lib/supabase/server";
import { SearchBox } from "@/components/search-box";
import { Badge, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { RecordList } from "@/components/record-list";

const PAGE_SIZE = 50;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const user = await requirePerm("master_data.write");
  const t = await getTranslations("master");
  const { q, page } = await searchParams;
  const supabase = await createClient();

  const pageNo = Math.max(1, Number(page) || 1);
  const from = (pageNo - 1) * PAGE_SIZE;

  let query = supabase
    .from("products")
    .select(
      "id, sku, name_th, name_en, tracking_mode, requires_qc, is_active, source, acccloud_linked_at, uoms(code), product_categories(name_th)",
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
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader
        title={t("products")}
        subtitle={t("count", { count: count ?? 0 })}
        action={
          // AccCloud is the system of record for existence, so creating a
          // product here is an admin escape hatch, not the normal path (D-33).
          can(user, "master_data.create") ? (
            <LinkButton href="/master/products/new" variant="primary">
              {t("new")}
            </LinkButton>
          ) : undefined
        }
      />

      <SearchBox placeholder={t("searchProducts")} />

      <RecordList
        items={products ?? []}
        rowKey={(p) => p.id}
        empty={<EmptyState title={t("noResults")} hint={t("noResultsHint")} />}
        columns={[
          { key: "sku", header: t("sku"), role: "primary", cell: (p) => p.sku },
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
            key: "category",
            header: t("category"),
            role: "meta",
            cell: (p) => {
              const cat = p.product_categories as unknown as { name_th: string } | null;
              return cat?.name_th ?? "—";
            },
          },
          {
            key: "uom",
            header: t("baseUom"),
            role: "meta",
            cell: (p) => {
              const uom = p.uoms as unknown as { code: string } | null;
              return uom?.code ?? "—";
            },
          },
          {
            key: "tracking",
            header: t("tracking"),
            role: "trailing",
            cell: (p) => (
              <span className="flex flex-wrap justify-end gap-1">
                <Badge tone={p.tracking_mode === "none" ? "neutral" : "info"}>
                  {trackingLabel[p.tracking_mode as keyof typeof trackingLabel]}
                </Badge>
                {p.requires_qc && <Badge tone="info">QC</Badge>}
                {!p.is_active && <Badge tone="bad">{t("inactive")}</Badge>}
                <SourceBadge source={p.source} linkedAt={p.acccloud_linked_at} />
              </span>
            ),
          },
        ]}
        action={(p) => (
          <>
            <PrintLabelLink kind="product" id={p.id} compact />
            <Link
              href={`/master/products/${p.id}`}
              className="text-brand-brown hover:text-brand-accent text-sm font-medium"
            >
              {t("edit")}
            </Link>
          </>
        )}
      />

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
