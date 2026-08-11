"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client. Anon key only — RLS is what protects the data behind it.
 *
 * This client can read (subject to policy) and can write document drafts. It
 * can NEVER write to stock_movements: that table has no INSERT policy and the
 * privilege is revoked from `authenticated`, so the only path to the ledger is
 * the post_document() RPC called from a Server Action (D-06).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
