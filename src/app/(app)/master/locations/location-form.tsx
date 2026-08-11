"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  LinkButton,
  Select,
} from "@/components/ui";
import { saveLocation, type LocationFormState } from "./actions";

export type LocationValues = {
  id?: string;
  code: string;
  barcode: string;
  type: string;
  zone_id: string;
  partner_id: string;
  counts_as_available: boolean;
  blocks_consumption: boolean;
  is_active: boolean;
};

/**
 * Defaults per type, mirroring locations_apply_type_defaults() in migration
 * 0003. Duplicated here on purpose: the trigger is the authority, but a form
 * that silently flips two checkboxes after save is confusing, so the UI shows
 * what the database is going to do before it does it.
 */
const TYPE_DEFAULTS: Record<string, { available: boolean; blocks: boolean }> = {
  receiving: { available: false, blocks: false },
  qc_hold: { available: false, blocks: true },
  storage: { available: true, blocks: false },
  picking: { available: true, blocks: false },
  staging: { available: false, blocks: false },
  shipping: { available: false, blocks: false },
  quarantine: { available: false, blocks: true },
  scrap: { available: false, blocks: true },
  consignment_site: { available: false, blocks: false },
};

export function LocationForm({
  values,
  zones,
  customers,
}: {
  values: LocationValues;
  zones: { id: string; code: string; name_th: string }[];
  customers: { id: string; code: string; name_th: string }[];
}) {
  const t = useTranslations("master");
  const tc = useTranslations("common");
  const [state, formAction, pending] = useActionState<LocationFormState, FormData>(
    saveLocation,
    {},
  );

  const [type, setType] = useState(values.type);
  const [available, setAvailable] = useState(values.counts_as_available);
  const [blocks, setBlocks] = useState(values.blocks_consumption);

  // Changing the type resets the two flags to that type's defaults. They stay
  // editable, because a warehouse can have a storage bin it does not want
  // picked from.
  function onTypeChange(next: string) {
    setType(next);
    const d = TYPE_DEFAULTS[next];
    if (d) {
      setAvailable(d.available);
      setBlocks(d.blocks);
    }
  }

  const typeOptions = [
    ["storage", t("typeStorage")],
    ["picking", t("typePicking")],
    ["receiving", t("typeReceiving")],
    ["qc_hold", t("typeQcHold")],
    ["staging", t("typeStaging")],
    ["shipping", t("typeShipping")],
    ["quarantine", t("typeQuarantine")],
    ["scrap", t("typeScrap")],
    ["consignment_site", t("typeConsignment")],
  ] as const;

  const isConsignment = type === "consignment_site";

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {values.id && <input type="hidden" name="id" value={values.id} />}

      {state.error && <Banner tone="bad">{t(state.error)}</Banner>}

      <Card className="flex flex-col gap-4 px-6 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("code")}>
            <Input
              name="code"
              defaultValue={values.code}
              required
              autoFocus
              placeholder="A-01-01"
              className="font-mono uppercase"
            />
          </Field>

          <Field label={t("barcode")} hint={t("barcodeHint")}>
            <Input name="barcode" defaultValue={values.barcode} className="font-mono" />
          </Field>

          <Field label={t("locationType")}>
            <Select
              name="type"
              value={type}
              onChange={(e) => onTypeChange(e.target.value)}
            >
              {typeOptions.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>

          {isConsignment ? (
            <Field label={t("partner")}>
              <Select name="partner_id" defaultValue={values.partner_id} required>
                <option value="">—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name_th}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label={t("inZone")}>
              <Select name="zone_id" defaultValue={values.zone_id}>
                <option value="">—</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.code} · {z.name_th}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>

        <div className="border-brand-border flex flex-col gap-3 border-t pt-4">
          <div className="flex flex-col gap-1">
            <Checkbox
              name="counts_as_available"
              checked={available}
              onChange={(e) => setAvailable(e.target.checked)}
              label={t("availableForPicking")}
            />
            <p className="text-brand-subtle pl-6 text-xs">{t("availableHint")}</p>
          </div>

          <div className="flex flex-col gap-1">
            <Checkbox
              name="blocks_consumption"
              checked={blocks}
              onChange={(e) => setBlocks(e.target.checked)}
              label={t("blocksConsumption")}
            />
            <p className="text-brand-subtle pl-6 text-xs">{t("blocksHint")}</p>
          </div>

          <Checkbox
            name="is_active"
            defaultChecked={values.is_active}
            label={t("isActive")}
          />
        </div>
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? tc("loading") : tc("save")}
        </Button>
        <LinkButton href="/master/locations">{tc("cancel")}</LinkButton>
      </div>
    </form>
  );
}
