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
} from "@/components/ui";
import { saveZone, type LocationFormState } from "../locations/actions";

export function ZoneForm({
  values,
}: {
  values: {
    id?: string;
    code: string;
    name_th: string;
    name_en: string;
    is_active: boolean;
  };
}) {
  const t = useTranslations("master");
  const tc = useTranslations("common");
  const [state, formAction, pending] = useActionState<LocationFormState, FormData>(
    saveZone,
    {},
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {values.id && <input type="hidden" name="id" value={values.id} />}
      {state.error && <Banner tone="bad">{t(state.error)}</Banner>}

      <Card className="flex flex-col gap-4 px-6 py-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("zoneCode")}>
            <Input
              name="code"
              defaultValue={values.code}
              required
              autoFocus
              placeholder="RM"
              className="font-mono uppercase"
            />
          </Field>
          <Field label={t("nameTh")}>
            <Input name="name_th" defaultValue={values.name_th} required />
          </Field>
          <Field label={t("nameEn")}>
            <Input name="name_en" defaultValue={values.name_en} />
          </Field>
        </div>
        <Checkbox
          name="is_active"
          defaultChecked={values.is_active}
          label={t("isActive")}
        />
      </Card>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? tc("loading") : tc("save")}
        </Button>
        <LinkButton href="/master/zones">{tc("cancel")}</LinkButton>
      </div>
    </form>
  );
}
