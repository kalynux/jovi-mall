import { ClientSession, FilterQuery, Types } from 'mongoose';
import { ShipmentModel, IShipment, IShipmentItem, ShipmentStatus, ShipmentRejectionReason, IShipmentHandover, IShipmentAgentCancellation, IShipmentDeliveryFailure, UNTERMINATED_SHIPMENT_STATUSES } from './shipment.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { buildSearchRegex } from '../../core/utils/regex.util';
import { CustomerModel } from '../customers/customer.model';
import { OrderModel } from '../orders/order.model';
import { ProductModel } from '../catalog/models/product.model';
import { TrackingNumberGenerator } from './utils/tracking-number.generator';

/**
 * Ceiling on each id set pre-resolved during a shipment text search.
 *
 * A Shipment carries no denormalised text, so searching by customer/product/
 * order means resolving those collections to id sets first and matching
 * shipments against them. Those pre-queries are NOT scoped to the caller — a
 * broad term ("ma") can match a large fraction of the platform's customers — so
 * each is capped to keep the resulting `$in` bounded. A term matching more than
 * this many rows searches only the first `SEARCH_ID_FANOUT_CAP` of them.
 *
 * If this ever becomes a real limitation, the fix is to denormalise a search
 * blob onto the Shipment at creation time, not to raise the cap.
 */
const SEARCH_ID_FANOUT_CAP = 500;

/**
 * Input to `applyStatusChangeIfCurrent`. An object rather than positionals: the
 * filter carries four optional predicates and a positional list would be
 * unreadable at the call site.
 */
export interface GuardedStatusChange {
  shipmentId: string;
  /** The status the caller READ and validated the transition against. */
  fromStatus: ShipmentStatus;
  toStatus: ShipmentStatus;
  actor: { userId: string | null; role: string };
  /** Ownership predicates folded into the CAS filter — whichever the actor has. */
  agencyId?: string | null;
  agentId?: string | null;
  /** Appended to `delivery_failures`; agent-reported `failed`/`returned` only. */
  failure?: IShipmentDeliveryFailure | null;
}

export class ShipmentRepository {
  /**
   * Create a shipment. Pass a `session` to enrol the write in a transaction
   * (used by the multi-vendor cart split, which creates orders + shipments atomically).
   *
   * The tracking number is stamped HERE rather than at the two call sites, so a
   * third one cannot forget: every shipment carries a number from the instant it
   * exists. Any `tracking_number` in `data` is ignored — the field is generated,
   * never supplied (see TrackingNumberGenerator).
   */
  async create(data: Partial<IShipment>, session?: ClientSession): Promise<IShipment> {
    const payload: Partial<IShipment> = {
      ...data,
      tracking_number: await TrackingNumberGenerator.generate(data.agency_id!.toString(), session),
    };

    if (session) {
      const [shipment] = await ShipmentModel.create([payload], { session });
      return shipment;
    }
    return await ShipmentModel.create(payload);
  }

  async findById(shipmentId: string): Promise<IShipment | null> {
    return await ShipmentModel.findById(shipmentId);
  }

  async findByOrderId(orderId: string): Promise<IShipment[]> {
    return await ShipmentModel.find({ order_id: orderId });
  }

  /**
   * Batch-load shipments by id. Deduplicates; missing ids are simply absent.
   * For enrichment paths that hold a set of shipment references (assignment
   * offers) and would otherwise issue one findById per row.
   */
  async findManyByIds(shipmentIds: string[]): Promise<IShipment[]> {
    const ids = [...new Set(shipmentIds)].filter((id) => Types.ObjectId.isValid(id));
    if (ids.length === 0) return [];
    return await ShipmentModel.find({ _id: { $in: ids } });
  }

  /**
   * Count an agency's "unterminated" shipments (the billing/plan soft cap). Pass a
   * `session` to read within a transaction. See `UNTERMINATED_SHIPMENT_STATUSES`.
   */
  async countUnterminatedByAgency(agencyId: string, session?: ClientSession): Promise<number> {
    const query = ShipmentModel.countDocuments({
      agency_id: new Types.ObjectId(agencyId),
      status: { $in: UNTERMINATED_SHIPMENT_STATUSES },
    });
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * Build the `$or` clause matching `q` against everything an agent or agency
   * would recognise a shipment by: the customer's NAME or PHONE, a PRODUCT
   * title on the shipment, the ORDER NUMBER, and the shipment's own TRACKING
   * NUMBER.
   *
   * The Shipment document is entirely un-denormalised — `tracking_number` is
   * its only text field — so everything else resolves in two phases: regex the
   * owning collections down to id sets, then match shipments against those.
   * This is the same pattern TicketReferenceService uses; there is no `$text`
   * index anywhere in this codebase.
   *
   * Product matching goes through the shipment's OWN `items.product_id` rather
   * than the order's item titles: a shipment carries a subset of its order's
   * items, so matching at the order level would return sibling shipments that
   * do not contain the searched product.
   *
   * Returns null when the term cannot match anything, so callers can skip the
   * query entirely rather than run an `$or` that is guaranteed empty.
   */
  private async buildSearchClause(q: string): Promise<FilterQuery<IShipment> | null> {
    const rx = buildSearchRegex(q);

    const [customers, products] = await Promise.all([
      CustomerModel.find({ $or: [{ name: rx }, { phone: rx }] })
        .select('_id')
        .limit(SEARCH_ID_FANOUT_CAP)
        .lean()
        .exec(),
      ProductModel.find({ title: rx })
        .select('_id')
        .limit(SEARCH_ID_FANOUT_CAP)
        .lean()
        .exec(),
    ]);

    const customerIds = customers.map((c) => c._id);
    const productIds = products.map((p) => p._id);

    const orders = await OrderModel.find({
      $or: [
        { order_number: rx },
        ...(customerIds.length ? [{ customer_id: { $in: customerIds } }] : []),
      ],
    })
      .select('_id')
      .limit(SEARCH_ID_FANOUT_CAP)
      .lean()
      .exec();
    const orderIds = orders.map((o) => o._id);

    const or: FilterQuery<IShipment>[] = [{ tracking_number: rx }];
    if (orderIds.length) or.push({ order_id: { $in: orderIds } });
    if (productIds.length) or.push({ 'items.product_id': { $in: productIds } });

    return { $or: or };
  }

  /**
   * Shipment ids matching a text search, capped.
   *
   * For callers that page a DIFFERENT collection keyed by shipment — the
   * assignment offers an agent is deciding on — so that searching offers means
   * the same thing as searching shipments, from one definition.
   *
   * Deliberately unscoped: every such caller already scopes its own query by
   * `agent_id`, so narrowing here would only duplicate that (and an agent's
   * offers are the only rows they can read regardless).
   */
  async findIdsMatchingSearch(q: string): Promise<Types.ObjectId[]> {
    const search = await this.buildSearchClause(q);
    if (!search) return [];
    const docs = await ShipmentModel.find(search)
      .select('_id')
      .limit(SEARCH_ID_FANOUT_CAP)
      .lean()
      .exec();
    return docs.map((d) => d._id as Types.ObjectId);
  }

  /**
   * Merge the ownership/status filter with an optional text search. Kept in one
   * place so the agency and agent lists can never diverge on scoping.
   */
  private async applySearch(
    base: FilterQuery<IShipment>,
    q?: string
  ): Promise<FilterQuery<IShipment>> {
    if (!q) return base;
    const search = await this.buildSearchClause(q);
    if (!search) return base;
    return { $and: [base, search] };
  }

  /**
   * Find a shipment scoped to the owning agency. Returns null if it doesn't
   * exist or isn't owned by this agency — ownership is never leaked.
   */
  async findByIdAndAgency(shipmentId: string, agencyId: string): Promise<IShipment | null> {
    if (!Types.ObjectId.isValid(shipmentId)) return null;
    return await ShipmentModel.findOne({ _id: shipmentId, agency_id: agencyId });
  }

  /**
   * List shipments assigned to an agency, newest first, paginated. Filters by
   * status when provided.
   *
   * Always excludes `pending` — a shipment exists in that status from the
   * moment the (unpaid) order is created, before any vendor review or
   * dispatch. An agency must never see a shipment before the vendor has
   * explicitly dispatched it (see VendorOrderService.dispatchToAgency) or
   * auto-redirect kicked in on payment.
   */
  async findByAgencyPaginated(
    agencyId: string,
    filters: { status?: ShipmentStatus; q?: string } = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<Page<IShipment>> {
    const { page, limit } = pagination;
    const scope: FilterQuery<IShipment> = { agency_id: agencyId, status: { $ne: 'pending' } };
    // A requested filter narrows the set, but can never re-include 'pending'.
    if (filters.status && filters.status !== 'pending') scope.status = filters.status;
    const filter = await this.applySearch(scope, filters.q);

    const [total, docs] = await Promise.all([
      ShipmentModel.countDocuments(filter).exec(),
      ShipmentModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Find a shipment scoped to the assigned agent. Returns null if it doesn't
   * exist or isn't assigned to this agent — ownership is never leaked.
   */
  async findByIdAndAgent(shipmentId: string, agentId: string): Promise<IShipment | null> {
    if (!Types.ObjectId.isValid(shipmentId)) return null;
    return await ShipmentModel.findOne({ _id: shipmentId, agent_id: agentId });
  }

  /**
   * List shipments assigned to an agent, newest first, paginated. Mirrors
   * findByAgencyPaginated — 'pending' shipments have no agent yet, so the
   * exclusion is implicit, but kept explicit for symmetry.
   */
  async findByAgentPaginated(
    agentId: string,
    filters: { status?: ShipmentStatus; q?: string } = {},
    pagination: PaginationOptions = { page: 1, limit: 20 }
  ): Promise<Page<IShipment>> {
    const { page, limit } = pagination;
    const scope: FilterQuery<IShipment> = { agent_id: agentId, status: { $ne: 'pending' } };
    if (filters.status && filters.status !== 'pending') scope.status = filters.status;
    const filter = await this.applySearch(scope, filters.q);

    const [total, docs] = await Promise.all([
      ShipmentModel.countDocuments(filter).exec(),
      ShipmentModel.find(filter)
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
    ]);

    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Record the delivery fee this shipment was charged at, per shipment id.
   *
   * Written by the earnings split at the moment the fee is charged to the vendor
   * (see IShipment.delivery_fee_snapshot for why it must be snapshotted rather
   * than recomputed). A bulk write because one order's split charges every one of
   * its shipments at once. Idempotent — re-running a split rewrites the same
   * numbers.
   */
  async setDeliveryFeeSnapshots(
    feesByShipmentId: Map<string, number>,
    session?: ClientSession
  ): Promise<void> {
    if (feesByShipmentId.size === 0) return;
    await ShipmentModel.bulkWrite(
      [...feesByShipmentId.entries()].map(([shipmentId, fee]) => ({
        updateOne: {
          filter: { _id: new Types.ObjectId(shipmentId) },
          update: { $set: { delivery_fee_snapshot: fee } },
        },
      })),
      session ? { session } : {}
    );
  }

  /**
   * Shipments whose delivery outcome is settled but whose earnings split may
   * never have landed (the split is best-effort after the status commit). Feeds
   * the release worker's recovery stage; `cutoff` gives an in-flight split time
   * to finish before the sweep retries it.
   */
  async findSettledSince(
    statuses: ShipmentStatus[],
    cutoff: Date,
    limit: number
  ): Promise<IShipment[]> {
    return await ShipmentModel.find({
      status: { $in: statuses },
      updated_at: { $lte: cutoff },
    })
      .sort({ updated_at: 1 })
      .limit(limit);
  }

  /**
   * Set or clear the delivery-proof File reference on a shipment. Pass `null` to
   * clear it (on proof removal). The File itself is owned by the agency and lives
   * in file_references; this only mirrors the current proof's id onto the shipment.
   */
  async setDeliveryProof(shipmentId: string, fileId: string | null): Promise<IShipment | null> {
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $set: { delivery_proof_file_id: fileId ? new Types.ObjectId(fileId) : null } },
      { new: true }
    );
  }

  /**
   * Find a shipment for an order/agency pair that can still accept more items.
   * Only shipments that have not yet left the agency (`pending` or `assigned`)
   * are groupable — once a courier has picked up, a late item gets its own
   * shipment instead. Returns null when no such shipment exists.
   */
  async findGroupableByOrderAndAgency(orderId: string, agencyId: string): Promise<IShipment | null> {
    return await ShipmentModel.findOne({
      order_id: orderId,
      agency_id: agencyId,
      status: { $in: ['pending', 'assigned'] }
    });
  }

  /** Append a line item to a shipment. Returns the updated shipment. */
  async addItem(shipmentId: string, item: IShipmentItem): Promise<IShipment | null> {
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $push: { items: item } },
      { new: true }
    );
  }

  /**
   * Remove a line item from a shipment. If the shipment is left with no items,
   * it is deleted (an empty shipment has nothing to dispatch). Returns the
   * remaining shipment, or null when it was deleted / not found.
   */
  async removeItem(shipmentId: string, orderItemId: string): Promise<IShipment | null> {
    const updated = await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $pull: { items: { order_item_id: orderItemId } } },
      { new: true }
    );

    if (updated && updated.items.length === 0) {
      await ShipmentModel.deleteOne({ _id: shipmentId });
      return null;
    }

    return updated;
  }

  /**
   * Advance all `pending` shipments of an order to `assigned` (the hand-off to
   * the agency). Returns the shipments that were updated (so callers can
   * notify each shipment's agency) — empty when nothing was pending. Only
   * `pending` shipments are touched, so this is safe to call idempotently.
   */
  async assignPendingByOrderId(orderId: string): Promise<IShipment[]> {
    const pending = await ShipmentModel.find({ order_id: orderId, status: 'pending' });
    if (pending.length === 0) return [];

    await ShipmentModel.updateMany(
      { order_id: orderId, status: 'pending' },
      { $set: { status: 'assigned' } }
    );

    pending.forEach(s => { s.status = 'assigned'; });
    return pending;
  }

  /**
   * Apply an already-validated status transition: sets `status` and appends a
   * `status_history` entry in one atomic update. Callers (ShipmentService) own
   * transition validation — this is a dumb write.
   */
  async applyStatusChange(
    shipmentId: string,
    newStatus: ShipmentStatus,
    actor: { userId: string | null; role: string },
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: { status: newStatus },
        $push: {
          status_history: {
            status: newStatus,
            changed_at: new Date(),
            changed_by_user_id: actor.userId ? new Types.ObjectId(actor.userId) : null,
            changed_by_role: actor.role,
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Apply an already-validated status transition ONLY IF the shipment is still in
   * exactly the status (and ownership) the caller read — the concurrency-safe
   * transition primitive, mirroring `claimForAgentCancel` / `bindAgentIfUnassigned`.
   *
   * `applyStatusChange` above is an unguarded `findByIdAndUpdate`. That was safe
   * while the AGENCY was the only actor that could reach it. Now that the agent
   * app drives the same state machine (POST /api/agent/shipments/:id/status),
   * two callers can both read `in_transit`, one write `agent_delivered` and the
   * other `failed` — and the loser's post-commit side effects (the earnings
   * split, the capacity release, the COD return handling) still run for a status
   * nobody is in. Matching on `status: fromStatus` makes Mongo serialise them on
   * the document: exactly one update matches, the other gets null and its caller
   * reports a conflict instead of corrupting the ledger.
   *
   * The ownership predicate is folded into the same filter rather than trusted
   * from the caller's earlier read: between that read and this write the agency
   * can reassign the shipment away, which clears `agent_id`.
   *
   * Returns null on a miss — "someone else moved it", not an error at this layer.
   */
  async applyStatusChangeIfCurrent(
    input: GuardedStatusChange,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const now = new Date();

    const filter: FilterQuery<IShipment> = { _id: input.shipmentId, status: input.fromStatus };
    if (input.agencyId) filter.agency_id = input.agencyId;
    if (input.agentId) filter.agent_id = input.agentId;

    const push: Record<string, unknown> = {
      status_history: {
        status: input.toStatus,
        changed_at: now,
        changed_by_user_id: input.actor.userId ? new Types.ObjectId(input.actor.userId) : null,
        changed_by_role: input.actor.role,
      },
    };
    // Appended in the SAME atomic update as the history entry, so a recorded
    // failure and the transition it explains are never observable apart.
    if (input.failure) push.delivery_failures = input.failure;

    return await ShipmentModel.findOneAndUpdate(
      filter,
      { $set: { status: input.toStatus }, $push: push },
      { new: true, session: session ?? undefined }
    );
  }

  /** Record a rejection with reason (+ optional note) and set `status = 'rejected'`. */
  async applyRejection(
    shipmentId: string,
    reason: ShipmentRejectionReason,
    note: string | null,
    rejectedByUserId: string,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          status: 'rejected',
          rejection: { reason, note: note ?? null, rejectedAt: now, rejectedBy: new Types.ObjectId(rejectedByUserId) },
        },
        $push: {
          status_history: {
            status: 'rejected',
            changed_at: now,
            changed_by_user_id: new Types.ObjectId(rejectedByUserId),
            changed_by_role: 'agency',
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Bind an agent to a shipment — the moment an offer is accepted. Sets
   * `agent_id` (the authoritative binding, which makes the agent trackable) and
   * mirrors it onto the `assignment` sub-doc for the agency dashboard.
   * Ownership/eligibility is validated by the caller.
   */
  async assignAgent(shipmentId: string, agentId: string, session?: ClientSession): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          agent_id: new Types.ObjectId(agentId),
          assignment: {
            state: 'accepted',
            current_offer_id: null,
            offered_agent_id: new Types.ObjectId(agentId),
            updated_at: new Date(),
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Bind an agent to a shipment ONLY IF it is still unassigned and offerable —
   * the concurrency-safe acceptance primitive.
   *
   * This is the single serialisation point for "first valid approval wins": with
   * the offer layer now allowing several agents to hold an acceptable offer at
   * once (a timed-out agent keeps theirs), two simultaneous accepts both reach
   * this write, but the filter `agent_id: null` matches for only ONE of them —
   * Mongo serialises the update on the document. The loser gets null and reports
   * "another agent already accepted" (the requirement's STEP 7 / STEP 11). Runs
   * inside the accept transaction so a later failure (capacity/COD) rolls the
   * bind back.
   */
  async bindAgentIfUnassigned(
    shipmentId: string,
    agentId: string,
    offerableStatuses: ShipmentStatus[],
    session?: ClientSession
  ): Promise<IShipment | null> {
    const now = new Date();
    return await ShipmentModel.findOneAndUpdate(
      { _id: shipmentId, agent_id: null, status: { $in: offerableStatuses } },
      {
        $set: {
          agent_id: new Types.ObjectId(agentId),
          assignment: {
            state: 'accepted',
            current_offer_id: null,
            offered_agent_id: new Types.ObjectId(agentId),
            updated_at: now,
          },
        },
      },
      { new: true, session: session ?? undefined }
    );
  }

  /**
   * Detach an agent who is CANCELLING their own shipment mid-delivery — a guarded
   * compare-and-set mirroring `claimForReassignment`, but agent-initiated.
   *
   * Matches ONLY when the shipment still holds exactly the agent and status the
   * caller read, so a concurrent accept/pickup/collect/reassign makes it miss and
   * return null (the caller then reports a conflict rather than double-detaching).
   * On a match it clears `agent_id`, resets the status to the offerable target
   * (`assigned` pre-pickup, `handing_over` post-pickup), records the cancellation
   * (reason + note), and appends an `agent`-role history entry. The auto-assign
   * broadcast is then resumed from its stored cursor by the caller.
   */
  async claimForAgentCancel(
    shipmentId: string,
    agentId: string,
    prevStatus: ShipmentStatus,
    targetStatus: ShipmentStatus,
    cancellation: IShipmentAgentCancellation,
    handover: IShipmentHandover | null,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const now = new Date();
    return await ShipmentModel.findOneAndUpdate(
      { _id: shipmentId, agent_id: agentId, status: prevStatus },
      {
        $set: {
          agent_id: null,
          status: targetStatus,
          assignment: { state: 'unassigned', current_offer_id: null, offered_agent_id: null, updated_at: now },
          handover,
          agent_cancellation: cancellation,
        },
        $push: {
          status_history: {
            status: targetStatus,
            changed_at: now,
            changed_by_user_id: null,
            changed_by_role: 'agent',
          },
        },
      },
      { new: true, session: session ?? undefined }
    );
  }

  /**
   * Mark a shipment as having a live offer out to an agent (workflow mirror
   * only — `agent_id` stays null until they accept).
   */
  async markOffered(
    shipmentId: string,
    offerId: string,
    agentId: string,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          assignment: {
            state: 'offered',
            current_offer_id: new Types.ObjectId(offerId),
            offered_agent_id: new Types.ObjectId(agentId),
            updated_at: new Date(),
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Return a shipment to the agency queue (no live offer, no agent) — used when
   * an offer is rejected/expired/cancelled and there is no next candidate.
   */
  async markUnassigned(shipmentId: string, session?: ClientSession): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      {
        $set: {
          assignment: {
            state: 'unassigned',
            current_offer_id: null,
            offered_agent_id: null,
            updated_at: new Date(),
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Detach the current agent for an agent → agent reassignment — a guarded
   * compare-and-set that is the race guard for the whole reassignment flow.
   *
   * The update matches ONLY when the shipment still has exactly the agent and
   * status the caller read (`agent_id: prevAgentId, status: prevStatus`), so any
   * concurrent transition (a second reassign, an accept, a pickup, a COD collect
   * that moved it on) makes this miss and return null — the caller then reports a
   * conflict rather than double-detaching. On a match it clears `agent_id`, sets
   * `status` to the reassignment target (`assigned` pre-pickup, `handing_over`
   * post-pickup), resets the `assignment` mirror to `unassigned`, and appends a
   * `status_history` entry so the timeline records the reassignment moment.
   */
  async claimForReassignment(
    shipmentId: string,
    agencyId: string,
    prevAgentId: string,
    prevStatus: ShipmentStatus,
    targetStatus: ShipmentStatus,
    actorUserId: string | null,
    handover: IShipmentHandover | null,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    return await ShipmentModel.findOneAndUpdate(
      { _id: shipmentId, agency_id: agencyId, agent_id: prevAgentId, status: prevStatus },
      {
        $set: {
          agent_id: null,
          status: targetStatus,
          assignment: {
            state: 'unassigned',
            current_offer_id: null,
            offered_agent_id: null,
            updated_at: now,
          },
          // The reassignment-handover collection point (null on a pre-pickup
          // reassignment, where the parcel never left the agency).
          handover,
        },
        $push: {
          status_history: {
            status: targetStatus,
            changed_at: now,
            changed_by_user_id: actorUserId ? new Types.ObjectId(actorUserId) : null,
            changed_by_role: 'agency',
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }

  /**
   * Shipments an agent marked delivered that the customer never confirmed, past
   * the dispute window — the auto-confirm sweep's candidate set.
   *
   * The window is measured from `updated_at` rather than from the moment the
   * status became `agent_delivered`, which the shipment does not record as a
   * field. That errs the right way: any later write (a tracking number, say) can
   * only push `updated_at` forward, so the window can only ever be LONGER than
   * intended, never shorter. A customer is never given less time to dispute than
   * the configured window. Same convention as the order-level sweep.
   */
  async findStaleAgentDelivered(cutoff: Date, limit: number): Promise<IShipment[]> {
    return await ShipmentModel.find({
      status: 'agent_delivered',
      updated_at: { $lte: cutoff },
    }).limit(limit);
  }

  /**
   * Confirm this shipment's delivery: `agent_delivered` → `delivered`.
   *
   * Guarded on the current status rather than trusting the caller's read: the
   * confirmation window sweep and a customer clicking confirm can land at the
   * same instant, and this must produce one confirmation. Returns null when the
   * shipment was no longer `agent_delivered` — treat that as "someone else got
   * there first", not as an error.
   *
   * `confirmedByUserId` is null for an auto-confirmation; nobody clicked.
   */
  async applyCustomerConfirmation(
    shipmentId: string,
    confirmedByUserId: string | null,
    auto = false,
    session?: ClientSession
  ): Promise<IShipment | null> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    const actorId = confirmedByUserId ? new Types.ObjectId(confirmedByUserId) : null;
    return await ShipmentModel.findOneAndUpdate(
      { _id: shipmentId, status: 'agent_delivered' },
      {
        $set: {
          status: 'delivered',
          customer_confirmation: { confirmed_at: now, confirmed_by: actorId, auto },
        },
        $push: {
          status_history: {
            status: 'delivered',
            changed_at: now,
            changed_by_user_id: actorId,
            changed_by_role: auto ? 'system' : 'customer',
          },
        },
      },
      { new: true, ...sessionOpt }
    );
  }
}
