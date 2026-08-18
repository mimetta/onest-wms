"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Banner,
  Button,
  Card,
  Field,
  Input,
  SectionLabel,
  Select,
} from "@/components/ui";
import { generateBins, type LocationFormState } from "./actions";

/**
 * Bulk bin creation for go-live (checklist item D3).
 *
 * The live preview matters more than it looks: the operator sees the exact
 * codes before committing, so a wrong prefix is caught here rather than
 * discovered later as forty mislabelled shelves.
 */
export function BinGenerator({
  zones,
}: {
  zones: { id: string; code: string; name_th: string }[];
}) {
  const t = useTranslations("master");
  const [state, formAction, pending] = useActionState<LocationFormState, FormData>(
    generateBins,
    {},
  );

  const [prefix, setPrefix] = useState("A");
  const [bays, setBays] = useState(4);
  const [levels, setLevels] = useState(3);

  const total = Math.max(0, bays) * Math.max(0, levels);
  const sample = (bay: number, level: number) =>
    `${prefix.toUpperCase()}-${String(bay).padStart(2, "0")}-${String(level).padStart(2, "0")}`;

  return (
    <Card className="flex flex-col gap-4 px-4 py-3 sm:px-6 sm:py-5">
      <div className="flex flex-col gap-1">
        <SectionLabel>{t("generateBins")}</SectionLabel>
        <p className="text-brand-muted text-sm">{t("generateHint")}</p>
      </div>

      {state.error && <Banner tone="bad">{t(state.error)}</Banner>}
      {state.created !== undefined && (
        <Banner tone="good">
          {t("generated", { count: state.created })}
          {state.skipped ? ` · ${t("generateSkipped", { count: state.skipped })}` : ""}
        </Banner>
      )}

      <form action={formAction} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label={t("prefix")}>
            <Input
              name="prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
              required
              className="font-mono uppercase"
            />
          </Field>

          <Field label={t("bays")}>
            <Input
              name="bays"
              type="number"
              min={1}
              max={99}
              inputMode="numeric"
              value={bays}
              onChange={(e) => setBays(Number(e.target.value))}
            />
          </Field>

          <Field label={t("levels")}>
            <Input
              name="levels"
              type="number"
              min={1}
              max={99}
              inputMode="numeric"
              value={levels}
              onChange={(e) => setLevels(Number(e.target.value))}
            />
          </Field>

          <Field label={t("inZone")}>
            <Select name="zone_id" defaultValue="">
              <option value="">—</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.code}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <input type="hidden" name="type" value="storage" />

        <div className="bg-brand-cream border-brand-border flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
          <span className="text-brand-subtle text-xs uppercase">{t("preview")}</span>
          <span className="text-brand-dark font-mono text-xs">
            {prefix ? `${sample(1, 1)} … ${sample(bays || 1, levels || 1)}` : "—"}
          </span>
          <span className="text-brand-muted text-xs">
            ({t("count", { count: total })})
          </span>
        </div>

        <div>
          <Button type="submit" variant="secondary" disabled={pending || total < 1}>
            {pending ? "…" : t("generateBins")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
