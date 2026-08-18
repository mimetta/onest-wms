import type { ReactNode } from "react";
import { Card, Table, TableWrap, Td, Th } from "./ui";

/**
 * One list, two shapes: a table from `sm` up, stacked cards below.
 *
 * Field feedback round two: "tables don't work on mobile". They do not — a
 * six-column table at 390px either scrolls sideways, which hides the columns
 * that matter, or squeezes every cell into two words. Neither is readable at
 * arm's length.
 *
 * Rather than write both layouts in six list screens and let them drift apart,
 * each column declares its ROLE, and the two renderers read the same
 * declaration:
 *
 *   primary   — the identifier. Large on a card, first column in a table.
 *   secondary — supporting name. Under the primary on a card.
 *   meta      — small label/value pairs on a card, ordinary columns in a table.
 *   trailing  — status and quantity. Right-aligned in both.
 *
 * The alternative — a `hidden sm:block` table beside a `sm:hidden` card list —
 * duplicates every column definition and guarantees that one of them is
 * eventually wrong.
 */

export type ListColumn<T> = {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  role?: "primary" | "secondary" | "meta" | "trailing";
  /** Omit from the card layout entirely — for columns that are desktop detail. */
  desktopOnly?: boolean;
};

export function RecordList<T>({
  items,
  columns,
  rowKey,
  action,
  empty,
}: {
  items: T[];
  columns: ListColumn<T>[];
  rowKey: (row: T) => string;
  /** Edit / print links. Shown in the last cell on desktop, at the card foot on mobile. */
  action?: (row: T) => ReactNode;
  empty: ReactNode;
}) {
  if (items.length === 0) {
    return <TableWrap>{empty}</TableWrap>;
  }

  const primary = columns.find((c) => c.role === "primary") ?? columns[0];
  const secondary = columns.filter((c) => c.role === "secondary");
  const meta = columns.filter((c) => c.role === "meta" && !c.desktopOnly);
  const trailing = columns.filter((c) => c.role === "trailing");

  return (
    <>
      {/* Cards — mobile */}
      <ul className="flex flex-col gap-2 sm:hidden">
        {items.map((row) => (
          <li key={rowKey(row)}>
            <Card className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col">
                  <span className="text-brand-dark font-mono text-base leading-tight font-semibold">
                    {primary.cell(row)}
                  </span>
                  {secondary.map((c) => (
                    <span key={c.key} className="text-brand-dark truncate text-sm">
                      {c.cell(row)}
                    </span>
                  ))}
                </div>
                {trailing.length > 0 && (
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {trailing.map((c) => (
                      <span key={c.key}>{c.cell(row)}</span>
                    ))}
                  </div>
                )}
              </div>

              {meta.length > 0 && (
                <dl className="text-brand-muted flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                  {meta.map((c) => (
                    <div key={c.key} className="flex gap-1">
                      <dt className="text-brand-subtle">{c.header}</dt>
                      <dd>{c.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {action && (
                <div className="border-brand-border/60 flex justify-end gap-3 border-t pt-1.5">
                  {action(row)}
                </div>
              )}
            </Card>
          </li>
        ))}
      </ul>

      {/* Table — desktop */}
      <div className="hidden sm:block">
        <TableWrap>
          <Table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <Th key={c.key}>{c.header}</Th>
                ))}
                {action && <Th />}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={rowKey(row)} className="hover:bg-brand-cream/60">
                  {columns.map((c) => (
                    <Td
                      key={c.key}
                      className={
                        c.role === "primary"
                          ? "font-mono text-xs whitespace-nowrap"
                          : c.role === "trailing"
                            ? "whitespace-nowrap"
                            : ""
                      }
                    >
                      {c.cell(row)}
                    </Td>
                  ))}
                  {action && (
                    <Td className="space-x-3 text-right whitespace-nowrap">
                      {action(row)}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      </div>
    </>
  );
}
