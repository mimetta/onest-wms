import { redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "./supabase/server";

export type UserRole =
  "admin" | "warehouse_manager" | "warehouse_staff" | "qc" | "viewer";

export type SessionUser = {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  warehouseId: string | null;
  warehouseCode: string | null;
  locale: "th" | "en";
  permissions: Set<string>;
};

/**
 * The real authorization check, run per request in the page or layout that
 * needs it — not in proxy.ts (see the note there).
 *
 * Wrapped in React's cache() so a layout and its pages calling this in the same
 * render share one round trip rather than each hitting the database.
 */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // One query for the profile, its warehouse, and the permission list. The
  // permissions come from role_permissions rather than being inferred from the
  // role name, so the UI hides exactly what the database would refuse (D-09).
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("full_name, role, warehouse_id, locale, is_active, warehouses(code)")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || !profile.is_active) return null;

  const { data: perms } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .eq("role", profile.role);

  // Supabase types an embedded relation as an array even when the foreign key
  // guarantees at most one row, so normalise rather than cast.
  const warehouseRel = profile.warehouses as unknown;
  const warehouse = Array.isArray(warehouseRel)
    ? ((warehouseRel[0] as { code: string } | undefined) ?? null)
    : (warehouseRel as { code: string } | null);

  return {
    id: user.id,
    email: user.email ?? "",
    fullName: profile.full_name,
    role: profile.role as UserRole,
    warehouseId: profile.warehouse_id,
    warehouseCode: warehouse?.code ?? null,
    locale: profile.locale === "en" ? "en" : "th",
    permissions: new Set((perms ?? []).map((p) => p.permission_key)),
  };
});

/** Use in any page that requires a signed-in user. Redirects if there is none. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/sign-in");
  return user;
}

/**
 * Use to gate a page on a specific permission.
 *
 * This hides a screen; it does not secure the data. The data is secured by RLS
 * and by post_document()'s own require_perm() check, both of which apply even if
 * this function is forgotten.
 */
export async function requirePerm(permission: string): Promise<SessionUser> {
  const user = await requireUser();
  if (!user.permissions.has(permission)) redirect("/");
  return user;
}

export function can(user: SessionUser | null, permission: string): boolean {
  return user?.permissions.has(permission) ?? false;
}
