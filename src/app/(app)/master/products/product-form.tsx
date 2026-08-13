"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  LinkButton,
  SectionLabel,
  Select,
} from "@/components/ui";
import { createProduct, updateProduct, type ProductFormState } from "./actions";

export type ProductValues = {
  id?: string;
  sku: string;
  name_th: string;
  name_en: string;
  category_id: string;
  base_uom_id: string;
  tracking_mode: string;
  shelf_life_days: string;
  requires_qc: boolean;
  is_consignment_eligible: boolean;
  acccloud_item_code: string;
  supplier_moq: string;
  is_active: boolean;
  source: string;
  acccloud_linked_at: string | null;
};

export function ProductForm({
  values,
  categories,
  uoms,
  trackingEditable,
  created,
  identityEditable = true,
}: {
  values: ProductValues;
  categories: { id: string; name_th: string }[];
  uoms: { id: string; code: string; name_th: string }[];
  /** False once the product has stock movements — tracking_mode is frozen (D-12). */
  trackingEditable: boolean;
  created?: boolean;
  /** False for non-admins: AccCloud masters identity, we master enrichment. */
  identityEditable?: boolean;
}) {
  const t = useTranslations("master");
  const tc = useTranslations("common");
  const isNew = !values.id;

  const [state, formAction, pending] = useActionState<ProductFormState, FormData>(
    isNew ? createProduct : updateProduct,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {values.id && <input type="hidden" name="id" value={values.id} />}
      <input
        type="hidden"
        name="tracking_editable"
        value={trackingEditable ? "1" : "0"}
      />

      {created && <Banner tone="good">{t("createdOk")}</Banner>}
      {state.error && <Banner tone="bad">{t(state.error)}</Banner>}

      {/* Two different warnings, never both: either this record is not known to
          AccCloud yet, or it is and its identity fields are not ours to own. */}
      {values.source === "local" && !values.acccloud_linked_at ? (
        <Banner tone="warn">{t("sourceLocalHint")}</Banner>
      ) : (
        values.id && <Banner tone="info">{t("identityFromAcccloud")}</Banner>
      )}

      <Card className="flex flex-col gap-4 px-6 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("sku")}>
            <Input
              name="sku"
              defaultValue={values.sku}
              required
              autoFocus={isNew}
              readOnly={!identityEditable}
              className="font-mono"
            />
          </Field>

          <Field label={t("acccloudCode")}>
            <Input
              name="acccloud_item_code"
              defaultValue={values.acccloud_item_code}
              className="font-mono"
            />
          </Field>

          <Field label={t("nameTh")}>
            <Input name="name_th" defaultValue={values.name_th} required />
          </Field>

          <Field label={t("nameEn")}>
            <Input name="name_en" defaultValue={values.name_en} />
          </Field>

          <Field label={t("category")}>
            <Select name="category_id" defaultValue={values.category_id}>
              <option value="">—</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_th}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t("baseUom")}>
            <Select name="base_uom_id" defaultValue={values.base_uom_id} required>
              <option value="">—</option>
              {uoms.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code} · {u.name_th}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label={t("tracking")}
            hint={trackingEditable ? t("trackingWarning") : undefined}
            error={trackingEditable ? undefined : t("trackingLocked")}
          >
            <Select
              name="tracking_mode"
              defaultValue={values.tracking_mode}
              disabled={!trackingEditable}
            >
              <option value="none">{t("trackingNone")}</option>
              <option value="lot">{t("trackingLot")}</option>
              <option value="serial">{t("trackingSerial")}</option>
            </Select>
          </Field>

          <Field label={t("shelfLife")}>
            <Input
              name="shelf_life_days"
              type="number"
              min={1}
              inputMode="numeric"
              defaultValue={values.shelf_life_days}
            />
          </Field>
        </div>

        <div className="border-brand-border flex flex-col gap-4 border-t pt-4">
          <SectionLabel>{t("enrichmentSection")}</SectionLabel>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("supplierMoq")} hint={t("supplierMoqHint")}>
              <Input
                name="supplier_moq"
                type="number"
                min={0}
                step="any"
                inputMode="decimal"
                defaultValue={values.supplier_moq}
              />
            </Field>
          </div>
        </div>

        <div className="border-brand-border flex flex-col gap-3 border-t pt-4">
          <Checkbox
            name="requires_qc"
            defaultChecked={values.requires_qc}
            label={t("requiresQc")}
          />
          <Checkbox
            name="is_consignment_eligible"
            defaultChecked={values.is_consignment_eligible}
            label={t("consignmentEligible")}
          />
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
        <LinkButton href="/master/products">{tc("cancel")}</LinkButton>
      </div>
    </form>
  );
}
