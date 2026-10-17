import { ClientSession, FilterQuery, Types } from 'mongoose';
import {
  DeliveryFeeProposalModel,
  DeliveryFeeProposalStatus,
  DeliveryFeeResponderRole,
  IDeliveryFeeApplication,
  IDeliveryFeeProposal,
  IDeliveryFeeProposalEdit,
  IDeliveryFeeProposalHistoryEntry,
} from '../models/delivery-fee-proposal.model';
import { IShipment, ShipmentModel, ShipmentStatus } from '../../shipments/shipment.model';
import { COUNTED_PROPOSAL_STATUSES, ProposalSide } from '../domain/delivery-fee-proposal.rules';
import { PAYER_PROPOSER_ROLES } from '../models/delivery-fee-proposal.model';

export interface ProposalPage {
  data: IDeliveryFeeProposal[];
  meta: { total: number; page: number; limit: number; pages: number };
}

/**
 * Persistence for delivery-fee proposals AND the two shipment fields this feature owns
 * (`pending_delivery_fee_proposal_id`, `delivery_fee_override`).
 *
 * The shipment writes live here rather than on `ShipmentRepository` deliberately: they are
 * written by nothing else, every one of them is a compare-and-set keyed on this feature's
 * pointer, and keeping them beside the proposal writes they always accompany makes the
 * "both in one transaction" rule visible in one file.
 */
export class DeliveryFeeProposalRepository {
  /** Insert — ARRAY form, or Mongoose silently writes outside the session. */
  async create(doc: Partial<IDeliveryFeeProposal>, session: ClientSession): Promise<IDeliveryFeeProposal> {
    const [created] = await DeliveryFeeProposalModel.create([doc], { session });
    return created;
  }

  async findById(id: string, session?: ClientSession): Promise<IDeliveryFeeProposal | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return DeliveryFeeProposalModel.findById(id, null, { session: session ?? undefined });
  }

  async listByShipment(shipmentId: string): Promise<IDeliveryFeeProposal[]> {
    return DeliveryFeeProposalModel.find({ shipment_id: new Types.ObjectId(shipmentId) }).sort({ created_at: -1 });
  }

  /** Every proposal on any of these shipments, newest first — one query for a list page. */
  async listByShipments(shipmentIds: string[]): Promise<IDeliveryFeeProposal[]> {
    const ids = [...new Set(shipmentIds)].filter((id) => Types.ObjectId.isValid(id));
    if (ids.length === 0) return [];
    return DeliveryFeeProposalModel.find({ shipment_id: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .sort({ created_at: -1 });
  }

  async listByOrder(orderId: string): Promise<IDeliveryFeeProposal[]> {
    return DeliveryFeeProposalModel.find({ order_id: new Types.ObjectId(orderId) }).sort({ created_at: -1 });
  }

  /**
   * Proposals counting against the two-per-shipment cap of ONE side. A change-agency difference
   * (ADR-A11 D-10) is nobody's proposal and spends neither side's re-propose. The agency side and
   * the payer side (vendor / customer, 2026-10-14) are counted apart.
   */
  async countCountedForShipment(shipmentId: string, side: ProposalSide = 'agency'): Promise<number> {
    return DeliveryFeeProposalModel.countDocuments({
      shipment_id: new Types.ObjectId(shipmentId),
      status: { $in: [...COUNTED_PROPOSAL_STATUSES] },
      origin: { $ne: 'change_agency' },
      proposed_by_role: side === 'payer' ? { $in: [...PAYER_PROPOSER_ROLES] } : { $nin: [...PAYER_PROPOSER_ROLES] },
    });
  }

  /**
   * The agency side accepted a CUSTOMER's online increase: the figure is frozen and the top-up
   * is asked for; the proposal stays pending until the money arrives (`DeliveryFeeTopupService`
   * then applies it exactly as it applies a customer-approved increase). The customer agreed by
   * proposing, so `customer_approval` is stamped with the proposer as the approving user.
   * CAS on pending + the version the agency saw + not accepted yet.
   */
  async setPayerAcceptanceAwaitingTopup(
    proposalId: Types.ObjectId,
    input: {
      version: number;
      role: 'agency' | 'agent';
      userId: string | null;
      agentId: string | null;
      customerUserId: Types.ObjectId | null;
      topupAmount: number;
      at: Date;
    }
  ): Promise<IDeliveryFeeProposal | null> {
    const oid = (v: string | null) => (v && Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null);
    return DeliveryFeeProposalModel.findOneAndUpdate(
      { _id: proposalId, status: 'pending', version: input.version, approver: 'agency', payer_acceptance: null },
      {
        $set: {
          payer_acceptance: {
            role: input.role,
            user_id: oid(input.userId),
            agent_id: oid(input.agentId),
            version: input.version,
            at: input.at,
          },
          customer_approval: {
            approved_at: input.at,
            version: input.version,
            user_id: input.customerUserId,
            topup_amount: input.topupAmount,
          },
          topup: { amount: input.topupAmount, transaction_id: null, status: 'awaiting_payment', paid_at: null },
        },
        $push: {
          status_history: {
            status: 'pending',
            changed_at: input.at,
            changed_by_role: input.role,
            changed_by_user_id: oid(input.userId),
            note: 'accepted_awaiting_topup',
          },
        },
      },
      { new: true }
    );
  }

  /** The agency's inbox: PAYER proposals on its shipments (`approver: 'agency'`), newest first. */
  async listForAgency(
    agencyId: string,
    filter: { status?: DeliveryFeeProposalStatus },
    page: number,
    limit: number
  ): Promise<ProposalPage> {
    const query: FilterQuery<IDeliveryFeeProposal> = { agency_id: new Types.ObjectId(agencyId), approver: 'agency' };
    if (filter.status) query.status = filter.status;
    const [data, total] = await Promise.all([
      DeliveryFeeProposalModel.find(query)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      DeliveryFeeProposalModel.countDocuments(query),
    ]);
    return { data, meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } };
  }

  /** The customer's view of one order: the proposals on its customer-paid shipments. */
  async listForCustomerOrder(customerId: string, orderId: string): Promise<IDeliveryFeeProposal[]> {
    return DeliveryFeeProposalModel.find({
      order_id: new Types.ObjectId(orderId),
      customer_id: new Types.ObjectId(customerId),
    }).sort({ created_at: -1 });
  }

  /**
   * The customer approved an increase that needs a top-up (online): record it, freezing the
   * figure. CAS on pending + the version they saw + not approved yet.
   */
  async setCustomerApproval(
    proposalId: Types.ObjectId,
    input: { version: number; customerId: string; userId: string | null; topupAmount: number; at: Date }
  ): Promise<IDeliveryFeeProposal | null> {
    return DeliveryFeeProposalModel.findOneAndUpdate(
      {
        _id: proposalId,
        status: 'pending',
        version: input.version,
        customer_id: new Types.ObjectId(input.customerId),
        customer_approval: null,
      },
      {
        $set: {
          customer_approval: {
            approved_at: input.at,
            version: input.version,
            user_id: input.userId && Types.ObjectId.isValid(input.userId) ? new Types.ObjectId(input.userId) : null,
            topup_amount: input.topupAmount,
          },
          topup: { amount: input.topupAmount, transaction_id: null, status: 'awaiting_payment', paid_at: null },
        },
      },
      { new: true }
    );
  }

  async listForVendor(
    vendorId: string,
    filter: { status?: DeliveryFeeProposalStatus; orderId?: string },
    page: number,
    limit: number
  ): Promise<ProposalPage> {
    const query: FilterQuery<IDeliveryFeeProposal> = { vendor_id: new Types.ObjectId(vendorId) };
    if (filter.status) query.status = filter.status;
    if (filter.orderId) query.order_id = new Types.ObjectId(filter.orderId);
    const [data, total] = await Promise.all([
      DeliveryFeeProposalModel.find(query)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      DeliveryFeeProposalModel.countDocuments(query),
    ]);
    return { data, meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) } };
  }

  /**
   * Resolve a pending proposal — the compare-and-set every transition goes through. `null`
   * on a miss: somebody else answered it first. A CONFLICT, never a not-found.
   */
  async transitionFromPending(
    proposalId: Types.ObjectId,
    to: Exclude<DeliveryFeeProposalStatus, 'pending'>,
    fields: {
      role: DeliveryFeeResponderRole;
      userId: string | null;
      rejectionNote?: string | null;
      withdrawalReason?: string | null;
      application?: IDeliveryFeeApplication | null;
      note?: string | null;
      /** Extra fields written with the transition (e.g. the paid top-up). */
      extraSet?: Record<string, unknown>;
      /** Extra filter predicates (e.g. the vendor scope). */
      scope?: FilterQuery<IDeliveryFeeProposal>;
    },
    session: ClientSession
  ): Promise<IDeliveryFeeProposal | null> {
    const now = new Date();
    const userId = fields.userId && Types.ObjectId.isValid(fields.userId) ? new Types.ObjectId(fields.userId) : null;
    const entry: IDeliveryFeeProposalHistoryEntry = {
      status: to,
      changed_at: now,
      changed_by_role: fields.role,
      changed_by_user_id: userId,
      note: fields.note ?? fields.rejectionNote ?? fields.withdrawalReason ?? null,
    };
    return DeliveryFeeProposalModel.findOneAndUpdate(
      { _id: proposalId, status: 'pending', ...(fields.scope ?? {}) },
      {
        $set: {
          status: to,
          responded_by_role: fields.role,
          responded_by_user_id: userId,
          responded_at: now,
          ...(fields.rejectionNote !== undefined ? { rejection_note: fields.rejectionNote } : {}),
          ...(fields.withdrawalReason !== undefined ? { withdrawal_reason: fields.withdrawalReason } : {}),
          ...(fields.application !== undefined ? { application: fields.application } : {}),
          ...(fields.extraSet ?? {}),
        },
        $push: { status_history: entry },
      },
      { new: true, session }
    );
  }

  /**
   * Edit a pending proposal in place — a compare-and-set on `status: 'pending'` AND the
   * version the caller read, so an edit racing a vendor answer (or another edit) loses
   * cleanly. Bumps `version`, appends to `edits`, stamps `last_edited_by`; an agency edit
   * also sets the sticky `agency_edited`. `null` on a miss.
   */
  async applyEdit(
    proposalId: Types.ObjectId,
    expectedVersion: number,
    edit: IDeliveryFeeProposalEdit,
    reason: string,
    fee: number,
    /** A payer's edit may cross the current fee, so it re-states the direction (2026-10-14). */
    direction?: 'increase' | 'decrease'
  ): Promise<IDeliveryFeeProposal | null> {
    return DeliveryFeeProposalModel.findOneAndUpdate(
      { _id: proposalId, status: 'pending', version: expectedVersion },
      {
        $set: {
          proposed_fee: fee,
          reason,
          ...(direction ? { direction } : {}),
          version: edit.version,
          last_edited_by: {
            role: edit.edited_by_role,
            user_id: edit.edited_by_user_id,
            agent_id: edit.edited_by_agent_id,
            at: edit.at,
          },
          ...(edit.edited_by_role === 'agency' ? { agency_edited: true } : {}),
        },
        $push: { edits: edit },
      },
      { new: true }
    );
  }

  // ── The shipment half ──────────────────────────────────────────────────────

  /**
   * Point the shipment at a new pending proposal — only while it is in the window, owned by
   * this agency (and agent, when one proposes), and has no pending proposal already. This
   * CAS is what serialises a proposal against the pickup transition, whose own CAS requires
   * the pointer to be null.
   */
  async claimPendingPointer(
    input: {
      shipmentId: string;
      proposalId: Types.ObjectId;
      agencyId: string;
      agentId: string | null;
      window: readonly ShipmentStatus[];
    },
    session: ClientSession
  ): Promise<IShipment | null> {
    const filter: FilterQuery<IShipment> = {
      _id: input.shipmentId,
      agency_id: input.agencyId,
      status: { $in: [...input.window] },
      pending_delivery_fee_proposal_id: null,
    };
    if (input.agentId) filter.agent_id = input.agentId;
    return ShipmentModel.findOneAndUpdate(
      filter,
      { $set: { pending_delivery_fee_proposal_id: input.proposalId } },
      { new: true, session }
    );
  }

  /** Clear the pointer if (and only if) it still names this proposal. Idempotent. */
  async releasePendingPointer(
    shipmentId: Types.ObjectId | string,
    proposalId: Types.ObjectId,
    session: ClientSession
  ): Promise<void> {
    await ShipmentModel.updateOne(
      { _id: shipmentId, pending_delivery_fee_proposal_id: proposalId },
      { $set: { pending_delivery_fee_proposal_id: null } },
      { session }
    );
  }

  /**
   * Apply an approved fee: write the override, clear the pointer and — prepaid, already
   * split — rewrite the snapshot, in one guarded write. Misses (null) when the pointer no
   * longer names this proposal or the shipment left the window.
   */
  async applyApprovedFee(
    input: {
      shipmentId: Types.ObjectId | string;
      proposalId: Types.ObjectId;
      fee: number;
      rewriteSnapshot: boolean;
      expectedSnapshot: number | null;
      window: readonly ShipmentStatus[];
      approvedAt: Date;
    },
    session: ClientSession
  ): Promise<IShipment | null> {
    const filter: FilterQuery<IShipment> = {
      _id: input.shipmentId,
      pending_delivery_fee_proposal_id: input.proposalId,
      status: { $in: [...input.window] },
    };
    // The snapshot the money plan was computed against must still be the one on the row.
    if (input.rewriteSnapshot) filter.delivery_fee_snapshot = input.expectedSnapshot;
    return ShipmentModel.findOneAndUpdate(
      filter,
      {
        $set: {
          pending_delivery_fee_proposal_id: null,
          delivery_fee_override: {
            amount: input.fee,
            proposal_id: input.proposalId,
            approved_at: input.approvedAt,
          },
          ...(input.rewriteSnapshot ? { delivery_fee_snapshot: input.fee } : {}),
        },
      },
      { new: true, session }
    );
  }

  async findShipmentInSession(shipmentId: string, session: ClientSession): Promise<IShipment | null> {
    return ShipmentModel.findById(shipmentId, null, { session });
  }
}

export const deliveryFeeProposalRepository = new DeliveryFeeProposalRepository();
