import { signOut } from "@/app/sign-in/actions";

export function SignOutButton({ label }: { label: string }) {
  return (
    <form action={signOut}>
      <button
        type="submit"
        className="border-brand-border text-brand-muted hover:bg-danger-bg hover:text-destructive rounded-md border px-2.5 py-1.5 text-xs transition-colors"
      >
        {label}
      </button>
    </form>
  );
}
