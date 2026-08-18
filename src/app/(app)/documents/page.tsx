import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, Banner, Card, EmptyState, PageHeader } from "@/components/ui";
import { RecordList, type ListColumn } from "@/components/record-list";
import {
  DOC_CONFIG,
  DOC_TYPES,
  STATUS_TONE,
  type DocStatus,
  type DocType,
} from "@/lib/documents/config";

type Entry = {
  key: string;
  type: DocType;
  id: string;
  docNo: string | null;
  docDate: string;
  status: DocStatus;
  createdAt: string;
  who: string;
};

/**
 * The document centre — every document, one list.
 *
 * Deliberately assembled in the application rather than in a database view. A
 * UNION over eight tables would have to be maintained in lockstep with every
 * new document type and would fix the column set at the lowest common
 * denominator; and because each table has its own RLS policies, eight separate
 * queries give exactly the right per-type filtering for free. Eight small
 * indexed queries against a <500-SKU warehouse's document history is not a
 * performance problem worth solving with a view.
 *
 * Sorted by creation rather than document number, because a draft has no number
 * yet (and a requisition only gets one at approval — D-45), and "what happened
 * recently" is the question this screen answers.
 */
export default async function Page({ searchParams }: PageProps<"/documents">) {
  await requirePerm("report.read");
  const params = await searchParams;
  const t = await getTranslations("documentCentre");
  const tDocs = await getTranslations("documents");
  const tStatus = await getTranslations("status");
  const supabase = await createClient();

  const typeFilter = typeof params.type === "string" ? (params.type as DocType) : null;
  const statusFilter = typeof params.status === "string" ? params.status : null;

  const types = typeFilter && DOC_CONFIG[typeFilter] ? [typeFilter] : DOC_TYPES;

  const results = await Promise.all(
    types.map(async (type) => {
      let query = supabase
        .from(DOC_CONFIG[type].table)
        .select("id, doc_no, doc_date, status, created_at, created:created_by(full_name)")
        .order("created_at", { ascending: false })
        .limit(50);

      if (statusFilter) query = query.eq("status", statusFilter);

      const { data, error } = await query;
      return { type, data: data ?? [], error };
    }),
  );

  // A missing table would be a bug rather than a user problem, so it is surfaced
  // instead of quietly shortening the list.
  const failed = results.filter((r) => r.error);

  const entries: Entry[] = results
    .flatMap((r) =>
      (
        r.data as unknown as {
          id: string;
          doc_no: string | null;
          doc_date: string;
          status: DocStatus;
          created_at: string;
          created: { full_name: string } | null;
        }[]
      ).map((row) => ({
        key: `${r.type}-${row.id}`,
        type: r.type,
        id: row.id,
        docNo: row.doc_no,
        docDate: row.doc_date,
        status: row.status,
        createdAt: row.created_at,
        who: row.created?.full_name ?? "",
      })),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200);

  const columns: ListColumn<Entry>[] = [
    {
      key: "docNo",
      header: t("docNo"),
      role: "primary",
      cell: (e) => e.docNo ?? <span className="text-brand-subtle">—</span>,
    },
    {
      key: "type",
      header: t("type"),
      role: "secondary",
      cell: (e) => tDocs(e.type),
    },
    { key: "date", header: t("date"), role: "meta", cell: (e) => e.docDate },
    { key: "who", header: t("raisedBy"), role: "meta", cell: (e) => e.who },
    {
      key: "status",
      header: t("status"),
      role: "trailing",
      cell: (e) => <Badge tone={STATUS_TONE[e.status]}>{tStatus(e.status)}</Badge>,
    },
  ];

  const STATUSES: DocStatus[] = [
    "draft",
    "submitted",
    "approved",
    "dispatched",
    "posted",
    "cancelled",
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {failed.length > 0 && (
        <Banner tone="bad">
          {t("partialLoad", { types: failed.map((f) => tDocs(f.type)).join(", ") })}
        </Banner>
      )}

      <Card className="flex flex-col gap-3">
        <FilterRow label={t("filterType")}>
          <FilterChip href="/documents" active={!typeFilter} label={t("all")} />
          {DOC_TYPES.map((type) => (
            <FilterChip
              key={type}
              href={buildHref({ type, status: statusFilter })}
              active={typeFilter === type}
              label={tDocs(type)}
            />
          ))}
        </FilterRow>

        <FilterRow label={t("filterStatus")}>
          <FilterChip
            href={buildHref({ type: typeFilter, status: null })}
            active={!statusFilter}
            label={t("all")}
          />
          {STATUSES.map((status) => (
            <FilterChip
              key={status}
              href={buildHref({ type: typeFilter, status })}
              active={statusFilter === status}
              label={tStatus(status)}
            />
          ))}
        </FilterRow>
      </Card>

      <RecordList
        items={entries}
        columns={columns}
        rowKey={(e) => e.key}
        action={(e) => {
          const route = DOC_CONFIG[e.type].route;
          // Adjustments and count sheets have no detail screen yet. Showing a
          // dead link would be worse than showing nothing.
          if (!route) return null;
          return (
            <Link href={`${route}/${e.id}` as never} className="text-brand-brown text-sm">
              {t("open")}
            </Link>
          );
        }}
        empty={<EmptyState title={t("emptyTitle")} hint={t("emptyHint")} />}
      />
    </div>
  );
}

/** Filters are links, not client state: shareable, back-button-correct, no JS. */
function buildHref({ type, status }: { type: DocType | null; status: string | null }) {
  const search = new URLSearchParams();
  if (type) search.set("type", type);
  if (status) search.set("status", status);
  const qs = search.toString();
  return (qs ? `/documents?${qs}` : "/documents") as never;
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-brand-subtle text-xs font-semibold tracking-wider uppercase">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function FilterChip({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  return (
    <Link
      href={href as never}
      className={[
        // 32px tall targets with generous horizontal padding: these are tapped
        // on a handheld, not clicked with a mouse (D-43).
        "inline-flex h-8 touch-manipulation items-center rounded-full border px-3 text-xs transition-colors",
        active
          ? "border-brand-brown bg-brand-brown text-white"
          : "border-brand-border text-brand-dark active:bg-brand-cream",
      ].join(" ")}
    >
      {label}
    </Link>
  );
}
