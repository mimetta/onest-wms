import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, PageHeader, SectionLabel, Table, TableWrap, Td, Th } from "@/components/ui";
import { WorkflowBar } from "@/components/documents/workflow-bar";
import type { DocStatus } from "@/lib/documents/config";

type Line = {
  id: string;
  line_no: number;
  qty: number;
  note: string | null;
  products: { sku: string; name_th: string } | null;
  uoms: { code: string } | null;
};

/**
 * One requisition, with its workflow controls.
 *
 * A requisition's life ends at `approved` (D-45), so there is no Post button
 * here — WorkflowBar reads `posts: false` from the config and never offers one.
 * The fulfilling issue is raised from the issue screen, which lists approved
 * requisitions to draw from.
 */
export default async function Page({ params }: PageProps<"/requisitions/[id]">) {
  const { id } = await params;
  const user = await requirePerm("report.read");
  const t = await getTranslations("requisitions");
  const supabase = await createClient();

  const { data: header } = await supabase
    .from("requisitions")
    .select(
      `id, doc_no, doc_date, status, required_date, notes, created_by,
       departments(name_th),
       created:created_by(full_name),
       approver:approved_by(full_name), approved_at`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!header) notFound();

  const { data: lineData } = await supabase
    .from("requisition_lines")
    .select("id, line_no, qty, note, products(sku, name_th), uoms:uom_id(code)")
    .eq("header_id", id)
    .order("line_no");

  const lines = (lineData ?? []) as unknown as Line[];
  const dept = header.departments as unknown as { name_th: string } | null;
  const createdBy = header.created as unknown as { full_name: string } | null;
  const approver = header.approver as unknown as { full_name: string } | null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${t("title")} ${header.doc_no ?? ""}`.trim()}
        subtitle={dept?.name_th ?? undefined}
      />

      <Card>
        <WorkflowBar
          type="requisition"
          id={header.id}
          status={header.status as DocStatus}
          docNo={header.doc_no}
          lineCount={lines.length}
          canApprove={can(user, "requisition.approve")}
          canPost={false}
          isAuthor={header.created_by === user.id}
        />
      </Card>

      <Card className="flex flex-col gap-3">
        <SectionLabel>{t("detailsLabel")}</SectionLabel>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <Detail label={t("date")} value={header.doc_date} />
          <Detail label={t("requiredDate")} value={header.required_date ?? "—"} />
          <Detail label={t("raisedBy")} value={createdBy?.full_name ?? "—"} />
          <Detail
            label={t("approvedBy")}
            value={approver?.full_name ?? "—"}
          />
        </dl>
        {header.notes && <p className="text-brand-dark text-sm">{header.notes}</p>}
      </Card>

      <TableWrap>
        <Table>
          <thead>
            <tr>
              <Th>{t("lineNo")}</Th>
              <Th>{t("product")}</Th>
              <Th className="text-right">{t("qty")}</Th>
              <Th>{t("uom")}</Th>
              <Th>{t("note")}</Th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <Td>{l.line_no}</Td>
                <Td>
                  <span className="font-mono text-xs">{l.products?.sku}</span>
                  <span className="text-brand-muted ml-2">{l.products?.name_th}</span>
                </Td>
                <Td className="tabular text-right">
                  {Number(l.qty).toLocaleString()}
                </Td>
                <Td>{l.uoms?.code}</Td>
                <Td className="text-brand-muted">{l.note ?? ""}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
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
