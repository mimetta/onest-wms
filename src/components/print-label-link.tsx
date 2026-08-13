import Link from "next/link";
import type { Route } from "next";
import { getTranslations } from "next-intl/server";

/**
 * Deep link into the label screen with one record already selected.
 *
 * Printing a label is something you decide while looking at the record, not
 * while looking at a list of everything — so the action belongs here, and the
 * label screen accepts `ids` rather than making the user find the row again.
 */
export async function PrintLabelLink({
  kind,
  id,
  compact = false,
}: {
  kind: "product" | "shelf" | "lot" | "location";
  id: string;
  compact?: boolean;
}) {
  const t = await getTranslations("labels");
  const href = `/labels?kind=${kind}&ids=${id}` as Route;

  return (
    <Link
      href={href}
      className={
        compact
          ? "text-brand-muted hover:text-brand-brown text-sm whitespace-nowrap"
          : "border-brand-border text-brand-dark hover:bg-brand-cream inline-flex h-9 items-center rounded-md border px-4 text-sm"
      }
    >
      {t("printLabel")}
    </Link>
  );
}
