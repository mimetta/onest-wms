"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

export type ActivityRow = {
  id: number;
  occurredAt: string;
  sku: string;
  productName: string;
  qty: number;
  uomCode: string;
  fromCode: string | null;
  toCode: string | null;
  documentType: string;
  userName: string;
};

/**
 * Live movement feed.
 *
 * Half of the compensating control for goods receipts posting without an
 * approver (D-22): a receipt has to be visible as it happens, not at month end.
 *
 * Seeded from the server render so the panel is populated on first paint, then
 * kept current by a Realtime subscription. Realtime applies RLS per subscriber,
 * so this shows only what the signed-in user could already query.
 */
export function ActivityFeed({ initial }: { initial: ActivityRow[] }) {
  const t = useTranslations("dashboard");
  const format = useFormatter();
  const [rows, setRows] = useState(initial);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("stock-movements-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "stock_movements" },
        async (payload) => {
          // The payload carries ids, not names. One small lookup against the
          // resolved view keeps the feed readable without duplicating join
          // logic here.
          const { data } = await supabase
            .from("stock_movement_path")
            .select("*")
            .eq("movement_id", (payload.new as { id: number }).id)
            .maybeSingle();

          if (!data) return;

          setRows((prev) => [
            {
              id: Number(data.movement_id),
              occurredAt: data.occurred_at,
              sku: data.sku,
              productName: data.product_name_th,
              qty: Number(data.qty),
              uomCode: data.uom_code,
              fromCode: data.from_location_code,
              toCode: data.to_location_code,
              documentType: data.document_type,
              userName: data.user_name,
            },
            // Cap the list: this panel is "what just happened", and an
            // unbounded array on a screen left open all day is a slow leak.
            ...prev.slice(0, 29),
          ]);
        },
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      {live && (
        <span className="text-brand-subtle flex items-center gap-1.5 text-xs">
          <span
            aria-hidden
            className="bg-brand-brown inline-block size-1.5 rounded-full"
          />
          {t("activityLive")}
        </span>
      )}

      {rows.length === 0 ? (
        <p className="text-brand-muted text-sm">{t("noActivity")}</p>
      ) : (
        <ul className="divide-brand-border/60 flex flex-col divide-y">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
              <span className="text-brand-subtle w-20 shrink-0 text-xs">
                {format.dateTime(new Date(row.occurredAt), {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="text-brand-dark min-w-0 flex-1 truncate text-sm">
                {row.productName}
              </span>
              <span className="tabular text-brand-dark text-sm font-semibold">
                {row.qty.toLocaleString()} {row.uomCode}
              </span>
              <span className="text-brand-subtle font-mono text-xs">
                {row.fromCode ?? "—"} → {row.toCode ?? "—"}
              </span>
              <span className="text-brand-muted text-xs">{row.userName}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
