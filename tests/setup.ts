import "dotenv/config";

// Tests run against the local Supabase stack (`npm run db:start`). They never
// touch a hosted project: several of them deliberately provoke constraint
// violations and negative-stock overrides.
process.env.DATABASE_URL =
  process.env.LOCAL_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
