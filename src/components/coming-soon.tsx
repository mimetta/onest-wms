import { getTranslations } from "next-intl/server";

/**
 * An honest placeholder for a Phase 1 screen that is not built yet.
 *
 * These exist so the shell is navigable and testable on a real phone now: with
 * typedRoutes enabled, a nav link to a route that does not exist is a build
 * error, and a nav full of 404s is worse than a nav that says what is coming.
 * Each one names its step in PHASE1.md so nobody mistakes a stub for a feature.
 */
export async function ComingSoon({ step, titleKey }: { step: string; titleKey: string }) {
  const tNav = await getTranslations("nav");
  const label = tNav(titleKey);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-brand-dark text-xl font-semibold">{label}</h1>
      <div className="border-brand-border rounded-[10px] border bg-white px-6 py-5">
        <p className="text-brand-subtle text-xs font-semibold tracking-wider uppercase">
          Phase 1 · {step}
        </p>
        <p className="text-brand-muted mt-2 text-sm">
          Not built yet. See <span className="font-mono">PHASE1.md</span> §{step} for what
          this screen will do.
        </p>
      </div>
    </div>
  );
}
