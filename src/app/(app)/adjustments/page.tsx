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
  source_cycle_count_id: string | null;
  adjustment_reasons: { name_th: string; is_disposal: boolean } | null;
  adjustment_lines: { count: number }[];
};

export default async function Page() {
  await requirePerm("report.read");
  const t = await getTranslations("adjustments");
  const tStatus = await getTranslations("status");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("adjustments")
    .select(
      `id, doc_no, doc_date, status, source_cycle_count_id,
       adjustment_reasons(name_th, is_disposal), adjustment_lines(count)`,
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
      key: "reason",
      header: t("reason"),
      role: "secondary",
      cell: (r) => r.adjustment_reasons?.name_th ?? "",
    },
    { key: "date", header: t("date"), role: "meta", cell: (r) => r.doc_date },
    {
      key: "lines",
      header: t("lines"),
      role: "meta",
      cell: (r) => r.adjustment_lines?.[0]?.count ?? 0,
    },
    {
      key: "origin",
      header: t("origin"),
      role: "meta",
      // A count-generated adjustment is worth distinguishing from one somebody
      // raised by hand: the first has a sheet behind it, the second has a story.
      cell: (r) => (r.source_cycle_count_id ? t("fromCount") : t("raisedByHand")),
    },
    {
      key: "disposal",
      header: t("disposalCol"),
      role: "trailing",
      cell: (r) =>
        r.adjustment_reasons?.is_disposal ? (
          <Badge tone="bad">{t("disposal")}</Badge>
        ) : null,
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
        action={<LinkButton href="/adjustments/new">{t("new")}</LinkButton>}
      />

      {error && <Banner tone="bad">{error.message}</Banner>}

      <RecordList
        items={rows}
        columns={columns}
        rowKey={(r) => r.id}
        action={(r) => (
          <Link href={`/adjustments/${r.id}`} className="text-brand-brown text-sm">
            {t("open")}
          </Link>
        )}
        empty={<EmptyState title={t("emptyTitle")} hint={t("emptyHint")} />}
      />
    </div>
  );
}
