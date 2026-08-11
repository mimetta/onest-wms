"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { NavItem } from "./nav-links";
import { NAV_ICONS, IconMore } from "./nav-icons";

/**
 * Bottom tab bar, mobile only.
 *
 * The first attempt put every destination in the top bar and let it scroll
 * sideways. On a 390px handheld that left roughly 110px for links, so Receive —
 * the screen a receiver opens dozens of times a shift — was reachable only by a
 * blind horizontal swipe inside a 40px strip. The reasoning behind that design
 * (don't bury frequently-used destinations) was right; the execution failed it.
 *
 * A bottom bar fixes both halves: the four most-used destinations sit in the
 * thumb arc of a hand holding the device, and the rest live behind an explicit
 * "More" sheet rather than an invisible scroll.
 *
 * Four visible tabs, not five: warehouse staff often work in gloves, and a
 * 390px screen split five ways gives ~78px targets. Four gives ~97px.
 */
export function MobileTabBar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // Priority order for the small screen. Whatever the user has permission for,
  // in this order, fills the four slots; everything else goes to More.
  const PRIORITY = ["/", "/receive", "/stock", "/qc", "/documents"] as const;

  const ranked = [...items].sort((a, b) => {
    const ai = PRIORITY.indexOf(a.href as (typeof PRIORITY)[number]);
    const bi = PRIORITY.indexOf(b.href as (typeof PRIORITY)[number]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const primary = ranked.slice(0, 4);
  const overflow = ranked.slice(4);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* Sheet for everything that did not fit. */}
      {moreOpen && overflow.length > 0 && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
            className="fixed inset-0 z-40 bg-black/20 sm:hidden"
          />
          <div className="border-brand-border fixed right-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] left-0 z-50 border-t bg-white p-2 sm:hidden">
            <ul className="flex flex-col">
              {overflow.map((item) => {
                const Icon = NAV_ICONS[item.href as keyof typeof NAV_ICONS];
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setMoreOpen(false)}
                      className={
                        isActive(item.href)
                          ? "text-brand-brown flex items-center gap-3 rounded-md px-3 py-3 text-sm font-semibold"
                          : "text-brand-dark flex items-center gap-3 rounded-md px-3 py-3 text-sm"
                      }
                    >
                      {Icon && <Icon className="size-5" />}
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      {/* pb from safe-area so the bar clears the iOS home indicator. */}
      <nav className="border-brand-border fixed right-0 bottom-0 left-0 z-40 border-t bg-white pb-[env(safe-area-inset-bottom)] sm:hidden">
        <ul className="flex">
          {primary.map((item) => {
            const Icon = NAV_ICONS[item.href as keyof typeof NAV_ICONS];
            const active = isActive(item.href);
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "text-brand-brown flex h-16 flex-col items-center justify-center gap-1 px-1"
                      : "text-brand-muted flex h-16 flex-col items-center justify-center gap-1 px-1"
                  }
                >
                  {Icon && <Icon className="size-6" />}
                  {/* Label as well as icon: an icon alone is a guess, and these
                      are Thai words a pictogram cannot carry. */}
                  <span
                    className={
                      active
                        ? "max-w-full truncate text-[11px] font-semibold"
                        : "max-w-full truncate text-[11px]"
                    }
                  >
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}

          {overflow.length > 0 && (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                className={
                  overflow.some((i) => isActive(i.href))
                    ? "text-brand-brown flex h-16 w-full flex-col items-center justify-center gap-1 px-1"
                    : "text-brand-muted flex h-16 w-full flex-col items-center justify-center gap-1 px-1"
                }
              >
                <IconMore className="size-6" />
                <span className="text-[11px]">···</span>
              </button>
            </li>
          )}
        </ul>
      </nav>
    </>
  );
}
