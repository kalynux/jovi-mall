import { ClientSession, PipelineStage } from 'mongoose';
import {
  DeliveryAgentModel,
  IDeliveryAgent,
  IAgentAvailability,
  IAgentDeviceCapabilities,
  IAgentLastKnownTrackingState,
  AgentStatus,
  AgentAvailabilityState,
  AgentWorkingState,
} from '../models/agent.model';
import { IGeoPoint } from '../../../core/types/geo.types';
import { AgentOnboardingStep } from '../../../core/constants/onboarding-steps';
import { normalizeEmailAddress } from '../../../core/validation/email';

/** Mean Earth radius in km — converts a radius to radians for $centerSphere. */
const EARTH_RADIUS_KM = 6378.1;

export interface AgentDirectoryQueryParams {
  search?: string;
  vehicle_type?: 'bike' | 'car' | 'van' | 'truck';
  availability?: AgentAvailabilityState;
  min_trust_score?: number;
  /** All three required together, or none — validated in the Zod schema. */
  lng?: number;
  lat?: number;
  radius_km?: number;
  sort: 'trust' | 'name';
  page: number;
  limit: number;
}

/**
 * AgentRepository — persistence for the agent aggregate.
 *
 * Deliberately NOT extending BaseRepository: that base auto-filters
 * `deletedAt: null` and exposes softDelete/restore/hardDelete. An agent is
 * never deleted — they are deactivated via `status`, which keeps their COD
 * ledger, shipment history and membership trail attributable. Adding a
 * soft-delete here would silently hide agents from cash reconciliation.
 */
export class AgentRepository {
  async create(data: Partial<IDeliveryAgent>, session?: ClientSession): Promise<IDeliveryAgent> {
    const [agent] = await DeliveryAgentModel.create([data], session ? { session } : {});
    return agent;
  }

  async findById(agentId: string, session?: ClientSession): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findById(agentId).session(session ?? null);
  }

  async findByUserId(userId: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOne({ user_id: userId });
  }

  /** `email` is stored normalised (trimmed + lowercased), so the key is too. */
  async findByEmail(email: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOne({ email: normalizeEmailAddress(email) });
  }

  async findManyByIds(agentIds: string[]): Promise<IDeliveryAgent[]> {
    if (agentIds.length === 0) return [];
    return await DeliveryAgentModel.find({ _id: { $in: agentIds } });
  }

  // ─── Directory (agency-facing discovery) ──────────────────────────────────

  /**
   * Agents an agency may browse and send a contract request to.
   *
   * The four hard filters are exactly `AgentGateService.assertCanHoldContract`
   * plus completed onboarding — the gate every request must clear anyway.
   * Listing an agent who fails it would render a Request button whose request
   * is refused, so the directory refuses to show them instead.
   *
   * Note what is NOT filtered: a contract with a rival agency. Agents are
   * multi-agency by design (AGENT_CONFIG.MAX_AGENCY_RELATIONSHIPS), so serving
   * someone else is not a reason to be invisible. Nor is an existing contract
   * with the CALLER — the caller's own standing is annotated onto each row by
   * AgentDirectoryService rather than filtered out, so the UI can show
   * "Connected" instead of silently dropping the agent from the list.
   *
   * Returns a field-projected, lean result — see AgentDirectoryMapper's
   * SECURITY note for what the projection deliberately omits.
   */
  async findAvailableForAgencies(
    params: AgentDirectoryQueryParams
  ): Promise<{ agents: IDeliveryAgent[]; total: number }> {
    const { search, vehicle_type, availability, min_trust_score, lng, lat, radius_km, sort, page, limit } =
      params;

    const match: Record<string, unknown> = {
      status: 'active',
      onboarding_step: AgentOnboardingStep.COMPLETED,
      'kyc.status': 'verified',
      'platform_ban.banned': { $ne: true },
    };

    if (vehicle_type) match['vehicle_info.vehicle_type'] = vehicle_type;
    if (availability) match['availability.state'] = availability;
    if (min_trust_score !== undefined) match['cod.trust_score'] = { $gte: min_trust_score };

    // Radius search on the agent's declared home base. $geoWithin rather than
    // $geoNear so it composes inside this $match — $geoNear must be the first
    // stage of the pipeline and would force distance ordering, overriding the
    // caller's sort.
    if (lng !== undefined && lat !== undefined && radius_km !== undefined) {
      match['home_base.location'] = {
        $geoWithin: { $centerSphere: [[lng, lat], radius_km / EARTH_RADIUS_KM] },
      };
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      match.$or = [{ name: searchRegex }, { 'home_base.label': searchRegex }];
    }

    // Trust-first by default: for a directory of couriers, "who is most
    // reliable" is the useful ordering, where the vendor/agency browses sort by
    // business name. `name` is the secondary key either way so paging is stable
    // across equal scores.
    const sortStage: Record<string, 1 | -1> =
      sort === 'name' ? { name: 1 } : { 'cod.trust_score': -1, name: 1 };

    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $facet: {
          data: [
            { $sort: sortStage },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                name: 1,
                avatar_file_id: 1,
                'vehicle_info.vehicle_type': 1,
                home_base: 1,
                'cod.trust_score': 1,
                'kyc.status': 1,
                'availability.state': 1,
                'working_state.state': 1,
                trust_signals: 1,
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await DeliveryAgentModel.aggregate(pipeline).exec();
    return {
      agents: (result?.data ?? []) as IDeliveryAgent[],
      total: result?.total?.[0]?.count ?? 0,
    };
  }

  async updateProfile(
    agentId: string,
    updates: Partial<IDeliveryAgent>,
    session?: ClientSession
  ): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, updates, { new: true, session });
  }

  async updateOnboardingStep(agentId: string, step: number): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { onboarding_step: step }, { new: true });
  }

  // ─── Status (account lifecycle) ───────────────────────────────────────────

  async setStatus(agentId: string, status: AgentStatus, reason: string | null): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      { $set: { status, status_reason: reason } },
      { new: true }
    );
  }

  /** Legacy path: auth/whatsapp flows key off user_id rather than agent id. */
  async updateStatusByUserId(userId: string, status: AgentStatus): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate({ user_id: userId }, { status }, { new: true });
  }

  // ─── Availability (agent-declared intent) ─────────────────────────────────

  async setAvailability(agentId: string, availability: IAgentAvailability): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { $set: { availability } }, { new: true });
  }

  // ─── Working state (system-derived load) ──────────────────────────────────

  async setWorkingState(
    agentId: string,
    state: AgentWorkingState,
    activeShipmentCount: number,
    session?: ClientSession
  ): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      {
        $set: {
          'working_state.state': state,
          'working_state.active_shipment_count': activeShipmentCount,
          'working_state.computed_at': new Date(),
        },
      },
      { new: true, session }
    );
  }

  // ─── COD threshold (the agent's global pool) ──────────────────────────────

  async setCodMaxThreshold(
    agentId: string,
    maxThreshold: number,
    session?: ClientSession
  ): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      { $set: { 'cod.max_threshold': maxThreshold } },
      { new: true, session }
    );
  }

  // ─── Capacity (atomic reserve/release) ────────────────────────────────────

  /**
   * Atomically reserve one capacity slot, or fail.
   *
   * The filter and the increment are ONE operation: the document is only
   * matched when it still has room, and the same operation that matches it also
   * takes the slot. Two concurrent assignments against an agent with one slot
   * left cannot both match — Mongo serialises the update on the document, so
   * the loser sees no match and gets null.
   *
   * A read-then-write (`count < max` then `$inc`) would let both read "room
   * available" and both increment, over-committing the agent. That gap is
   * exactly what this method exists to close, which is also why capacity is a
   * stored counter rather than a derived count: you cannot conditionally
   * increment something you compute.
   *
   * Returns null when no slot is available (or the agent is missing) — callers
   * must distinguish that from an error.
   */
  async tryReserveCapacity(agentId: string, session?: ClientSession): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate(
      {
        _id: agentId,
        $expr: { $lt: ['$capacity.active_shipment_count', '$capacity.max_active_shipments'] },
      },
      { $inc: { 'capacity.active_shipment_count': 1 } },
      { new: true, session }
    );
  }

  /**
   * Release one capacity slot. Guarded at zero so a double-release cannot drive
   * the counter negative — which would silently hand the agent free capacity
   * forever.
   */
  async releaseCapacity(agentId: string, session?: ClientSession): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate(
      { _id: agentId, 'capacity.active_shipment_count': { $gt: 0 } },
      { $inc: { 'capacity.active_shipment_count': -1 } },
      { new: true, session }
    );
  }

  async setMaxActiveShipments(agentId: string, max: number): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      { $set: { 'capacity.max_active_shipments': max } },
      { new: true }
    );
  }

  /** Overwrite the counter from an authoritative count — drift correction only. */
  async setActiveShipmentCount(agentId: string, count: number): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      { $set: { 'capacity.active_shipment_count': count, 'capacity.reconciled_at': new Date() } },
      { new: true }
    );
  }

  // ─── Platform gates ───────────────────────────────────────────────────────

  async setKyc(
    agentId: string,
    kyc: Partial<IDeliveryAgent['kyc']>
  ): Promise<IDeliveryAgent | null> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(kyc)) {
      if (value !== undefined) set[`kyc.${key}`] = value;
    }
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { $set: set }, { new: true });
  }

  async setPlatformBan(
    agentId: string,
    ban: Partial<IDeliveryAgent['platform_ban']>
  ): Promise<IDeliveryAgent | null> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(ban)) {
      if (value !== undefined) set[`platform_ban.${key}`] = value;
    }
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { $set: set }, { new: true });
  }

  /**
   * Replace the agent's payout methods wholesale. The list is ordered and the
   * first entry is the preferred one, so a field-by-field merge would be
   * meaningless — reordering IS the edit. Same contract as vendor/agency.
   */
  async setPayoutDetails(
    agentId: string,
    methods: IDeliveryAgent['payout_details']
  ): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      { $set: { payout_details: methods } },
      { new: true }
    );
  }

  async setHomeBase(
    agentId: string,
    homeBase: Partial<IDeliveryAgent['home_base']>
  ): Promise<IDeliveryAgent | null> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(homeBase)) {
      if (value !== undefined) set[`home_base.${key}`] = value;
    }
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { $set: set }, { new: true });
  }

  // ─── Trust ────────────────────────────────────────────────────────────────

  async setTrustScore(
    agentId: string,
    score: number,
    signals: Partial<IDeliveryAgent['trust_signals']>
  ): Promise<IDeliveryAgent | null> {
    const set: Record<string, unknown> = {
      'cod.trust_score': score,
      'trust_signals.computed_at': new Date(),
    };
    for (const [key, value] of Object.entries(signals)) {
      if (value !== undefined) set[`trust_signals.${key}`] = value;
    }
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { $set: set }, { new: true });
  }

  /** Every agent the nightly trust recompute should visit. */
  async listAllIds(): Promise<string[]> {
    const rows = await DeliveryAgentModel.find({}, { _id: 1 });
    return rows.map((r) => r._id.toString());
  }

  // ─── Tracking allow (the business flag geo-tracker enforces) ──────────────

  async setTrackingAllowed(
    agentId: string,
    allowed: boolean,
    reason: string | null,
    actor: { userId: string | null; role: string | null }
  ): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findByIdAndUpdate(
      agentId,
      {
        $set: {
          'tracking.allowed': allowed,
          'tracking.reason': reason,
          'tracking.changed_at': new Date(),
          'tracking.changed_by_user_id': actor.userId,
          'tracking.changed_by_role': actor.role,
        },
      },
      { new: true }
    );
  }

  // ─── Device capabilities ──────────────────────────────────────────────────

  async updateDeviceCapabilities(
    agentId: string,
    capabilities: Partial<IAgentDeviceCapabilities>
  ): Promise<IDeliveryAgent | null> {
    const set: Record<string, unknown> = { 'device.reported_at': new Date() };
    for (const [key, value] of Object.entries(capabilities)) {
      if (value !== undefined) set[`device.${key}`] = value;
    }
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { $set: set }, { new: true });
  }

  // ─── Last known tracking state (business mirror; geo-tracker is truth) ────

  async updateLastKnownTrackingState(
    agentId: string,
    state: Partial<IAgentLastKnownTrackingState> & { last_position?: IGeoPoint | null }
  ): Promise<IDeliveryAgent | null> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(state)) {
      if (value !== undefined) set[`last_known_tracking_state.${key}`] = value;
    }
    if (Object.keys(set).length === 0) return await this.findById(agentId);
    return await DeliveryAgentModel.findByIdAndUpdate(agentId, { $set: set }, { new: true });
  }

  // ─── Channel binding (WhatsApp) ───────────────────────────────────────────

  async markEmailVerified(userId: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate({ user_id: userId }, { email_verified: true }, { new: true });
  }

  async updateWaVerified(
    userId: string,
    waData: { wa_phone_id: string; name?: string }
  ): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': true,
          'wa.wa_phone_id': waData.wa_phone_id,
          'wa.bound_at': new Date(),
          'wa.last_seen_at': new Date(),
          ...(waData.name ? { 'wa.name': waData.name } : {}),
        },
      },
      { new: true }
    );
  }

  async unlinkWhatsApp(userId: string): Promise<IDeliveryAgent | null> {
    return await DeliveryAgentModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': false,
          'wa.wa_phone_id': null,
          'wa.name': null,
          'wa.bound_at': null,
          'wa.last_seen_at': null,
        },
      },
      { new: true }
    );
  }
}

export const agentRepository = new AgentRepository();
