import { getTranslations } from "next-intl/server";
import { Badge } from "./ui";

/**
 * Marks a product or partner that was created here and has not yet been matched
 * to an AccCloud record (D-33).
 *
 * Shown on both list and detail, deliberately: someone scanning a list needs to
 * see which records accounting does not know about yet, and someone editing one
 * needs to know their edit to the code may be superseded by the next import.
 *
 * Records already linked get no badge at all — linked is the normal state, and
 * badging everything would make the warning invisible.
 */
export async function SourceBadge({
  source,
  linkedAt,
}: {
  source: string;
  linkedAt: string | null;
}) {
  const t = await getTranslations("master");
  const awaiting = source === "local" && !linkedAt;
  if (!awaiting) return null;

  return <Badge tone="warn">{t("sourceLocal")}</Badge>;
}
