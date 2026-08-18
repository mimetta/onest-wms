import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, PageHeader } from "@/components/ui";
import { ensureDraft, type ReceiptLine } from "./actions";
import { ReceiveClient } from "./receive-client";

/**
 * Goods receipt · ใบรับสินค้า
 *
 * Posts on scan completion with no separate approver (D-22). The compensating
 * control is the dashboard: receipts posted today, and goods_receipt entries in
 * the activity feed.
 */
export default async function ReceivePage() {
  await requirePerm("goods_receipt.create");
  const t = await getTranslations("receive");
  const supabase = await createClient();

  const draft = await ensureDraft();
  if (!draft.ok) {
    return (
      <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
        <PageHeader title={t("title")} />
        <Banner tone="bad">{t(draft.error)}</Banner>
      </div>
    );
  }

  const receiptId = draft.data!;

  // Lines already on the draft: a receipt interrupted by a dead battery or a
  // closed tab resumes exactly where it stopped.
  const { data: lineRows } = await supabase
    .from("goods_receipt_lines")
    .select(
      "id, line_no, qty, products(sku, name_th), lots(lot_no), serials(serial_no), uoms(code), locations(code, type)",
    )
    .eq("header_id", receiptId)
    .order("line_no");

  const lines: ReceiptLine[] = (lineRows ?? []).map((row) => {
    const product = row.products as unknown as { sku: string; name_th: string } | null;
    const lot = row.lots as unknown as { lot_no: string } | null;
    const serial = row.serials as unknown as { serial_no: string } | null;
    const uom = row.uoms as unknown as { code: string } | null;
    const location = row.locations as unknown as { code: string; type: string } | null;

    return {
      id: row.id,
      lineNo: row.line_no,
      sku: product?.sku ?? "",
      nameTh: product?.name_th ?? "",
      lotNo: lot?.lot_no ?? null,
      serialNo: serial?.serial_no ?? null,
      qty: Number(row.qty),
      uomCode: uom?.code ?? "",
      toLocationCode: location?.code ?? "",
      toQcHold: location?.type === "qc_hold",
    };
  });

  // Default destination: the receiving bay. The receiver can scan any other bin
  // to change it, but the common case needs no input at all.
  const { data: defaultBin } = await supabase
    .from("locations")
    .select("id, code")
    .eq("type", "receiving")
    .eq("is_active", true)
    .order("code")
    .limit(1)
    .maybeSingle();

  return (
    <div className="flex max-w-3xl flex-col gap-4 sm:gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <ReceiveClient
        receiptId={receiptId}
        initialLines={lines}
        initialBin={defaultBin ?? null}
      />
    </div>
  );
}
