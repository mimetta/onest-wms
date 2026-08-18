import { Table, TableWrap, Td, Th } from "@/components/ui";

/**
 * The lines of a stock-moving document.
 *
 * Issues, transfers and delivery notes all carry the same line shape — product,
 * lot or serial, quantity, and one or two endpoints — so they share one table
 * rather than three that drift. Columns that do not apply are omitted by the
 * caller passing the fields as null: an issue has no destination, because
 * consumed stock leaves the company (D-02).
 */

export type DocumentLine = {
  id: string;
  lineNo: number;
  sku: string;
  nameTh: string;
  lotNo: string | null;
  serialNo: string | null;
  qty: number;
  uomCode: string;
  fromCode: string | null;
  toCode: string | null;
  note: string | null;
};

export function DocumentLines({
  lines,
  labels,
  showTo,
}: {
  lines: DocumentLine[];
  labels: {
    lineNo: string;
    product: string;
    lot: string;
    qty: string;
    from: string;
    to: string;
    note: string;
  };
  showTo: boolean;
}) {
  return (
    <TableWrap>
      <Table>
        <thead>
          <tr>
            <Th>{labels.lineNo}</Th>
            <Th>{labels.product}</Th>
            <Th>{labels.lot}</Th>
            <Th className="text-right">{labels.qty}</Th>
            <Th>{labels.from}</Th>
            {showTo && <Th>{labels.to}</Th>}
            <Th>{labels.note}</Th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <Td>{l.lineNo}</Td>
              <Td>
                <span className="font-mono text-xs">{l.sku}</span>
                <span className="text-brand-muted ml-2">{l.nameTh}</span>
              </Td>
              <Td className="text-brand-muted font-mono text-xs">
                {l.serialNo ?? l.lotNo ?? "—"}
              </Td>
              <Td className="tabular text-right whitespace-nowrap">
                {l.qty.toLocaleString()} {l.uomCode}
              </Td>
              <Td className="font-mono text-xs">{l.fromCode ?? "—"}</Td>
              {showTo && (
                <Td className="font-mono text-xs">
                  {/* An issue line's destination is deliberately empty: the
                      stock left the company. Shown as a dash rather than
                      hidden, so the column means the same thing everywhere. */}
                  {l.toCode ?? "—"}
                </Td>
              )}
              <Td className="text-brand-muted">{l.note ?? ""}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </TableWrap>
  );
}
