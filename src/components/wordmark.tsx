import { getTranslations } from "next-intl/server";

/**
 * Text wordmark. No logo file has been supplied yet, so this is deliberately
 * typographic rather than a placeholder image — a missing-image icon in the nav
 * of a production tool looks broken, whereas set type looks intentional. When a
 * logo arrives, only this component changes.
 */
export async function Wordmark({ compact = false }: { compact?: boolean }) {
  const t = await getTranslations("app");

  return (
    <span className="flex items-baseline gap-2">
      <span className="text-brand-brown text-base font-bold tracking-tight">
        {t("name")}
      </span>
      {!compact && <span className="text-brand-subtle text-xs">{t("tagline")}</span>}
    </span>
  );
}
