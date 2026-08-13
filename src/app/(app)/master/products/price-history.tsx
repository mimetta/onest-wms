import { getFormatter, getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, SectionLabel, Table, Td, Th } from "@/components/ui";

/**
 * Purchase price history for one product.
 *
 * Rendered only when the caller holds cost.read (D-34); RLS on the table is the
 * real guard, so a missing check here would show an empty card rather than
 * leak anything. Append-only, so this is a log, not a set of editable rows.
 */
export async function PriceHistory({ productId }: { productId: string }) {
  const t = await getTranslations("master");
  const format = await getFormatter();
  const supabase = await createClient();

  const { data: prices } = await supabase
    .from("product_price_history")
    .select("id, price, currency, effective_date, source, partners(code, name_th)")
    .eq("product_id", productId)
    .order("effective_date", { ascending: false })
    .limit(20);

  return (
    <Card className="flex flex-col gap-3 px-6 py-5">
      <SectionLabel>{t("priceHistory")}</SectionLabel>

      {!prices || prices.length === 0 ? (
        <p className="text-brand-muted text-sm">{t("noPrices")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>{t("effectiveDate")}</Th>
                <Th>{t("supplier")}</Th>
                <Th>{t("price")}</Th>
                <Th>{t("priceSource")}</Th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p, i) => {
                const partner = p.partners as unknown as {
                  code: string;
                  name_th: string;
                } | null;
                return (
                  <tr key={p.id}>
                    <Td className="tabular whitespace-nowrap">
                      {format.dateTime(new Date(p.effective_date), {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                      {/* The top row is the current price: the view
                          product_latest_price picks the same one. */}
                      {i === 0 && (
                        <span className="ml-2">
                          <Badge tone="good">{t("latestPrice")}</Badge>
                        </span>
                      )}
                    </Td>
                    <Td className="text-brand-muted">
                      {partner ? `${partner.code} · ${partner.name_th}` : "—"}
                    </Td>
                    <Td className="tabular whitespace-nowrap">
                      {format.number(Number(p.price), {
                        minimumFractionDigits: 2,
                      })}{" "}
                      <span className="text-brand-subtle text-xs">{p.currency}</span>
                    </Td>
                    <Td>
                      <Badge tone={p.source === "import" ? "info" : "neutral"}>
                        {p.source}
                      </Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
