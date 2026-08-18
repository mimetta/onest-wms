import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, PageHeader, SectionLabel } from "@/components/ui";
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
};

/**
 * One issue slip.
 *
 * The Approve button appears only for a user holding issue.approve, which
 * warehouse staff deliberately do not (D-20): an issue is the one Phase 2
 * document that cannot be waved through by the person who raised it.
 */
export default async function Page({ params }: PageProps<"/issues/[id]">) {
  const { id } = await params;
  const user = await requirePerm("report.read");
  const t = await getTranslations("issues");
  const supabase = await createClient();

  const { data: header } = await supabase
    .from("issues")
    .select(
      `id, doc_no, doc_date, status, notes, created_by, requisition_id,
       departments(name_th),
       requisitions(doc_no),
       created:created_by(full_name),
       approver:approved_by(full_name),
       poster:posted_by(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!header) notFound();

  const { data: lineData } = await supabase
    .from("issue_lines")
    .select(
      `id, line_no, qty, note,
       products(sku, name_th), uoms:uom_id(code),
       lots(lot_no), serials(serial_no),
       from_location:from_location_id(code)`,
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
    toCode: null,
    note: l.note,
  }));

  const dept = header.departments as unknown as { name_th: string } | null;
  const req = header.requisitions as unknown as { doc_no: string | null } | null;
  const createdBy = header.created as unknown as { full_name: string } | null;
  const approver = header.approver as unknown as { full_name: string } | null;
  const poster = header.poster as unknown as { full_name: string } | null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${t("title")} ${header.doc_no ?? ""}`.trim()}
        subtitle={dept?.name_th ?? undefined}
      />

      <Card>
        <WorkflowBar
          type="issue"
          id={header.id}
          status={header.status as DocStatus}
          docNo={header.doc_no}
          lineCount={lines.length}
          canApprove={can(user, "issue.approve")}
          canPost={can(user, "issue.post")}
          isAuthor={header.created_by === user.id}
        />
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("detailsLabel")}</SectionLabel>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <Detail label={t("date")} value={header.doc_date} />
          <Detail
            label={t("requisition")}
            value={
              header.requisition_id ? (
                <Link
                  href={`/requisitions/${header.requisition_id}`}
                  className="text-brand-brown"
                >
                  {req?.doc_no ?? t("open")}
                </Link>
              ) : (
                t("direct")
              )
            }
          />
          <Detail label={t("raisedBy")} value={createdBy?.full_name ?? "—"} />
          <Detail label={t("approvedBy")} value={approver?.full_name ?? "—"} />
          <Detail label={t("postedBy")} value={poster?.full_name ?? "—"} />
        </dl>
        {header.notes && <p className="text-brand-dark text-sm">{header.notes}</p>}
      </Card>

      <DocumentLines
        lines={lines}
        showTo={false}
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

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-brand-subtle text-xs">{label}</dt>
      <dd className="text-brand-dark">{value}</dd>
    </div>
  );
}
