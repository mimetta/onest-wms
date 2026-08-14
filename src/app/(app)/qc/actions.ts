"use server";

import { revalidatePath } from "next/cache";
import { requirePerm, requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type QcResult =
  | { ok: true; docNo?: string; awaitingApproval?: boolean }
  | { ok: false; error: string; detail?: string };

/**
 * Record a QC decision on a lot.
 *
 * The effect is system-wide and immediate, because the gate lives on the lot
 * rather than on the location (D-04): passing makes the lot available
 * everywhere at once, including quantity already put away; failing makes it
 * unissuable everywhere, including stock a picker is standing next to.
 *
 * qc_by and qc_at are stamped by the trigger in migration 0011, so this
 * function does not set them — it would only be able to disagree.
 */
export async function setQcStatus(
  lotId: string,
  status: "passed" | "failed" | "quarantined",
  note?: string,
): Promise<QcResult> {
  await requirePerm("lot.set_qc_status");
  const supabase = await createClient();

  const { error } = await supabase
    .from("lots")
    .update({ qc_status: status, qc_note: note || null })
    .eq("id", lotId);

  if (error) return { ok: false, error: "errorSave", detail: error.message };

  revalidatePath("/qc");
  revalidatePath("/stock");
  return { ok: true };
}

/**
 * Raise a write-off for everything remaining of a lot that did not pass QC.
 *
 * This is the action D-14 exists to make possible: without it a failed lot is
 * trapped in the warehouse forever, visible but unusable and unremovable.
 *
 * **It does not always complete in one step, and that is deliberate.** D-20
 * gave `qc` the ability to create and post an adjustment but withheld
 * `adjustment.approve`, keeping a two-person check on destroying stock. So:
 *
 *   - a `qc` user raises the write-off and it waits for a manager
 *   - an `admin` (who holds all three) approves and posts immediately
 *
 * Pretending otherwise would mean either granting QC self-approval — quietly
 * undoing a control the owner chose — or showing a success message for
 * something that has not happened.
 *
 * The adjustment is built from the lot's actual on-hand rows, so a lot sitting
 * in three bins produces three lines and the whole thing posts atomically.
 */
export async function scrapLot(lotId: string, reasonCodeId: string): Promise<QcResult> {
  const user = await requireUser();

  if (!user.permissions.has("lot.dispose_unpassed")) {
    return { ok: false, error: "notAllowedToScrap" };
  }
  if (!user.permissions.has("adjustment.create")) {
    return { ok: false, error: "notAllowedToRaise" };
  }

  const supabase = await createClient();

  const { data: lot } = await supabase
    .from("lots")
    .select("id, lot_no, product_id, qc_status, products(base_uom_id)")
    .eq("id", lotId)
    .maybeSingle();

  if (!lot) return { ok: false, error: "lotNotFound" };

  // A passed lot is ordinary stock; writing it off is an adjustment like any
  // other and does not belong on the QC screen.
  if (lot.qc_status === "passed") return { ok: false, error: "lotPassed" };

  const product = lot.products as unknown as { base_uom_id: string } | null;
  if (!product) return { ok: false, error: "lotNotFound" };

  const { data: onHand, error: stockError } = await supabase
    .from("stock_on_hand")
    .select("location_id, qty")
    .eq("lot_id", lotId);

  if (stockError) return { ok: false, error: "errorSave", detail: stockError.message };

  // Virtual bins hold no physical stock to scrap — OPENING carries the negative
  // of everything that predates the ledger, and including it would try to
  // "scrap" a bookkeeping entry.
  const { data: virtualBins } = await supabase
    .from("locations")
    .select("id")
    .eq("is_virtual", true);

  const virtual = new Set((virtualBins ?? []).map((b) => b.id));
  const lines = (onHand ?? []).filter(
    (row) => Number(row.qty) > 0 && !virtual.has(row.location_id as string),
  );

  if (lines.length === 0) return { ok: false, error: "nothingToScrap" };

  const { data: adjustment, error: headerError } = await supabase
    .from("adjustments")
    .insert({
      warehouse_id: user.warehouseId,
      reason_code_id: reasonCodeId,
      created_by: user.id,
      notes: `QC write-off · lot ${lot.lot_no}`,
    })
    .select("id")
    .single();

  if (headerError) return { ok: false, error: "errorSave", detail: headerError.message };

  /**
   * Remove a half-built adjustment.
   *
   * Everything after the header insert can fail, and leaving the wreckage
   * behind would fill the adjustments list with drafts nobody raised on
   * purpose — noise in exactly the place a manager is looking for real
   * write-offs to approve. A draft has posted nothing, so deleting it destroys
   * no history.
   */
  const discard = async () => {
    await supabase.from("adjustments").delete().eq("id", adjustment.id);
  };

  const { error: linesError } = await supabase.from("adjustment_lines").insert(
    lines.map((row, index) => ({
      header_id: adjustment.id,
      line_no: index + 1,
      product_id: lot.product_id,
      lot_id: lotId,
      qty: Number(row.qty),
      uom_id: product.base_uom_id,
      // from_location with no to_location: stock leaves the building.
      from_location_id: row.location_id,
    })),
  );

  if (linesError) {
    await discard();
    return { ok: false, error: "errorSave", detail: linesError.message };
  }

  const canApprove = user.permissions.has("adjustment.approve");
  const canPost = user.permissions.has("adjustment.post");

  if (!canApprove || !canPost) {
    // Leave it submitted for a manager. The lot stays failed and unissuable
    // meanwhile, so nothing unsafe is waiting on the approval — only the
    // paperwork that removes it from the shelf.
    const { error: submitError } = await supabase.rpc("submit_document", {
      p_doc_type: "adjustment",
      p_doc_id: adjustment.id,
    });
    if (submitError) {
      await discard();
      return { ok: false, error: "errorSave", detail: submitError.message };
    }

    revalidatePath("/qc");
    return { ok: true, awaitingApproval: true };
  }

  // Approve then post, both through the RPCs (D-38). post_document() checks
  // lot.dispose_unpassed itself for a disposal-class movement, so the guard at
  // the top of this function is a courtesy, not the enforcement.
  const { error: approveError } = await supabase.rpc("approve_document", {
    p_doc_type: "adjustment",
    p_doc_id: adjustment.id,
  });
  if (approveError) {
    await discard();
    return { ok: false, error: "approveFailed", detail: approveError.message };
  }

  const { data: docNo, error: postError } = await supabase.rpc("post_document", {
    p_doc_type: "adjustment",
    p_doc_id: adjustment.id,
  });
  if (postError) {
    // Not discarded: the document is approved, and an approved document that
    // failed to post is a real state a manager should see and retry, not
    // something to erase quietly.
    return { ok: false, error: "postFailed", detail: postError.message };
  }

  revalidatePath("/qc");
  revalidatePath("/stock");
  return { ok: true, docNo: String(docNo) };
}
