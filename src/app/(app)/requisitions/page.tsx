import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, LinkButton, EmptyState, Badge, Banner } from "@/components/ui";
import { RecordList, type ListColumn } from "@/components/record-list";
import { STATUS_TONE, type DocStatus } from "@/lib/documents/config";

type Row = {
  id: string;
  doc_no: string | null;
  doc_date: string;
  status: DocStatus;
  required_date: string | null;
  departments: { name_th: string } | null;
  requisition_lines: { count: number }[];
};

/**
 * ใบขอเบิก — the request list.
 *
 * Two audiences on one screen: staff checking whether their request has been
 * approved yet, and the manager working through what needs approving. Sorted
 * newest first with status prominent, because both questions are answered by
 * the status column.
 */
export default async function Page() {
  await requirePerm("report.read");
  const t = await getTranslations("requisitions");
  const tStatus = await getTranslations("status");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("requisitions")
    .select(
      `id, doc_no, doc_date, status, required_date,
       departments(name_th),
       requisition_lines(count)`,
    )
    .order("created_at", { ascending: false })
    .limit(100);

  const rows = (data ?? []) as unknown as Row[];

  const columns: ListColumn<Row>[] = [
    {
      key: "doc_no",
      header: t("docNo"),
      role: "primary",
      // An unnumbered requisition is a draft: it gets its number at approval
      // (D-45), so showing a blank here is correct rather than a gap.
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
      key: "required",
      header: t("requiredDate"),
      role: "meta",
      cell: (r) => r.required_date ?? "—",
    },
    {
      key: "lines",
      header: t("lines"),
      role: "meta",
      cell: (r) => r.requisition_lines?.[0]?.count ?? 0,
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
        action={<LinkButton href="/requisitions/new">{t("new")}</LinkButton>}
      />

      {error && <Banner tone="bad">{error.message}</Banner>}

      <RecordList
        items={rows}
        columns={columns}
        rowKey={(r) => r.id}
        action={(r) => (
          <Link href={`/requisitions/${r.id}`} className="text-brand-brown text-sm">
            {t("open")}
          </Link>
        )}
        empty={<EmptyState title={t("emptyTitle")} hint={t("emptyHint")} />}
      />
    </div>
  );
}
