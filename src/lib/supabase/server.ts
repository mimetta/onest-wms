import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 *
 * Uses the ANON key, never the service-role key. Every query this client makes
 * is subject to RLS, which is the point: the policies written in migration 0011
 * are the authorization model, and bypassing them here would quietly move
 * authorization into application code where it is easy to forget.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Components cannot set cookies. Token refresh happens in
            // proxy.ts instead, which can. Swallowing this is the documented
            // pattern, not an oversight.
          }
        },
      },
    },
  );
}
