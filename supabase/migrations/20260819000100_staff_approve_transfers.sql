-- =========================================================================
-- 0021 · Warehouse staff may approve transfers (D-56)
--
-- D-52 flagged this and left it for the owner: a putaway is a twenty-second
-- walk that D-44 reduced to a single post, yet it still waited on a second
-- person, because warehouse_staff did not hold transfer.approve.
--
-- Decided 19 Aug 2026: grant it.
--
-- One row, because permissions are data (D-20). No function changes, and no
-- screen changes either — the putaway screen already asks can(user,
-- 'transfer.approve') and offers "post now" or "submit for approval"
-- accordingly (D-52), so it starts doing the right thing the moment this
-- lands.
-- =========================================================================

insert into role_permissions (role, permission_key)
values ('warehouse_staff', 'transfer.approve')
on conflict do nothing;

-- What this does NOT change, deliberately:
--
--   issue.approve            still manager-only. An issue consumes stock and
--                            is charged to a department, so the two-person
--                            check stays (D-20).
--   adjustment.approve       still manager-only. A write-off is exactly where
--                            a single person should not be able to act alone,
--                            which is the whole point of D-39.
--   goods_receipt.approve    already held by staff (D-22), compensated by the
--                            dashboard's live activity feed.
--   delivery_note.approve    already held by staff, so a lorry is not held at
--                            the gate waiting for a manager.
--
-- A transfer differs from all the risky cases in one way that matters: it
-- moves stock between two bins the company owns. Nothing enters, leaves, is
-- consumed, or changes value. The ledger records both endpoints either way, so
-- a mistake is visible and correctable by another transfer — whereas an
-- unapproved write-off is only visible if somebody goes looking.
