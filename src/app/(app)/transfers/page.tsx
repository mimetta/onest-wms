import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, Banner, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { RecordList, type ListColumn } from "@/components/record-list";
import { STATUS_TONE, type DocStatus } from "@/lib/documents/config";

type Row = {
  id: string;
  doc_no: string | null;
  doc_date: string;
  status: DocStatus;
  from_warehouse_id: string;
  to_warehouse_id: string;
  transfer_lines: { count: number }[];
};

export default async function Page() {
  await requirePerm("report.read");
  const t = await getTranslations("transfers");
  const tStatus = await getTranslations("status");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("transfers")
    .select(
      `id, doc_no, doc_date, status, from_warehouse_id, to_warehouse_id,
       transfer_lines(count)`,
    )
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = (data ?? []) as unknown as Row[];

  const columns: ListColumn<Row>[] = [
    {
      key: "doc_no",
      header: t("docNo"),
      role: "primary",
      cell: (r) => r.doc_no ?? <span className="text-brand-subtle">—</span>,
    },
    {
      key: "kind",
      header: t("kind"),
      role: "secondary",
      // Internal moves post in one step; cross-site ones have two legs (D-44).
      // Worth distinguishing in a list, because a `dispatched` row means
      // something is still sitting in transit waiting to be confirmed.
      cell: (r) =>
        r.from_warehouse_id === r.to_warehouse_id ? t("internal") : t("betweenSites"),
    },
    { key: "date", header: t("date"), role: "meta", cell: (r) => r.doc_date },
    {
      key: "lines",
      header: t("lines"),
      role: "meta",
      cell: (r) => r.transfer_lines?.[0]?.count ?? 0,
    },
    {
      key: "status",
      header: t("status"),
      role: "trailing",
      cell: (r) => <Badge tone={STATUS_TONE[r.status]}>{tStatus(r.status)}</Badge>,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={<LinkButton href="/transfers/new">{t("new")}</LinkButton>}
      />

      {error && <Banner tone="bad">{error.message}</Banner>}

      <RecordList
        items={rows}
        columns={columns}
        rowKey={(r) => r.id}
        action={(r) => (
          <Link href={`/transfers/${r.id}`} className="text-brand-brown text-sm">
            {t("open")}
          </Link>
        )}
        empty={<EmptyState title={t("emptyTitle")} hint={t("emptyHint")} />}
      />
    </div>
  );
}
