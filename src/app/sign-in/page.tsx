import { getTranslations } from "next-intl/server";
import { Wordmark } from "@/components/wordmark";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SignInForm } from "./sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const t = await getTranslations("auth");
  const { next } = await searchParams;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Card is white on a cream page — never cream on cream. */}
        <div className="border-brand-border rounded-[10px] border bg-white px-6 py-5">
          <div className="mb-6 flex flex-col gap-1">
            <Wordmark />
            <h1 className="text-brand-dark mt-3 text-lg font-semibold">
              {t("signInTitle")}
            </h1>
            <p className="text-brand-muted text-sm">{t("signInSubtitle")}</p>
          </div>

          <SignInForm next={next ?? "/"} />
        </div>

        <div className="mt-4 flex justify-center">
          <LocaleSwitcher />
        </div>
      </div>
    </main>
  );
}
