# Onest WMS — Go-live checklist

> **Target go-live: 31 August 2026** (`settings.go_live_date`)
>
> Nothing here is optional. Each item exists because something specific goes wrong if it is
> skipped, and that consequence is stated so the item can be judged rather than obeyed.

---

## 1. Security — must be done before real data exists

| # | Item | Why | Status |
|---|---|---|---|
| S1 | **Rotate the Supabase database password** | It was pasted into a chat transcript in plain text on 2026-08-10 and lives wherever that conversation is stored. Not in git, not public — but anyone with the transcript has full database access. Project Settings → Database → Reset database password, then update `SUPABASE_DB_URL` and `SUPABASE_DB_PASSWORD` in `.env.local`. | ☐ |
| S2 | **Rotate the AccCloud API keys** | The original pair was exposed. Owner is regenerating them under setup → api-document → Generate Key. Note that a Reset Key invalidates the old pair immediately, so do this when nothing is mid-import. Update `ACCCLOUD_API_KEY` and `ACCCLOUD_SECRET_KEY`. | ☐ |
| S3 | **Replace every seeded user password** | `supabase/seed.sql` gives all eight demo accounts the password `onest1234`. That is fine for a demo database and a disaster on a production one. Real accounts get real passwords set by their owners; the demo accounts are deleted, not repurposed. | ☐ |
| S4 | **Preview deployments must stop pointing at the production database** | *P1-E condition, agreed 2026-08-11.* Until this is done, any Vercel preview build — including one from an unreviewed branch — reads and writes live stock. Either create a separate staging Supabase project and point preview environment variables at it, or disable preview deployments entirely. | ☐ |
| S5 | **Confirm no service-role key is reachable from the browser** | `SUPABASE_SERVICE_ROLE_KEY` must never carry a `NEXT_PUBLIC_` prefix and must never be imported into a client component. Verify with a production build: search the client bundle for the key's first characters and expect no match. | ☐ |
| S6b | **Redeploy after rotating any `NEXT_PUBLIC_*` value** | `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are inlined into the client bundle **at build time**, not read at runtime. Editing them in the Vercel dashboard changes nothing until a new deployment is built — the old value stays baked into the shipped JavaScript. So any Supabase key rotation is a two-step job: update the variable, then redeploy. Skipping the second step leaves a live site authenticating with a revoked key. | ☐ |
| S7 | **Restrict who can reach the deployment, or accept that anyone with the URL can try to sign in** | `https://onest-wms.vercel.app` is publicly reachable. The demo accounts on it use a generated password rather than the `onest1234` documented in `seed.sql`, so the repo does not hand out a working login — but the URL is guessable. Turn on Vercel Deployment Protection (Settings → Deployment Protection → Vercel Authentication) while the system is pre-go-live and holds demo data only. | ☐ |
| S8 | **Retire the demo database entirely before real data lands** | The hosted project was seeded on 2026-08-11 and then had real documents posted through it during the 19 Aug walkthrough. It holds demo master data, demo users, and an append-only ledger that cannot be pruned — see D1. It is retired, not cleaned. Confirm the production deployment points at the *new* project's URL and keys before any real stock is entered, because the two are indistinguishable from the app's point of view. | ☐ |
| S6 | **Review `role_permissions` against the real approval chain** | The seeded grants are a documented baseline, not a decision. Confirm with the warehouse manager that the people who should approve an ใบเบิก can, and that nobody else can. | ☐ |

---

## 2. Data

| # | Item | Why | Status |
|---|---|---|---|
| D1 | **Start a fresh Supabase project — selective deletion is not an option** | Two reasons, and the second is decisive. (a) Demo data is no longer only *seeded* rows: the 19 Aug walkthrough posted four real documents through the real RPCs — `GR-2026-00002`, `RQ-2026-00001`, `TR-2026-00001`, `IS-2026-00001` — plus the lot `L2608-201`, QC decisions on `L2608-007`, and two orphan draft requisitions. A cleanup script written against `seed.sql` would miss every one of them. (b) **The ledger cannot be deleted from.** `stock_movements` refuses UPDATE, DELETE and TRUNCATE by trigger, and `authenticated` holds no such grants at all (D-01, D-03). So the demo's movements are permanent in that database *by design*. A fresh project with migrations applied and no seed is therefore the only correct route, not merely the simpler one. | ☐ |
| D1b | **Confirm the migration-supplied master data** | A fresh project arrives with departments, UOMs, adjustment reason codes, document prefixes, permissions, role assignments, settings defaults and alert rules — all from migrations, because production would be broken without them (D-63, D-64). Two need an eye before real data: the **UOM list** (eight codes carried over from the demo; the AccCloud export may need more, and `decimal_places` is a real accounting decision) and the **department list**. Everything else is structural. | ☐ |
| D2 | **Import the real item master** | Via the Phase 4 CSV importer, from the AccCloud export. Check the diff preview before committing — particularly the computed UOM conversions, since `prodConvFactor`'s direction is still unconfirmed (D-24). | ☐ |
| D3a | **Provision the system locations** | `select * from provision_system_locations('<warehouse-id>');` — creates receiving, qc_hold, staging, shipping, quarantine, scrap, in_transit and opening for that warehouse. Idempotent, so it is safe to re-run. Skip this and the failures are deferred and confusing: receiving a QC-required product fails with "no QC bin", a cross-site transfer raises "no in_transit location", and opening balances have nowhere to come from (D-64). | ☐ |
| D3b | **Create the real location structure** | Zones and the physical storage and picking bins matching the building, each with a printed barcode label. Deliberately NOT covered by D3a: inventing a storage bin creates somewhere for stock to hide. A bin that exists in the building but not in the system is where stock goes missing. | ☐ |
| D4 | **Print and apply internal barcode labels** | AccCloud supplies no barcodes (D-24), so nothing can be scanned until this is done. This is the longest-lead physical task in go-live — start it early. | ☐ |
| D5 | **Post opening balances** | As a goods receipt from `OPENING-WH01`, dated the go-live date (D-21). Afterwards, confirm the OPENING bin holds exactly the negative of total real stock — the dashboard shows this check. | ☐ |
| D6 | **Reconcile against AccCloud** | Run the reconciliation report and resolve every variance *before* the first real transaction, not after. A variance found on day one is a data problem; the same variance found in week three is an investigation. | ☐ |

---

## 3. Access

| # | Item | Why | Status |
|---|---|---|---|
| A1 | **Create real user accounts** | Real names, emails and roles. Every account maps to a person — no shared "warehouse" login, because the ledger records who did what and a shared account makes that record worthless. | ☐ |
| A2 | **Deactivate rather than delete departing staff** | Set `is_active = false`. Deleting a user would orphan their movement history, and the ledger is append-only by design. | ☐ |
| A3 | **Confirm each role sees only its own screens** | Sign in as one user per role and check the nav. A `viewer` should not see Receive, QC, Master data or Admin. | ☐ |

---

## 4. Infrastructure

| # | Item | Why | Status |
|---|---|---|---|
| I1 | **Vercel environment variables limited to what the code reads** | As of 2026-08-11 that is exactly two: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. `SUPABASE_SERVICE_ROLE_KEY` was deliberately removed until code needs it (Phase 3 alerts Edge Function), and the `ACCCLOUD_*` pair until Phase 4 — an unused secret is exposure without benefit. Re-add each one in the same change as the code that reads it. | ☐ |
| I2 | **Custom domain and HTTPS** | Warehouse handhelds need a stable URL to bookmark and install as a PWA. | ☐ |
| I3 | **Database backups confirmed** | Check the retention period on the Supabase plan in use and confirm a restore has actually been tested. An untested backup is a hope, not a backup. | ☐ |
| I4 | **Wi-Fi coverage checked at every scanning point** | Phase 1 ships graceful reconnect, not offline posting (P1-B). A bin in a dead spot means a receipt that cannot be posted where it is scanned. Walk the floor with a handheld before go-live, not after. | ☐ |
| I5 | **PWA installed on the real devices** | Install on each handheld, confirm the icon, the standalone display and the camera permission for scanning. | ☐ |

---

## 5. People

| # | Item | Why | Status |
|---|---|---|---|
| P1 | **Train receiving staff on the scan flow** | The system is designed to be usable with a scanner and number keys only. Confirm that is true for the actual people, on the actual hardware, in Thai. | ☐ |
| P2 | **Train QC on pass / fail / quarantine and scrap** | Especially that failing a lot makes it unissuable everywhere at once, and that scrapping a failed lot is done from the same screen. | ☐ |
| P3 | **Agree who watches the dashboard each morning** | Goods receipts post with no approver (D-22), so the "receipts posted today" panel and the activity feed *are* the review. They only work if somebody actually looks. | ☐ |
| P4 | **Write down what to do when a scan fails** | An unknown barcode is normal on day one and becomes the supplier-barcode capture flow. Staff need to know that linking it is expected behaviour, not an error to report. | ☐ |

---

## 6. Known constraints to brief the team on

These are working as designed. They are listed so nobody discovers them mid-shift and files
a bug.

| Constraint | Detail |
|---|---|
| **A failed lot cannot be issued or delivered** | By anyone, including admin, with no override. Disposal is the only way it leaves — and that needs `lot.dispose_unpassed`, held by `qc` and `admin` (D-14). |
| **Cycle-count variance on unpassed stock needs QC** | A count variance that decreases a `pending_qc` lot classifies as disposal, so a warehouse manager cannot post it alone (D-20). Becomes relevant in Phase 3. |
| **Posted documents cannot be cancelled or edited** | A correction is a new reversing document. This is the ledger guarantee that makes the audit trail trustworthy (D-03). |
| **Negative stock requires a reason and a permission** | And it is recorded in `audit_log` as an override, not as an ordinary post. |
| **No offline posting** | Scans queue and flush on reconnect; posting requires a connection (P1-B). |
