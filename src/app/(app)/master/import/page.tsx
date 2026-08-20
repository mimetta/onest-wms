import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, PageHeader, SectionLabel } from "@/components/ui";
import { ImportClient } from "./import-client";

type Batch = {
  id: string;
  filename: string | null;
  status: string;
  uploaded_at: string;
  committed_at: string | null;
  stats: Record<string, unknown> | null;
};

/**
 * Item master import (go-live D2).
 *
 * Past batches are listed because an import is a decision, not an event: which
 * groups somebody counted as inventory in August is a question that gets asked
 * in November, and the batch row holds the answer in its stats.
 */
export default async function Page() {
  await requirePerm("master_data.create");
  const t = await getTranslations("import");
  const supabase = await createClient();

  const { data } = await supabase
    .from("erp_import_batches")
    .select("id, filename, status, uploaded_at, committed_at, stats")
    .eq("entity_type", "product")
    .order("uploaded_at", { ascending: false })
    .limit(10);

  const batches = (data ?? []) as unknown as Batch[];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        action={
          <Link href="/master" className="text-brand-brown text-sm">
            {t("backToMaster")}
          </Link>
        }
      />

      <ImportClient />

      {batches.length > 0 && (
        <Card className="flex flex-col gap-2">
          <SectionLabel>{t("pastBatches")}</SectionLabel>
          <ul className="divide-brand-border/60 flex flex-col divide-y">
            {batches.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm"
              >
                <span className="text-brand-dark min-w-0 flex-1 truncate">
                  {b.filename ?? "—"}
                </span>
                <Badge
                  tone={
                    b.status === "committed"
                      ? "good"
                      : b.status === "failed"
                        ? "bad"
                        : "neutral"
                  }
                >
                  {t(`status_${b.status}`)}
                </Badge>
                <span className="text-brand-subtle text-xs">
                  {(b.committed_at ?? b.uploaded_at).slice(0, 16).replace("T", " ")}
                </span>
                {b.stats && typeof b.stats.created === "number" && (
                  <span className="text-brand-muted text-xs">
                    {t("batchStats", {
                      created: Number(b.stats.created ?? 0),
                      updated: Number(b.stats.updated ?? 0),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
