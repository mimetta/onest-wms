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
  so_reference: string | null;
  is_consignment: boolean;
  partners: { code: string; name_th: string } | null;
  delivery_note_lines: { count: number }[];
};

export default async function Page() {
  await requirePerm("report.read");
  const t = await getTranslations("deliveryNotes");
  const tStatus = await getTranslations("status");
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("delivery_notes")
    .select(
      `id, doc_no, doc_date, status, so_reference, is_consignment,
       partners(code, name_th), delivery_note_lines(count)`,
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
      key: "customer",
      header: t("customer"),
      role: "secondary",
      cell: (r) => r.partners?.name_th ?? "",
    },
    { key: "date", header: t("date"), role: "meta", cell: (r) => r.doc_date },
    {
      key: "so",
      header: t("soReference"),
      role: "meta",
      cell: (r) => r.so_reference ?? "—",
    },
    {
      key: "lines",
      header: t("lines"),
      role: "meta",
      cell: (r) => r.delivery_note_lines?.[0]?.count ?? 0,
    },
    {
      key: "kind",
      header: t("kind"),
      role: "trailing",
      // Consignment stock is still ours until settled, so a despatch list that
      // did not distinguish the two would misstate what has actually been sold.
      cell: (r) =>
        r.is_consignment ? <Badge tone="info">{t("consignment")}</Badge> : null,
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
        action={<LinkButton href="/delivery-notes/new">{t("new")}</LinkButton>}
      />

      {error && <Banner tone="bad">{error.message}</Banner>}

      <RecordList
        items={rows}
        columns={columns}
        rowKey={(r) => r.id}
        action={(r) => (
          <Link href={`/delivery-notes/${r.id}`} className="text-brand-brown text-sm">
            {t("open")}
          </Link>
        )}
        empty={<EmptyState title={t("emptyTitle")} hint={t("emptyHint")} />}
      />
    </div>
  );
}
