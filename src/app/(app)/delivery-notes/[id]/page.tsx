import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, PageHeader, SectionLabel } from "@/components/ui";
import { WorkflowBar } from "@/components/documents/workflow-bar";
import { DocumentLines, type DocumentLine } from "@/components/documents/document-lines";
import {
  DeliveryNotePrint,
  type DeliveryNotePrintData,
} from "@/components/documents/delivery-note-print";
import { PrintButton } from "@/components/documents/print-button";
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

/**
 * One delivery note, with the printable sheet inline.
 *
 * The sheet is rendered on the page and hidden on screen rather than opened in a
 * separate print route: it has to be printed at the moment of despatch, from a
 * handheld, and a second navigation is a second thing that can fail while a
 * lorry waits. `print:hidden` / `hidden print:block` swap the two.
 */
export default async function Page({ params }: PageProps<"/delivery-notes/[id]">) {
  const { id } = await params;
  const user = await requirePerm("report.read");
  const t = await getTranslations("deliveryNotes");
  const supabase = await createClient();

  const { data: header } = await supabase
    .from("delivery_notes")
    .select(
      `id, doc_no, doc_date, status, notes, created_by, so_reference, is_consignment,
       partners(code, name_th, address_th),
       warehouses(name_th),
       created:created_by(full_name),
       approver:approved_by(full_name),
       poster:posted_by(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!header) notFound();

  const { data: lineData } = await supabase
    .from("delivery_note_lines")
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

  const partner = header.partners as unknown as {
    code: string;
    name_th: string;
    address_th: string | null;
  } | null;
  const warehouse = header.warehouses as unknown as { name_th: string } | null;
  const createdBy = header.created as unknown as { full_name: string } | null;
  const approver = header.approver as unknown as { full_name: string } | null;
  const poster = header.poster as unknown as { full_name: string } | null;

  const printData: DeliveryNotePrintData = {
    docNo: header.doc_no,
    docDate: header.doc_date,
    soReference: header.so_reference,
    isConsignment: header.is_consignment,
    partnerName: partner?.name_th ?? "",
    partnerCode: partner?.code ?? "",
    partnerAddress: partner?.address_th ?? null,
    warehouseName: warehouse?.name_th ?? "",
    notes: header.notes,
    lines,
  };

  return (
    <>
      <div className="flex flex-col gap-4 print:hidden">
        <PageHeader
          title={`${t("title")} ${header.doc_no ?? ""}`.trim()}
          subtitle={partner?.name_th ?? undefined}
          action={<PrintButton label={t("print")} />}
        />

        <Card>
          <WorkflowBar
            type="delivery_note"
            id={header.id}
            status={header.status as DocStatus}
            docNo={header.doc_no}
            lineCount={lines.length}
            canApprove={can(user, "delivery_note.approve")}
            canPost={can(user, "delivery_note.post")}
            isAuthor={header.created_by === user.id}
          />
        </Card>

        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <SectionLabel>{t("detailsLabel")}</SectionLabel>
            {header.is_consignment && <Badge tone="info">{t("consignment")}</Badge>}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Detail label={t("date")} value={header.doc_date} />
            <Detail label={t("soReference")} value={header.so_reference ?? "—"} />
            <Detail label={t("raisedBy")} value={createdBy?.full_name ?? "—"} />
            <Detail label={t("approvedBy")} value={approver?.full_name ?? "—"} />
            <Detail label={t("postedBy")} value={poster?.full_name ?? "—"} />
          </dl>
          {header.notes && <p className="text-brand-dark text-sm">{header.notes}</p>}
        </Card>

        <DocumentLines
          lines={lines}
          showTo={header.is_consignment}
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

      {/* The paper. Hidden on screen, the only thing on the page when printed. */}
      <div className="hidden print:block">
        <DeliveryNotePrint data={printData} />
      </div>
    </>
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
