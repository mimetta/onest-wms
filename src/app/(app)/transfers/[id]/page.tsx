import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, Card, PageHeader, SectionLabel } from "@/components/ui";
import { WorkflowBar } from "@/components/documents/workflow-bar";
import { DocumentLines, type DocumentLine } from "@/components/documents/document-lines";
import type { DocStatus } from "@/lib/documents/config";

type LineRow = {
  id: string;
  line_no: number;
  qty: number;
  note: string | null;
  products: { sku: string; name_th: string } | null;
  uoms: { code: string } | null;
  lots: { lot_no: string } | null;
  serials: { serial_no: string } | null;
  from_location: { code: string } | null;
  to_location: { code: string } | null;
};

export default async function Page({ params }: PageProps<"/transfers/[id]">) {
  const { id } = await params;
  const user = await requirePerm("report.read");
  const t = await getTranslations("transfers");
  const supabase = await createClient();

  const { data: header } = await supabase
    .from("transfers")
    .select(
      `id, doc_no, doc_date, status, notes, created_by,
       from_warehouse_id, to_warehouse_id,
       created:created_by(full_name),
       approver:approved_by(full_name),
       poster:posted_by(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!header) notFound();

  const { data: lineData } = await supabase
    .from("transfer_lines")
    .select(
      `id, line_no, qty, note,
       products(sku, name_th), uoms:uom_id(code),
       lots(lot_no), serials(serial_no),
       from_location:from_location_id(code), to_location:to_location_id(code)`,
    )
    .eq("header_id", id)
    .order("line_no");

  const rows = (lineData ?? []) as unknown as LineRow[];
  const lines: DocumentLine[] = rows.map((l) => ({
    id: l.id,
    lineNo: l.line_no,
    sku: l.products?.sku ?? "",
    nameTh: l.products?.name_th ?? "",
    lotNo: l.lots?.lot_no ?? null,
    serialNo: l.serials?.serial_no ?? null,
    qty: Number(l.qty),
    uomCode: l.uoms?.code ?? "",
    fromCode: l.from_location?.code ?? null,
    toCode: l.to_location?.code ?? null,
    note: l.note,
  }));

  const internal = header.from_warehouse_id === header.to_warehouse_id;
  const status = header.status as DocStatus;
  const createdBy = header.created as unknown as { full_name: string } | null;
  const approver = header.approver as unknown as { full_name: string } | null;
  const poster = header.poster as unknown as { full_name: string } | null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${t("title")} ${header.doc_no ?? ""}`.trim()}
        subtitle={internal ? t("internal") : t("betweenSites")}
      />

      {status === "dispatched" && (
        // The whole point of the in_transit bin (D-05): stock in the lorry is a
        // real balance somebody can look up, and this is the screen that closes
        // the loop.
        <Banner tone="warn">{t("awaitingReceipt")}</Banner>
      )}

      <Card>
        <WorkflowBar
          type="transfer"
          id={header.id}
          status={status}
          docNo={header.doc_no}
          lineCount={lines.length}
          canApprove={can(user, "transfer.approve")}
          canPost={can(user, "transfer.post")}
          isAuthor={header.created_by === user.id}
          postLabelKey={status === "dispatched" ? "confirmReceive" : "post"}
        />
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("detailsLabel")}</SectionLabel>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <Detail label={t("date")} value={header.doc_date} />
          <Detail label={t("raisedBy")} value={createdBy?.full_name ?? "—"} />
          <Detail label={t("approvedBy")} value={approver?.full_name ?? "—"} />
          <Detail label={t("postedBy")} value={poster?.full_name ?? "—"} />
        </dl>
        {header.notes && <p className="text-brand-dark text-sm">{header.notes}</p>}
      </Card>

      <DocumentLines
        lines={lines}
        showTo
        labels={{
          lineNo: t("lineNo"),
          product: t("product"),
          lot: t("lot"),
          qty: t("qty"),
          from: t("from"),
          to: t("to"),
          note: t("note"),
        }}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-brand-subtle text-xs">{label}</dt>
      <dd className="text-brand-dark">{value}</dd>
    </div>
  );
}
