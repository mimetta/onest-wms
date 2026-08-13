import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { LabelPicker, type PickableItem } from "./label-picker";
import type { LabelKind } from "@/lib/labels/types";

const KINDS: LabelKind[] = ["product", "lot", "location"];

export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  await requirePerm("label.print");
  const t = await getTranslations("labels");
  const tm = await getTranslations("master");
  const format = await getFormatter();
  const { kind: rawKind } = await searchParams;

  const kind: LabelKind = KINDS.includes(rawKind as LabelKind)
    ? (rawKind as LabelKind)
    : "product";

  const supabase = await createClient();
  let items: PickableItem[] = [];

  if (kind === "product") {
    const { data } = await supabase
      .from("products")
      .select("id, sku, name_th, product_barcodes(barcode, is_primary)")
      .eq("is_active", true)
      .order("sku");

    items = (data ?? []).map((p) => {
      const codes = (p.product_barcodes ?? []) as unknown as {
        barcode: string;
        is_primary: boolean;
      }[];
      const primary = codes.find((c) => c.is_primary) ?? codes[0];
      return {
        id: p.id,
        // A product with no barcode row still needs a label — printing its SKU
        // is how it gets one. AccCloud supplies no barcodes (D-24), so this is
        // the normal path on day one, not an edge case.
        barcode: primary?.barcode ?? p.sku,
        primary: primary?.barcode ?? p.sku,
        secondary: p.name_th,
        details: [{ label: "SKU", value: p.sku }],
        synthesised: !primary,
      };
    });
  }

  if (kind === "lot") {
    const { data } = await supabase
      .from("lots")
      .select("id, lot_no, expiry_date, qc_status, products(sku, name_th)")
      .order("created_at", { ascending: false })
      .limit(300);

    items = (data ?? []).map((l) => {
      const product = l.products as unknown as { sku: string; name_th: string } | null;
      const details: { label: string; value: string }[] = [];
      if (l.expiry_date) {
        details.push({
          label: t("expiry"),
          value: format.dateTime(new Date(l.expiry_date), {
            year: "numeric",
            month: "short",
            day: "numeric",
          }),
        });
      }
      return {
        id: l.id,
        barcode: l.lot_no,
        primary: l.lot_no,
        secondary: product ? `${product.sku} · ${product.name_th}` : undefined,
        details,
      };
    });
  }

  if (kind === "location") {
    const { data } = await supabase
      .from("locations")
      .select("id, code, barcode, is_virtual, zones(name_th)")
      .eq("is_active", true)
      // Virtual bins are never physically visited, so a label for one would be
      // a sticker with nowhere to go.
      .eq("is_virtual", false)
      .order("code");

    items = (data ?? []).map((l) => {
      const zone = l.zones as unknown as { name_th: string } | null;
      return {
        id: l.id,
        barcode: l.barcode,
        primary: l.code,
        secondary: zone?.name_th,
      };
    });
  }

  const tabLabel: Record<LabelKind, string> = {
    product: t("kindProduct"),
    lot: t("kindLot"),
    location: t("kindLocation"),
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <nav className="border-brand-border flex gap-1 border-b">
        {KINDS.map((k) => (
          <Link
            key={k}
            href={k === "product" ? "/labels" : `/labels?kind=${k}`}
            className={
              k === kind
                ? "border-brand-brown text-brand-dark -mb-px border-b-2 px-3 py-2 text-sm font-semibold"
                : "text-brand-muted hover:text-brand-dark -mb-px border-b-2 border-transparent px-3 py-2 text-sm"
            }
          >
            {tabLabel[k]}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <p className="text-brand-muted text-sm">{tm("noResults")}</p>
      ) : (
        <LabelPicker key={kind} kind={kind} items={items} />
      )}
    </div>
  );
}
