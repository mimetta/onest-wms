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
      <main className="mx-auto max-w-[1280px] px-4 py-6">{children}</main>
    </>
  );
}
