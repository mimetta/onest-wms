"use client";

import { Button } from "@/components/ui";

/**
 * Print the current page.
 *
 * A client component purely because window.print() needs the browser. Kept
 * separate so the delivery-note page itself stays a server component and its
 * data never round-trips.
 */
export function PrintButton({ label }: { label: string }) {
  return <Button onClick={() => window.print()}>{label}</Button>;
}
