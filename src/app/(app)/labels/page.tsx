import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Banner, PageHeader } from "@/components/ui";
import { LabelPicker, type PickableItem } from "./label-picker";
import type { LabelKind } from "@/lib/labels/types";

const KINDS: LabelKind[] = ["product", "shelf", "lot", "location"];

export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; ids?: string }>;
}) {
  await requirePerm("label.print");
  const t = await getTranslations("labels");
  const tm = await getTranslations("master");
  const tq = await getTranslations("qcStatus");
  const format = await getFormatter();
  const { kind: rawKind, ids } = await searchParams;

  const kind: LabelKind = KINDS.includes(rawKind as LabelKind)
    ? (rawKind as LabelKind)
    : "product";

  // Deep link from a list or detail page: /labels?kind=lot&ids=uuid,uuid
  const preselected = (ids ?? "").split(",").filter(Boolean);

  const supabase = await createClient();
  let items: PickableItem[] = [];
  let note: string | undefined;

  if (kind === "product" || kind === "shelf") {
    const { data } = await supabase
      .from("products")
      .select("id, sku, name_th, product_barcodes(barcode, is_primary)")
      .eq("is_active", true)
      .order("sku");

    const rows = (data ?? []).map((p) => {
      const codes = (p.product_barcodes ?? []) as unknown as {
        barcode: string;
        is_primary: boolean;
      }[];
      const primary = codes.find((c) => c.is_primary) ?? codes[0];
      return { p, primary, hasBarcode: Boolean(primary) };
    });

    if (kind === "shelf") {
      // Shelf-edge labels exist for products that have no barcode of their own
      // (D-35). Products carrying a factory EAN-13 are excluded — relabelling
      // them is exactly what the policy forbids.
      note = t("shelfNote");
      items = rows
        .filter((r) => !r.hasBarcode)
        .map(({ p }) => ({
          id: p.id,
          barcode: p.sku,
          primary: p.sku,
          secondary: p.name_th,
          details: [{ label: "SKU", value: p.sku }],
        }));
    } else {
      note = t("factoryNote");
      items = rows.map(({ p, primary, hasBarcode }) => ({
        id: p.id,
        barcode: primary?.barcode ?? p.sku,
        primary: primary?.barcode ?? p.sku,
        secondary: p.name_th,
        details: [{ label: "SKU", value: p.sku }],
        synthesised: !hasBarcode,
        hint: hasBarcode ? t("hasFactoryBarcode") : t("noBarcodeShelf"),
      }));
    }
  }

  if (kind === "lot") {
    note = `${t("lotNote")} ${t("qcBoxNote")}`;
    const { data } = await supabase
      .from("lots")
      // qc_status is read for the PICKER list only, so an operator can see what
      // they are printing. It is deliberately not printed on the label (D-37).
      .select(
        "id, lot_no, mfg_date, expiry_date, qc_status, created_at, products(sku, name_th)",
      )
      .order("created_at", { ascending: false })
      .limit(300);

    const dateOnly = (value: string) =>
      format.dateTime(new Date(value), {
        year: "numeric",
        month: "short",
        day: "numeric",
      });

    items = (data ?? []).map((l) => {
      const product = l.products as unknown as { sku: string; name_th: string } | null;

      const fields = [
        { label: "SKU", value: product?.sku ?? "—" },
        { label: t("lot"), value: l.lot_no },
      ];
      if (l.expiry_date)
        fields.push({ label: t("expiry"), value: dateOnly(l.expiry_date) });
      if (l.created_at)
        fields.push({ label: t("receivedDate"), value: dateOnly(l.created_at) });

      return {
        id: l.id,
        barcode: l.lot_no,
        primary: l.lot_no,
        secondary: product?.name_th,
        details: l.expiry_date
          ? [{ label: t("expiry"), value: dateOnly(l.expiry_date) }]
          : [],
        fields,
        // The label gets an empty box to tick by hand — never the status.
        qcBox: true as const,
        hint: tq(l.qc_status),
      };
    });
  }

  if (kind === "location") {
    const { data } = await supabase
      .from("locations")
      .select("id, code, barcode, zones(name_th)")
      .eq("is_active", true)
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
    shelf: t("kindShelf"),
    lot: t("kindLot"),
    location: t("kindLocation"),
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* Nothing here mints a new identifier — worth saying plainly, because
          "the system generates barcodes" is a reasonable thing to assume and
          would change how people treat the codes. */}
      <Banner tone="info">{t("encodingNote")}</Banner>

      <nav className="border-brand-border flex gap-1 overflow-x-auto border-b">
        {KINDS.map((k) => (
          <Link
            key={k}
            href={k === "product" ? "/labels" : `/labels?kind=${k}`}
            className={
              k === kind
                ? "border-brand-brown text-brand-dark -mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold whitespace-nowrap"
                : "text-brand-muted hover:text-brand-dark -mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap"
            }
          >
            {tabLabel[k]}
          </Link>
        ))}
      </nav>

      {note && <p className="text-brand-muted text-sm">{note}</p>}

      {items.length === 0 ? (
        <p className="text-brand-muted text-sm">{tm("noResults")}</p>
      ) : (
        <LabelPicker key={kind} kind={kind} items={items} preselectedIds={preselected} />
      )}
    </div>
  );
}
