/**
 * One table describing every document type.
 *
 * Five Phase 2 screens each need the same handful of facts about the document
 * they are editing: which table holds it, which permission gates it, whether it
 * posts at all, where its pages live. Written out once here rather than
 * scattered as literals through the screens, so adding ใบตรวจนับ in Phase 3 is
 * a row rather than a search for every place a document type is spelled out.
 *
 * Deliberately NOT derived from the database. These are facts about the
 * application's routes and screens; the database's own view of a document type
 * is the `document_type` enum, and the two are checked against each other by
 * `DOC_TYPES` being typed as the enum union.
 */

export type DocType =
  | "goods_receipt"
  | "requisition"
  | "issue"
  | "transfer"
  | "delivery_note"
  | "consignment_settlement"
  | "adjustment"
  | "cycle_count";

export type DocStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "dispatched"
  | "posted"
  | "cancelled";

export type DocConfig = {
  /** Table holding the header. The enum label plus 's', as the RPCs assume. */
  table: string;
  /** Table holding the lines. */
  lineTable: string;
  /** Document number prefix, for recognising one in a search box. */
  prefix: string;
  /**
   * False for documents whose lifecycle ends at `approved`. A requisition is a
   * request fulfilled by an issue, so posting it would move nothing while
   * burning a number (D-45).
   */
  posts: boolean;
  /** Section of the app that owns this type, or null if it has no screens yet. */
  route: string | null;
};

export const DOC_CONFIG: Record<DocType, DocConfig> = {
  goods_receipt: {
    table: "goods_receipts",
    lineTable: "goods_receipt_lines",
    prefix: "GR",
    posts: true,
    route: "/receive",
  },
  requisition: {
    table: "requisitions",
    lineTable: "requisition_lines",
    prefix: "RQ",
    posts: false,
    route: "/requisitions",
  },
  issue: {
    table: "issues",
    lineTable: "issue_lines",
    prefix: "IS",
    posts: true,
    route: "/issues",
  },
  transfer: {
    table: "transfers",
    lineTable: "transfer_lines",
    prefix: "TR",
    posts: true,
    route: "/transfers",
  },
  delivery_note: {
    table: "delivery_notes",
    lineTable: "delivery_note_lines",
    prefix: "DN",
    posts: true,
    route: "/delivery-notes",
  },
  consignment_settlement: {
    table: "consignment_settlements",
    lineTable: "consignment_settlement_lines",
    prefix: "CS",
    posts: true,
    route: null,
  },
  adjustment: {
    table: "adjustments",
    lineTable: "adjustment_lines",
    prefix: "AD",
    posts: true,
    route: null,
  },
  cycle_count: {
    table: "cycle_counts",
    lineTable: "cycle_count_lines",
    prefix: "CC",
    posts: false,
    route: null,
  },
};

export const DOC_TYPES = Object.keys(DOC_CONFIG) as DocType[];

/** Permission codes follow `<type>.<verb>` throughout, so they are derived. */
export const perm = (type: DocType, verb: "create" | "approve" | "post") =>
  `${type}.${verb}`;

/**
 * Which statuses are still editable.
 *
 * Mirrors the RLS policies rather than replacing them: a screen that hides the
 * edit controls once a document is submitted is being kind to the operator, and
 * the policy is what actually refuses the write.
 */
export const isEditable = (status: DocStatus) => status === "draft";

/** Terminal states — nothing further will happen to the document. */
export const isFinal = (type: DocType, status: DocStatus) =>
  status === "cancelled" ||
  status === "posted" ||
  (!DOC_CONFIG[type].posts && status === "approved");

export const STATUS_TONE: Record<DocStatus, "neutral" | "info" | "warn" | "good" | "bad"> =
  {
    draft: "neutral",
    submitted: "info",
    approved: "warn",
    dispatched: "info",
    posted: "good",
    cancelled: "bad",
  };
