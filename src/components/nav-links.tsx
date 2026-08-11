"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { ComponentProps } from "react";

/**
 * href is a typed route, not a string: with `typedRoutes` enabled a link to a
 * route that does not exist is a compile error rather than a 404 discovered by
 * a warehouse worker. Derived from Link rather than imported from the generated
 * file, so it keeps working if Next changes where those types live.
 */
export type NavItem = {
  // Extract<..., string> drops the UrlObject variant, leaving the union of
  // route strings — which is what we need to compare against a pathname and to
  // use as a React key.
  href: Extract<ComponentProps<typeof Link>["href"], string>;
  label: string;
  perm?: string;
};

/**
 * Client component only because the active link depends on the current path.
 * The item list itself is decided on the server, so a user's permissions are
 * never shipped to the browser to be filtered there.
 *
 * Horizontally scrollable on narrow screens rather than collapsing into a
 * hamburger: a warehouse user reaches for Receive constantly, and burying it
 * behind a menu tap costs more than a little sideways scroll.
 */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      {items.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              // Active state is a brown underline, per the palette — not a
              // filled background.
              active
                ? "border-brand-brown text-brand-dark shrink-0 border-b-2 px-2.5 py-3.5 text-sm font-semibold whitespace-nowrap"
                : "text-brand-muted hover:text-brand-dark shrink-0 border-b-2 border-transparent px-2.5 py-3.5 text-sm whitespace-nowrap"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
