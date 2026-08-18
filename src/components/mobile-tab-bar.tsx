"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { NavItem } from "./nav-links";
import { NAV_ICONS, IconMore } from "./nav-icons";

/**
 * Bottom tab bar, mobile only.
 *
 * The first attempt let the top bar scroll sideways, which at 390px left about
 * 110px for links and buried Receive behind a blind swipe. A bottom bar puts
 * the four most-used destinations in the thumb arc.
 *
 * Round two of field feedback said tapping "feels unreliable". The targets were
 * never the problem — they are 64px tall and roughly 78px wide, comfortably
 * past the 44px minimum, and the safe-area inset was already applied. The
 * problem was FEEDBACK (D-43): globals.css sets
 * `-webkit-tap-highlight-color: transparent` so a mis-tap cannot flash a label,
 * and nothing replaced it. A tap that registered showed absolutely nothing
 * until the next page rendered — which over warehouse Wi-Fi is long enough to
 * read as "it ignored me", and long enough to tap again.
 *
 * So every tab now has an instant pressed state and a navigation-pending state.
 */
export function MobileTabBar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // Ordered by what a handheld user actually does all day, not by the desktop
  // nav's order. Home drops out of the four visible tabs because the wordmark
  // already goes there and a dashboard is a desk screen.
  const PRIORITY = [
    "/receive",
    "/transfers",
    "/issues",
    "/stock",
    "/",
    "/qc",
    "/documents",
  ] as const;

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
                          ? "text-brand-brown active:bg-brand-cream flex items-center gap-3 rounded-md px-3 py-3 text-sm font-semibold"
                          : "text-brand-dark active:bg-brand-cream flex items-center gap-3 rounded-md px-3 py-3 text-sm"
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
                  // touch-manipulation removes the double-tap-to-zoom delay,
                  // which is another few hundred milliseconds of "nothing
                  // happened" on a tab bar.
                  className="block touch-manipulation"
                >
                  <TabInner active={active} label={item.label}>
                    {Icon && <Icon className="size-6" />}
                  </TabInner>
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
                    ? "text-brand-brown active:bg-brand-cream flex h-16 w-full touch-manipulation flex-col items-center justify-center gap-1 px-1"
                    : "text-brand-muted active:bg-brand-cream flex h-16 w-full touch-manipulation flex-col items-center justify-center gap-1 px-1"
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

/**
 * The tab's visible body, separated so it can call useLinkStatus — which only
 * reports the pending state of its enclosing Link.
 *
 * Two distinct signals: `active:` fires the instant a finger lands, and
 * `pending` covers the gap between that and the new page painting. Together
 * they mean a tap is never silent.
 */
function TabInner({
  active,
  label,
  children,
}: {
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  const { pending } = useLinkStatus();

  return (
    <span
      className={[
        "flex h-16 flex-col items-center justify-center gap-1 px-1 transition-colors",
        active || pending ? "text-brand-brown" : "text-brand-muted",
        pending ? "bg-brand-cream" : "active:bg-brand-cream",
      ].join(" ")}
    >
      {children}
      <span
        className={
          active || pending
            ? "max-w-full truncate text-[11px] font-semibold"
            : "max-w-full truncate text-[11px]"
        }
      >
        {label}
      </span>
    </span>
  );
}
