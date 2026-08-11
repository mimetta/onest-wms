"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signIn, type SignInState } from "./actions";

export function SignInForm({ next }: { next: string }) {
  const t = useTranslations("auth");
  const [state, formAction, pending] = useActionState<SignInState, FormData>(signIn, {});

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-brand-dark text-sm font-medium">
          {t("email")}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          autoFocus
          required
          className="border-brand-border text-brand-dark placeholder:text-brand-subtle h-9 rounded-md border bg-white px-3 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-brand-dark text-sm font-medium">
          {t("password")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="border-brand-border text-brand-dark placeholder:text-brand-subtle h-9 rounded-md border bg-white px-3 text-sm"
        />
      </div>

      {/* role="alert" so a screen reader announces the failure rather than
          leaving a keyboard-only user wondering why nothing happened. */}
      {state.error && (
        <p
          role="alert"
          className="border-brand-border bg-danger-bg text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {t(state.error)}
        </p>
      )}

      {/* Hover swaps green -> terracotta rather than dimming, per the palette. */}
      <button
        type="submit"
        disabled={pending}
        className="bg-brand-brown hover:bg-brand-accent h-9 rounded-md px-4 text-sm font-semibold text-white transition-colors disabled:opacity-60"
      >
        {pending ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
