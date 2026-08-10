import {
  IStockAdjustmentRequest,
  StockRequestParty,
  StockRequestStatus,
} from '../models/stock-adjustment-request.model';

/** What a party may do to a request right now. */
export type StockRequestAction = 'approve' | 'reject' | 'withdraw';

export interface StockRequestDto {
  id: string;
  productId: string;
  variantId: string;
  vendorId: string;
  agencyId: string;

  requestedByRole: StockRequestParty;
  requestedAt: string;

  quantityBefore: number;
  infiniteBefore: boolean;
  requestedQuantity: number;
  requestedInfinite: boolean;

  status: StockRequestStatus;
  note: string | null;

  /**
   * `variant.stock` as of THIS read, when the caller supplied it.
   *
   * Not the same thing as `quantityBefore`: that is what the proposer saw. The two
   * differing is the drift an approver needs to notice before signing off, and it
   * is why nothing here 409s on it — the request proposes an absolute number, so
   * drift changes what is being replaced, not whether the request still makes sense.
   */
  currentQuantity: number | null;
  currentInfinite: boolean | null;

  /**
   * True when the viewer is the one who has to answer. Derived here rather than in
   * a client so two dashboards cannot disagree about whose turn it is.
   */
  awaitingMyDecision: boolean;
  /**
   * The verbs this viewer may call, right now. A client renders buttons from this
   * and never re-implements the authority table — which is the whole point: the
   * table lives in `StockRequestService`, and this is its projection.
   */
  availableActions: StockRequestAction[];

  approval: {
    byRole: StockRequestParty;
    at: string;
    quantityAtApply: number;
  } | null;
  rejection: {
    byRole: StockRequestParty;
    at: string;
    reason: string | null;
  } | null;
  withdrawal: {
    byRole: StockRequestParty;
    at: string;
  } | null;

  statusHistory: Array<{
    status: StockRequestStatus;
    changedAt: string;
    changedByRole: StockRequestParty;
    note: string | null;
  }>;

  createdAt: string;
  updatedAt: string;
}

/** Live variant state, when the caller has it to hand. */
export interface StockRequestLiveState {
  quantity: number;
  isInfinite: boolean;
}

export class StockRequestMapper {
  /**
   * @param viewerRole whose buttons to compute. The same row maps to two different
   *   `availableActions` depending on who is asking, which is exactly why this
   *   takes the role instead of exposing the raw `requested_by_role` and hoping.
   */
  static toDto(
    doc: IStockAdjustmentRequest,
    viewerRole: StockRequestParty,
    live?: StockRequestLiveState | null,
  ): StockRequestDto {
    const isPending = doc.status === 'pending';
    const mine = doc.requested_by_role === viewerRole;

    return {
      id: doc._id.toString(),
      productId: doc.product_id.toString(),
      variantId: doc.variant_id.toString(),
      vendorId: doc.vendor_id.toString(),
      agencyId: doc.agency_id.toString(),

      requestedByRole: doc.requested_by_role,
      requestedAt: doc.requested_at.toISOString(),

      quantityBefore: doc.quantity_before,
      infiniteBefore: doc.infinite_before,
      requestedQuantity: doc.requested_quantity,
      requestedInfinite: doc.requested_infinite,

      status: doc.status,
      note: doc.note ?? null,

      currentQuantity: live ? live.quantity : null,
      currentInfinite: live ? live.isInfinite : null,

      awaitingMyDecision: isPending && !mine,
      availableActions: resolveAvailableActions(doc.status, doc.requested_by_role, viewerRole),

      approval: doc.approval
        ? {
          byRole: doc.approval.by_role,
          at: doc.approval.at.toISOString(),
          quantityAtApply: doc.approval.quantity_at_apply,
        }
        : null,
      rejection: doc.rejection
        ? {
          byRole: doc.rejection.by_role,
          at: doc.rejection.at.toISOString(),
          reason: doc.rejection.reason ?? null,
        }
        : null,
      withdrawal: doc.withdrawal
        ? { byRole: doc.withdrawal.by_role, at: doc.withdrawal.at.toISOString() }
        : null,

      statusHistory: (doc.status_history ?? []).map(entry => ({
        status: entry.status,
        changedAt: entry.changed_at.toISOString(),
        changedByRole: entry.changed_by_role,
        note: entry.note ?? null,
      })),

      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }
}

/**
 * The authority table, as a pure function — the single definition of who may do
 * what, shared by the DTO (to render buttons) and the service (to enforce them).
 * Keeping one copy is what stops a dashboard offering a button the API refuses.
 *
 * The asymmetry is deliberate and mirrors `ContractTermsProposal`: the **author**
 * may only withdraw, the **counterparty** may only approve or reject. Give the
 * author a reject and a request has two ways to die that mean different things;
 * give the counterparty a withdraw and either side can retract the other's ask.
 */
export function resolveAvailableActions(
  status: StockRequestStatus,
  requestedByRole: StockRequestParty,
  viewerRole: StockRequestParty,
): StockRequestAction[] {
  if (status !== 'pending') return [];
  return requestedByRole === viewerRole ? ['withdraw'] : ['approve', 'reject'];
}
