-- =========================================================================
-- 0015 · Document workflow RPCs
--
-- Gap found while building the receiving screen (D-38).
--
-- PLAN.md §10 says status transitions go through RPCs rather than a direct
-- UPDATE, and the RLS policies were written to enforce exactly that: a document
-- row is updatable only while it is `draft`, and the WITH CHECK refuses any new
-- status beyond `submitted`. That is correct — but the RPCs themselves were
-- never created, so nothing could legally reach `approved`, and therefore
-- nothing could ever be posted.
--
-- These three functions complete the design. Like post_document(), they are
-- SECURITY DEFINER and check permissions themselves.
-- =========================================================================

/**
 * Shared guard: fetch and lock a document header, and confirm it exists.
 *
 * Table name is the enum label plus 's' — the same convention post_document()
 * relies on. %I quotes the identifier and the value can only be an enum label,
 * so this is not injectable.
 */
create or replace function document_current_status(
  p_doc_type document_type,
  p_doc_id   uuid
) returns document_status
  language plpgsql volatile security definer
  set search_path = ''
as $$
declare
  v_status public.document_status;
begin
  execute format('select status from public.%I where id = $1 for update',
                 p_doc_type::text || 's')
  into v_status
  using p_doc_id;

  if v_status is null then
    raise exception '% % not found', p_doc_type, p_doc_id using errcode = 'P0002';
  end if;

  return v_status;
end
$$;

-- -------------------------------------------------------------------------
-- submit
-- -------------------------------------------------------------------------

create or replace function submit_document(
  p_doc_type document_type,
  p_doc_id   uuid
) returns void
  language plpgsql volatile security definer
  set search_path = ''
as $$
declare
  v_status public.document_status;
  v_actor  uuid := (select auth.uid());
begin
  perform public.require_perm(p_doc_type::text || '.create');
  v_status := public.document_current_status(p_doc_type, p_doc_id);

  if v_status <> 'draft' then
    raise exception 'only a draft can be submitted (status is %)', v_status
      using errcode = '23514';
  end if;

  execute format(
    'update public.%I set status = ''submitted'', submitted_by = $1,
       submitted_at = now(), updated_at = now() where id = $2',
    p_doc_type::text || 's')
  using v_actor, p_doc_id;
end
$$;

-- -------------------------------------------------------------------------
-- approve
--
-- Accepts a `draft` as well as a `submitted` document, walking the draft
-- through `submitted` on the way. A goods receipt has no separate approver
-- (D-22), so the receiver submits and approves in one action — but the document
-- still passes through every state, and audit_log records each hop.
--
-- The permission check is what actually constrains this: a warehouse_staff user
-- can approve a goods receipt because they hold goods_receipt.approve, and
-- cannot approve an issue because they do not hold issue.approve.
-- -------------------------------------------------------------------------

create or replace function approve_document(
  p_doc_type document_type,
  p_doc_id   uuid
) returns void
  language plpgsql volatile security definer
  set search_path = ''
as $$
declare
  v_status public.document_status;
  v_actor  uuid := (select auth.uid());
begin
  perform public.require_perm(p_doc_type::text || '.approve');
  v_status := public.document_current_status(p_doc_type, p_doc_id);

  if v_status not in ('draft', 'submitted') then
    raise exception 'only a draft or submitted document can be approved (status is %)',
      v_status using errcode = '23514';
  end if;

  -- A draft is walked through `submitted` rather than jumping straight to
  -- `approved`. The workflow trigger in 0007 permits only
  -- draft -> submitted -> approved, and that strictness is worth keeping: it is
  -- what stops a bug elsewhere inventing a new path through the lifecycle.
  --
  -- Two updates also produce the honest audit trail. A goods receipt has no
  -- separate approver (D-22), but it was still submitted and then approved —
  -- by the same person, a moment apart — and audit_log records both.
  if v_status = 'draft' then
    execute format(
      'update public.%I set status = ''submitted'', submitted_by = $1,
         submitted_at = now(), updated_at = now() where id = $2',
      p_doc_type::text || 's')
    using v_actor, p_doc_id;
  end if;

  execute format(
    'update public.%I set status = ''approved'', approved_by = $1,
       approved_at = now(), updated_at = now() where id = $2',
    p_doc_type::text || 's')
  using v_actor, p_doc_id;
end
$$;

-- -------------------------------------------------------------------------
-- cancel
-- -------------------------------------------------------------------------

create or replace function cancel_document(
  p_doc_type document_type,
  p_doc_id   uuid,
  p_reason   text
) returns void
  language plpgsql volatile security definer
  set search_path = ''
as $$
declare
  v_status public.document_status;
  v_actor  uuid := (select auth.uid());
begin
  perform public.require_perm(p_doc_type::text || '.create');
  v_status := public.document_current_status(p_doc_type, p_doc_id);

  -- A posted document is corrected by a reversing document, never cancelled:
  -- the ledger it wrote cannot be unwritten (D-03). The status trigger enforces
  -- this too; the check here is so the caller gets a sentence rather than a
  -- constraint violation.
  if v_status = 'posted' then
    raise exception 'a posted document cannot be cancelled. Post a reversing document instead.'
      using errcode = '23514';
  end if;

  if v_status = 'cancelled' then
    return;  -- idempotent: cancelling twice is not an error
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'a reason is required to cancel a document' using errcode = '23514';
  end if;

  execute format(
    'update public.%I set status = ''cancelled'', cancelled_by = $1,
       cancelled_at = now(), cancel_reason = $2, updated_at = now()
     where id = $3',
    p_doc_type::text || 's')
  using v_actor, p_reason, p_doc_id;
end
$$;

-- -------------------------------------------------------------------------
-- Grants
-- -------------------------------------------------------------------------

revoke all on function document_current_status(document_type, uuid) from public;
revoke all on function submit_document(document_type, uuid) from public;
revoke all on function approve_document(document_type, uuid) from public;
revoke all on function cancel_document(document_type, uuid, text) from public;

grant execute on function submit_document(document_type, uuid) to authenticated;
grant execute on function approve_document(document_type, uuid) to authenticated;
grant execute on function cancel_document(document_type, uuid, text) to authenticated;

comment on function approve_document(document_type, uuid) is
  'Moves a document to approved. The only legal path there — RLS refuses a direct UPDATE (D-38).';
