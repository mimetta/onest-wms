import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { can, type SessionUser } from "@/lib/auth";
import { Wordmark } from "./wordmark";
import { LocaleSwitcher } from "./locale-switcher";
import { NavLinks, type NavItem } from "./nav-links";
import { MobileTabBar } from "./mobile-tab-bar";
import { SignOutButton } from "./sign-out-button";

/**
 * Nav is 56px tall per the palette doc, white with a single bottom border in
 * brand.border. brand.brown appears only as the active underline — never as the
 * bar's background.
 *
 * Links are filtered by permission, so a viewer never sees a Receive tab they
 * would be bounced out of. This is convenience, not security: the page itself
 * calls requirePerm(), and RLS applies regardless.
 */
export async function Nav({ user }: { user: SessionUser }) {
  const t = await getTranslations("nav");
  const tRoles = await getTranslations("roles");

  // Annotated before .filter() so the href literals are checked against the
  // typed route union rather than widening to string.
  const allItems: NavItem[] = [
    { href: "/", label: t("dashboard") },
    { href: "/stock", label: t("stock"), perm: "report.read" },
    { href: "/receive", label: t("receive"), perm: "goods_receipt.create" },
    { href: "/transfers", label: t("transfers"), perm: "transfer.create" },
    { href: "/issues", label: t("issues"), perm: "issue.create" },
    { href: "/requisitions", label: t("requisitions"), perm: "requisition.create" },
    { href: "/delivery-notes", label: t("deliveryNotes"), perm: "delivery_note.create" },
    { href: "/adjustments", label: t("adjustments"), perm: "adjustment.create" },
    { href: "/qc", label: t("qc"), perm: "lot.set_qc_status" },
    { href: "/documents", label: t("documents"), perm: "report.read" },
    { href: "/labels", label: t("labels"), perm: "label.print" },
    { href: "/master", label: t("master"), perm: "master_data.write" },
    { href: "/admin", label: t("admin"), perm: "user.manage" },
  ];

  const items = allItems.filter((item) => !item.perm || can(user, item.perm));

  return (
    <>
      <header className="border-brand-border sticky top-0 z-30 border-b bg-white">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-4 px-4">
          <Link href="/" className="shrink-0">
            <Wordmark compact />
          </Link>

          {/* Links live in the top bar on desktop and in the bottom tab bar on
              mobile, so this is hidden rather than squeezed. */}
          <div className="hidden min-w-0 flex-1 sm:flex">
            <NavLinks items={items} />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-brand-dark text-xs font-medium">{user.fullName}</div>
              <div className="text-brand-subtle text-[11px]">
                {tRoles(user.role)}
                {user.warehouseCode ? ` · ${user.warehouseCode}` : ""}
              </div>
            </div>
            <LocaleSwitcher />
            <SignOutButton label={t("signOut")} />
          </div>
        </div>
      </header>

      <MobileTabBar items={items} />
    </>
  );
}
