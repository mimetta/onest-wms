import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, Banner, Card, PageHeader, SectionLabel } from "@/components/ui";
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
  lots: { lot_no: string; qc_status: string } | null;
  serials: { serial_no: string } | null;
  from_location: { code: string } | null;
  to_location: { code: string } | null;
};

/**
 * One adjustment.
 *
 * The Approve button appears only for a manager, and never for the author even
 * if they hold the permission — WorkflowBar shows Approve on `canApprove`, and
 * the builder screen deliberately only ever submits (D-20, D-39). A write-off
 * approved by the person who raised it is not a control.
 */
export default async function Page({ params }: PageProps<"/adjustments/[id]">) {
  const { id } = await params;
  const user = await requirePerm("report.read");
  const t = await getTranslations("adjustments");
  const supabase = await createClient();

  const { data: header } = await supabase
    .from("adjustments")
    .select(
      `id, doc_no, doc_date, status, notes, created_by, source_cycle_count_id,
       adjustment_reasons(code, name_th, direction, is_disposal),
       created:created_by(full_name),
       approver:approved_by(full_name),
       poster:posted_by(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!header) notFound();

  const { data: lineData } = await supabase
    .from("adjustment_lines")
    .select(
      `id, line_no, qty, note,
       products(sku, name_th), uoms:uom_id(code),
       lots(lot_no, qc_status), serials(serial_no),
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

  const reason = header.adjustment_reasons as unknown as {
    code: string;
    name_th: string;
    direction: string;
    is_disposal: boolean;
  } | null;
  const createdBy = header.created as unknown as { full_name: string } | null;
  const approver = header.approver as unknown as { full_name: string } | null;
  const poster = header.poster as unknown as { full_name: string } | null;

  // Any DECREASE of a lot that has not passed QC needs lot.dispose_unpassed,
  // which only the qc role holds — not just reasons flagged is_disposal (D-62).
  // The gate is derived from the movement's endpoints, so a "Sample for testing"
  // decrease is caught exactly like a scrapping. Keying this warning on
  // is_disposal, as it originally did, meant the one case a manager would not
  // expect to be blocked was also the one case they got no warning about.
  const unpassedDecrease =
    reason?.direction === "decrease" &&
    rows.some((l) => l.lots && l.lots.qc_status !== "passed");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${t("title")} ${header.doc_no ?? ""}`.trim()}
        subtitle={reason?.name_th ?? undefined}
      />

      <Card>
        <WorkflowBar
          type="adjustment"
          id={header.id}
          status={header.status as DocStatus}
          docNo={header.doc_no}
          lineCount={lines.length}
          canApprove={can(user, "adjustment.approve")}
          canPost={can(user, "adjustment.post")}
          isAuthor={header.created_by === user.id}
        />
      </Card>

      {unpassedDecrease && <Banner tone="warn">{t("unpassedDisposalWarning")}</Banner>}

      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SectionLabel>{t("detailsLabel")}</SectionLabel>
          {reason && (
            <Badge tone={reason.direction === "increase" ? "good" : "warn"}>
              {t(`direction_${reason.direction}`)}
            </Badge>
          )}
          {reason?.is_disposal && <Badge tone="bad">{t("disposal")}</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <Detail label={t("date")} value={header.doc_date} />
          <Detail
            label={t("reason")}
            value={reason ? `${reason.name_th} (${reason.code})` : "—"}
          />
          <Detail label={t("raisedBy")} value={createdBy?.full_name ?? "—"} />
          <Detail label={t("approvedBy")} value={approver?.full_name ?? "—"} />
          <Detail label={t("postedBy")} value={poster?.full_name ?? "—"} />
          <Detail
            label={t("origin")}
            value={header.source_cycle_count_id ? t("fromCount") : t("raisedByHand")}
          />
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
