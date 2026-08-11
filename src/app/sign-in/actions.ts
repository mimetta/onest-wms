"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { setLocale } from "@/i18n/locale";

export type SignInState = { error?: string };

/**
 * Error keys, not sentences: the client looks them up in the message catalogue
 * so a Thai-speaking user gets a Thai error. Returning English text from the
 * server would be the easy way to end up with an untranslatable UI.
 */
export async function signIn(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "") || "/";

  if (!email || !password) return { error: "required" };

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return { error: "errorInvalid" };

  // Authenticating is not the same as being authorized to use this system. A
  // user with no profile row, or a deactivated one, is signed straight back out
  // rather than left holding a session that every page would then reject.
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("is_active, locale")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile) {
    await supabase.auth.signOut();
    return { error: "errorNoProfile" };
  }
  if (!profile.is_active) {
    await supabase.auth.signOut();
    return { error: "errorInactive" };
  }

  // Seed the device's language from the person's own preference.
  if (profile.locale === "th" || profile.locale === "en") {
    await setLocale(profile.locale);
  }

  revalidatePath("/", "layout");

  // `next` arrives from a query string, so it cannot be a statically known
  // route. Only same-origin absolute paths are accepted — an off-site value
  // would turn the sign-in page into an open redirect.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  redirect(safeNext as Parameters<typeof redirect>[0]);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/sign-in");
}
