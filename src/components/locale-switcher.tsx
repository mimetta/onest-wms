import { getLocale, setLocale, type Locale } from "@/i18n/locale";
import { revalidatePath } from "next/cache";

/**
 * Two buttons, not a dropdown. Switching language is a two-option choice used
 * from a handheld, and a native select on Android opens a modal wheel for what
 * should be one tap.
 */
export async function LocaleSwitcher() {
  const current = await getLocale();

  async function change(formData: FormData) {
    "use server";
    const next = String(formData.get("locale")) as Locale;
    if (next === "th" || next === "en") {
      await setLocale(next);
      revalidatePath("/", "layout");
    }
  }

  return (
    <form action={change} className="flex items-center gap-0.5">
      {(["th", "en"] as const).map((loc) => {
        const active = loc === current;
        return (
          <button
            key={loc}
            type="submit"
            name="locale"
            value={loc}
            aria-current={active ? "true" : undefined}
            className={
              active
                ? "text-brand-brown rounded px-2 py-1 text-xs font-semibold"
                : "text-brand-muted hover:text-brand-dark rounded px-2 py-1 text-xs"
            }
          >
            {loc === "th" ? "ไทย" : "EN"}
          </button>
        );
      })}
    </form>
  );
}
