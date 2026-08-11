"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { Route } from "next";

/**
 * Search that lives in the URL, not in component state.
 *
 * That makes a filtered list shareable and survivable: a manager can send
 * "products matching SOLV" as a link, and a back button returns to the same
 * filter. Debounced so a 50-SKU list does not re-query on every keystroke.
 */
export function SearchBox({ placeholder }: { placeholder?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(params.get("q") ?? "");
  const t = useTranslations("common");

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (value) next.set("q", value);
      else next.delete("q");
      next.delete("page"); // a new search starts at page one
      const qs = next.toString();
      // Same-path replace with a new query string; not a statically known route.
      startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ""}` as Route));
    }, 250);
    return () => clearTimeout(timer);
    // `params` is intentionally omitted: including it would re-fire the effect
    // from the router.replace this effect just performed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, pathname, router]);

  return (
    <div className="flex items-center gap-2">
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder ?? t("search")}
        className="border-brand-border text-brand-dark placeholder:text-brand-subtle h-9 w-full rounded-md border bg-white px-3 text-sm sm:w-72"
      />
      {value && (
        <button
          type="button"
          onClick={() => setValue("")}
          className="text-brand-accent shrink-0 text-xs whitespace-nowrap"
        >
          {t("clearAll")}
        </button>
      )}
      <span
        aria-hidden
        className={
          pending
            ? "bg-brand-brown size-1.5 shrink-0 rounded-full opacity-100 transition-opacity"
            : "size-1.5 shrink-0 rounded-full opacity-0"
        }
      />
    </div>
  );
}
