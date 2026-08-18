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
  departments: { name_th: string } | null;
  requisitions: { doc_no: string | null } | null;
  issue_lines: { count: number }[];
};

export default async function Page() {
  await requirePerm("report.read");
  const t = await getTranslations("issues");
  const tStatus = await getTranslations("status");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("issues")
    .select(
      `id, doc_no, doc_date, status,
       departments(name_th), requisitions(doc_no), issue_lines(count)`,
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
      key: "department",
      header: t("department"),
      role: "secondary",
      cell: (r) => r.departments?.name_th ?? "",
    },
    { key: "date", header: t("date"), role: "meta", cell: (r) => r.doc_date },
    {
      key: "requisition",
      header: t("requisition"),
      role: "meta",
      // A blank here means a direct issue, which only a manager may raise
      // (D-46) — worth being able to see at a glance in a review.
      cell: (r) => r.requisitions?.doc_no ?? t("direct"),
    },
    {
      key: "lines",
      header: t("lines"),
      role: "meta",
      cell: (r) => r.issue_lines?.[0]?.count ?? 0,
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
        action={<LinkButton href="/issues/new">{t("new")}</LinkButton>}
      />

      {error && <Banner tone="bad">{error.message}</Banner>}

      <RecordList
        items={rows}
        columns={columns}
        rowKey={(r) => r.id}
        action={(r) => (
          <Link href={`/issues/${r.id}`} className="text-brand-brown text-sm">
            {t("open")}
          </Link>
        )}
        empty={<EmptyState title={t("emptyTitle")} hint={t("emptyHint")} />}
      />
    </div>
  );
}
