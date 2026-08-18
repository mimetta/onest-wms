import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";

/**
 * The small set of primitives the master-data screens share.
 *
 * Deliberately plain functions rather than a component library: every rule here
 * comes from docs/brand/mimetta-color-palette.md, and having them in one file
 * makes a palette change one edit rather than a search-and-replace. White is
 * the only surface background, brand.border is the only border colour, and
 * hovers swap green -> terracotta rather than dimming.
 *
 * DENSITY (D-43). The palette specifies px-6 py-5 cards, which is right at a
 * desk and too airy at 390px — field feedback was that a phone screen holds
 * almost nothing. Cards are therefore px-4 py-3 on mobile and px-6 py-5 from
 * `sm` up. This is the legibility clause of D-25 applied to spacing rather than
 * colour: the brand's proportions are kept where there is room for them, and
 * traded for content where there is not.
 */

export function Card({
  children,
  className = "",
  padded = false,
}: {
  children: ReactNode;
  className?: string;
  /** Apply the standard responsive padding. Omit when the caller sets its own. */
  padded?: boolean;
}) {
  return (
    <div
      className={`border-brand-border rounded-[10px] border bg-white ${
        padded ? "px-4 py-3 sm:px-6 sm:py-5" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-2 sm:gap-3">
      <div className="flex flex-col gap-0.5 sm:gap-1">
        <h1 className="text-brand-dark text-lg font-semibold sm:text-xl">{title}</h1>
        {subtitle && <p className="text-brand-muted text-xs sm:text-sm">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-brand-subtle text-xs font-semibold tracking-wider uppercase">
      {children}
    </span>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger";

const buttonClass: Record<ButtonVariant, string> = {
  // Hover swaps colour, per the palette — not an opacity change.
  primary:
    "bg-brand-brown hover:bg-brand-accent text-white border-transparent font-semibold",
  secondary: "bg-white border-brand-border text-brand-dark hover:bg-brand-cream",
  danger: "bg-white border-brand-border text-destructive hover:bg-danger-bg font-medium",
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm transition-colors disabled:opacity-60 ${buttonClass[variant]} ${className}`}
    />
  );
}

export function LinkButton({
  variant = "secondary",
  className = "",
  ...props
}: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return (
    <Link
      {...props}
      className={`inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm transition-colors ${buttonClass[variant]} ${className}`}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-brand-dark text-sm font-medium">{label}</label>
      {children}
      {hint && !error && <p className="text-brand-subtle text-xs">{hint}</p>}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

const controlClass =
  "border-brand-border text-brand-dark placeholder:text-brand-subtle h-9 w-full rounded-md border bg-white px-3 text-sm disabled:bg-brand-cream disabled:text-brand-muted";

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return <input {...props} className={`${controlClass} ${className}`} />;
}

export function Select({ className = "", ...props }: ComponentProps<"select">) {
  return <select {...props} className={`${controlClass} ${className}`} />;
}

export function Checkbox({
  label,
  ...props
}: ComponentProps<"input"> & { label: string }) {
  return (
    <label className="flex items-center gap-2">
      <input
        {...props}
        type="checkbox"
        className="border-brand-border accent-brand-brown size-4 rounded border"
      />
      <span className="text-brand-dark text-sm">{label}</span>
    </label>
  );
}

/**
 * Tables scroll inside their own container. The page body must never scroll
 * sideways — on a handheld that makes the whole layout feel broken.
 */
export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">{children}</div>
    </Card>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return <table className="w-full min-w-[40rem] text-sm">{children}</table>;
}

export function Th({
  children,
  className = "",
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`bg-table-header border-brand-border text-brand-subtle border-b px-4 py-2.5 text-left text-xs font-semibold tracking-wider whitespace-nowrap uppercase ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className = "",
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <td className={`border-brand-border/60 border-b px-4 py-2.5 ${className}`}>
      {children}
    </td>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info";

const toneClass: Record<Tone, string> = {
  neutral: "bg-brand-cream text-brand-muted",
  good: "bg-success-bg text-success-fg",
  warn: "bg-warning-bg text-warning-text",
  bad: "bg-danger-bg text-destructive",
  info: "bg-info-bg text-info-fg",
};

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-8 text-center sm:px-6 sm:py-12">
      <p className="text-brand-dark text-sm font-medium">{title}</p>
      {hint && <p className="text-brand-muted text-sm">{hint}</p>}
    </div>
  );
}

export function Banner({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "bad" | "good";
  children: ReactNode;
}) {
  const cls = {
    info: "bg-info-bg text-brand-dark",
    warn: "bg-warning-bg text-warning-text",
    bad: "bg-danger-bg text-destructive",
    good: "bg-success-bg text-success-fg",
  }[tone];
  return (
    <div
      className={`border-brand-border rounded-[10px] border px-3 py-2 text-sm sm:px-4 sm:py-3 ${cls}`}
    >
      {children}
    </div>
  );
}
