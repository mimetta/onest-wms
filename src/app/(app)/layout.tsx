import { requireUser } from "@/lib/auth";
import { Nav } from "@/components/nav";

/**
 * Every route inside this group is signed-in-only. requireUser() runs here on
 * the server for each request — this is the authorization check, not the
 * redirect in proxy.ts.
 */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();

  return (
    <>
      <Nav user={user} />
      {/* pb-24 on mobile clears the fixed bottom tab bar; sm:pb-6 drops it. */}
      {/* Tighter gutters and rhythm on a handheld (D-43); pb-24 clears the
          fixed bottom tab bar. */}
      <main className="mx-auto max-w-[1280px] px-3 pt-4 pb-24 sm:px-4 sm:pt-6 sm:pb-6">
        {children}
      </main>
    </>
  );
}
