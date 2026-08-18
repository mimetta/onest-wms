import { Client } from "pg";

/**
 * Every test runs inside a transaction that is rolled back at the end. That
 * gives each one a pristine database without paying for a full `db reset`
 * between tests, and it means a test that leaves stock behind cannot change
 * another test's expected balances.
 */
export async function withRollback<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    return await fn(new Db(client));
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

export class Db {
  constructor(private readonly client: Client) {}

  async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const res = await this.client.query(sql, params);
    return res.rows as R[];
  }

  async one<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const rows = await this.query<R>(sql, params);
    if (rows.length !== 1) {
      throw new Error(`expected exactly 1 row, got ${rows.length}`);
    }
    return rows[0];
  }

  async value<T = string>(sql: string, params: unknown[] = []): Promise<T> {
    const row = await this.one<Record<string, T>>(sql, params);
    return Object.values(row)[0];
  }

  /**
   * Impersonate a user for the rest of the transaction.
   *
   * Two things happen, and the second one matters more than it looks:
   *
   * 1. `request.jwt.claims` is set, which is how Supabase passes identity into
   *    SQL — so auth.uid() and has_perm() behave exactly as in production.
   * 2. The session ROLE is switched to `authenticated`.
   *
   * Without (2) the connection stays `postgres`, which OWNS these tables — and
   * RLS is ENABLE, not FORCE (D-19), so the owner bypasses every policy. Tests
   * would then check the SECURITY DEFINER functions' own permission logic and
   * silently skip RLS entirely. That is the same blindness as D-38, one layer
   * down: proving the operation while never touching the guard.
   */
  async actAs(userId: string) {
    await this.client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
    await this.client.query("set local role authenticated");
  }

  /**
   * Drop back to the owning role for fixture setup.
   *
   * Building a test world is not a thing any real user does, so it does not
   * have to pass RLS — but everything a test then ASSERTS about should.
   */
  async asOwner() {
    await this.client.query("reset role");
  }

  /**
   * Set identity WITHOUT enforcing RLS — claims only, still the owning role.
   *
   * This is a deliberate opt-out, used by the ledger and posting tests. Those
   * ask "does posting enforce the invariants?" and reach that question fastest
   * by arranging a document directly. `has_perm()` and `auth.uid()` still work,
   * so permission assertions inside the RPCs remain honest.
   *
   * Tests about AUTHORITY — who may raise, approve or post what — must use
   * actAs() instead, or they prove nothing about the policies.
   */
  async setupAs(userId: string) {
    await this.client.query("reset role");
    await this.client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
  }

  /** Run `fn` and return the error message it raised, or throw if it succeeded. */
  async expectError(fn: () => Promise<unknown>): Promise<string> {
    // A failed statement poisons the surrounding transaction, so each attempt
    // gets its own savepoint to roll back to.
    await this.client.query("savepoint attempt");
    try {
      await fn();
    } catch (err) {
      await this.client.query("rollback to savepoint attempt");
      return (err as Error).message;
    }
    throw new Error("expected the statement to fail, but it succeeded");
  }

  async onHand(productId: string, locationId: string, lotId: string | null = null) {
    return Number(
      await this.value<string>("select on_hand_at($1, $2, null, $3)::text", [
        productId,
        lotId,
        locationId,
      ]),
    );
  }

  async post(
    docType: string,
    docId: string,
    opts: { overrideNegative?: boolean; reason?: string } = {},
  ) {
    return this.value<string>("select post_document($1, $2, $3, $4)", [
      docType,
      docId,
      opts.overrideNegative ?? false,
      opts.reason ?? null,
    ]);
  }
}
