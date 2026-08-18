"use server";

import { revalidatePath } from "next/cache";
import { requirePerm } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { DOC_CONFIG, perm, type DocType } from "@/lib/documents/config";

export type ActionResult<T = undefined> =
  { ok: true; data?: T } | { ok: false; error: string; detail?: string };

/**
 * The workflow verbs, once, for every document type.
 *
 * Phase 1 wrote these inline in the receiving and QC screens, which was fine
 * for two callers and would not be for seven. More importantly, the *order* of
 * operations here is load-bearing and easy to get subtly wrong per screen:
 * approve then post, both through RPCs, never a direct status UPDATE, because
 * RLS only permits editing a document while it is `draft` (D-38).
 *
 * Each function takes the document type, so a new type gets these four verbs
 * for free and cannot accidentally acquire a different lifecycle.
 */

async function revalidateFor(type: DocType) {
  const route = DOC_CONFIG[type].route;
  if (route) revalidatePath(route);
  revalidatePath("/documents");
  // The dashboard carries the pending-approval panels (D-22).
  revalidatePath("/");
}

export async function submitDocument(type: DocType, id: string): Promise<ActionResult> {
  await requirePerm(perm(type, "create"));
  const supabase = await createClient();

  const { error } = await supabase.rpc("submit_document", {
    p_doc_type: type,
    p_doc_id: id,
  });

  if (error) return { ok: false, error: "submitFailed", detail: error.message };
  await revalidateFor(type);
  return { ok: true };
}

export async function approveDocument(type: DocType, id: string): Promise<ActionResult> {
  await requirePerm(perm(type, "approve"));
  const supabase = await createClient();

  const { error } = await supabase.rpc("approve_document", {
    p_doc_type: type,
    p_doc_id: id,
  });

  if (error) return { ok: false, error: "approveFailed", detail: error.message };
  await revalidateFor(type);
  return { ok: true };
}

export async function cancelDocument(
  type: DocType,
  id: string,
  reason: string,
): Promise<ActionResult> {
  // Cancelling is the author's or an approver's act, so it is gated on approve
  // where the user has it and create otherwise — cancel_document() itself makes
  // the real decision, and this is only about failing early with a clear
  // message rather than a policy error.
  await requirePerm(perm(type, "create"));
  const supabase = await createClient();

  if (!reason.trim()) return { ok: false, error: "reasonRequired" };

  const { error } = await supabase.rpc("cancel_document", {
    p_doc_type: type,
    p_doc_id: id,
    p_reason: reason.trim(),
  });

  if (error) return { ok: false, error: "cancelFailed", detail: error.message };
  await revalidateFor(type);
  return { ok: true };
}

/**
 * Post the document, returning the allocated number.
 *
 * A cross-warehouse transfer reaches this twice: the first call dispatches into
 * in_transit and the second confirms receipt. A same-warehouse transfer posts
 * once (D-44). The caller does not need to know which — it reads the status
 * back afterwards.
 */
export async function postDocument(
  type: DocType,
  id: string,
): Promise<ActionResult<{ docNo: string; status: string }>> {
  await requirePerm(perm(type, "post"));

  if (!DOC_CONFIG[type].posts) {
    return { ok: false, error: "notPostable" };
  }

  const supabase = await createClient();

  const { count } = await supabase
    .from(DOC_CONFIG[type].lineTable)
    .select("id", { count: "exact", head: true })
    .eq("header_id", id);

  if (!count) return { ok: false, error: "noLines" };

  const { data, error } = await supabase.rpc("post_document", {
    p_doc_type: type,
    p_doc_id: id,
  });

  if (error) {
    // The whole post is one transaction, so nothing landed. The document keeps
    // whatever status it had — an operator seeing "approved but not posted" is
    // closer to the truth than one seeing a draft that swallowed a failure.
    return { ok: false, error: "postFailed", detail: error.message };
  }

  const { data: header } = await supabase
    .from(DOC_CONFIG[type].table)
    .select("status")
    .eq("id", id)
    .maybeSingle();

  await revalidateFor(type);
  return {
    ok: true,
    data: { docNo: String(data), status: header?.status ?? "posted" },
  };
}

/**
 * Approve and post in one call, for documents whose approver and poster are the
 * same person by design.
 *
 * Used by the transfer screen: a putaway is approved and posted by the
 * warehouse staff who walked the stock across (D-22's reasoning extended to
 * internal moves). NOT used by issues, where the separation of duties is the
 * point — a warehouse user cannot approve an issue at all, so offering them a
 * combined button would only produce a permission error.
 */
export async function approveAndPost(
  type: DocType,
  id: string,
): Promise<ActionResult<{ docNo: string; status: string }>> {
  const approved = await approveDocument(type, id);
  if (!approved.ok) return approved;
  return postDocument(type, id);
}
