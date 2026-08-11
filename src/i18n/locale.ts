// Deliberately not "use server": that directive would turn every export into a
// server action, which requires them all to be async — and this module exports
// constants and a type guard too. It is imported only by server code, and the
// one mutation (setLocale) is called from inside a server action.
import { cookies } from "next/headers";

export const LOCALES = ["th", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** Thai is the default: most warehouse staff read Thai first. */
export const DEFAULT_LOCALE: Locale = "th";

const COOKIE = "onest-locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * No locale in the URL. This is an internal tool where a user's language is a
 * property of the person, not of the page — so /stock is /stock for everyone
 * and there are no duplicate routes to keep in step. The cookie is seeded from
 * user_profiles.locale at sign-in and can be overridden per device, which
 * matters when a shared handheld is used by staff who read different languages.
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const value = store.get(COOKIE)?.value;
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export async function setLocale(locale: Locale): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
