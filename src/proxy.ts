import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 renamed `middleware` to `proxy`. Same mechanism, new name.
 *
 * Two jobs, and deliberately only two:
 *
 *   1. Refresh the Supabase auth token, because a Server Component cannot set
 *      cookies and this can.
 *   2. An OPTIMISTIC redirect for users with no session at all.
 *
 * It is NOT the authorization layer. Next's own documentation is explicit that
 * proxy should not be used for session management or authorization, and the
 * reason matters here: a redirect is a UX nicety, whereas the real protection
 * is RLS in Postgres plus the per-page session check in requireUser(). If this
 * file were deleted tomorrow, no data would be exposed — a signed-out user
 * would simply see an empty page instead of a tidy redirect.
 */

const PUBLIC_PATHS = ["/sign-in", "/auth"];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() rather than getSession(): it validates the token with the auth
  // server instead of trusting whatever the cookie claims.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    // Remember where they were headed, so signing in lands them there rather
    // than dumping them on the dashboard.
    if (path !== "/") url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (user && path === "/sign-in") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets. Note the negative
    // lookahead includes common image and font extensions so a handheld does
    // not pay for a token refresh on every icon request.
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)",
  ],
};
