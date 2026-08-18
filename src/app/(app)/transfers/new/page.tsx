import { getTranslations } from "next-intl/server";
import { can, requirePerm } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { PutawayClient } from "./putaway-client";

/**
 * Putaway and internal moves.
 *
 * `canApprove` is decided here on the server and passed down, so the screen
 * adapts to the role without shipping the permission set to the browser.
 */
export default async function Page() {
  const user = await requirePerm("transfer.create");
  const t = await getTranslations("transfers");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("newTitle")} subtitle={t("newSubtitle")} />
      <PutawayClient canApprove={can(user, "transfer.approve")} />
    </div>
  );
}
