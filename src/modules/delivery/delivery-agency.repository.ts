import { ClientSession, PipelineStage, Types } from 'mongoose';
import { DeliveryAgencyModel, IDeliveryAgency } from './delivery-agency.model';
import { AgencyOnboardingStepValue } from '../../core/constants/onboarding-steps';
import { COLLECTIONS } from '../../core/database/collections';

/**
 * An agency row joined to its Magazin's business name + logo. The public business
 * name/logo live on the Magazin (see `src/modules/magazin/`), not on the agency,
 * so list/browse queries `$lookup` it and expose it as this lean sub-field.
 */
export type AgencyWithMagazin = IDeliveryAgency & {
  magazin?: { name?: string; logo_file_id?: Types.ObjectId | null } | null;
};

// ─── Query Params Types ───────────────────────────────────────────────────────

export interface AgencyListQueryParams {
  /** Free-text search across agency_name, coverage_areas, and headquarters_addresses.city / region / address_description */
  search?: string;
  /** Filter by coverage area region key (e.g. 'littoral') */
  region?: string;
  /** Filter by headquarters city (case-insensitive) */
  hq_city?: string;
  /** If true, only return agencies with storage_based pricing enabled */
  storage_based?: boolean;
  /** If true, only return agencies with pickup_based pricing enabled */
  pickup_based?: boolean;
  /** Filter by who bears return shipping cost: 'vendor' | 'agency' | 'customer' */
  returns_payer?: 'vendor' | 'agency' | 'customer';
  /** Only return agencies whose damage claim deadline is at least this many days */
  min_claim_deadline_days?: number;
  /** Pagination */
  page: number;
  limit: number;
}


export class DeliveryAgencyRepository {
  async create(data: Partial<IDeliveryAgency>, session?: ClientSession): Promise<IDeliveryAgency> {
    const [doc] = await DeliveryAgencyModel.create([data], session ? { session } : {});
    return doc;
  }

  async findByUserId(userId: string, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findOne({ user_id: userId });
    if (session) query.session(session);
    return query.exec();
  }

  async findById(agencyId: string, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findById(agencyId);
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * Batch-fetch agencies by id in ONE query (e.g. resolving every distinct
   * agency's policy for a multi-shipment order without an N+1 query per
   * shipment). Agencies not found are simply absent from the result.
   */
  async findByIds(agencyIds: string[]): Promise<IDeliveryAgency[]> {
    return DeliveryAgencyModel.find({ _id: { $in: agencyIds } });
  }

  /**
   * Toggle the agency's auto-assignment participation. Returns the updated
   * agency, or null when no such agency exists.
   */
  async setAutoAssignEnabled(agencyId: string, enabled: boolean): Promise<IDeliveryAgency | null> {
    return DeliveryAgencyModel.findByIdAndUpdate(
      agencyId,
      { $set: { 'assignment_settings.auto_assign_enabled': enabled } },
      { new: true }
    ).exec();
  }

  /**
   * Check if an agency document exists for the given user_id.
   * Used for idempotency check on creation.
   */
  async existsByUserId(userId: string, session?: ClientSession): Promise<boolean> {
    const query = DeliveryAgencyModel.exists({ user_id: userId });
    if (session) query.session(session);
    const result = await query.exec();
    return result !== null;
  }

  /**
   * Atomic onboarding update — single findOneAndUpdate that applies data + step + version
   * in one atomic operation. Uses optimistic concurrency via integer version check.
   *
   * @param agencyId - Agency document _id
   * @param updates - Fields to update (data + onboarding_step)
   * @param expectedVersion - The version integer the client last read (for optimistic concurrency)
   * @param session - Optional MongoDB session for transaction support
   * @returns Updated document, or null if concurrency conflict (version mismatch)
   */
  async atomicOnboardingUpdate(
    agencyId: string,
    updates: Partial<IDeliveryAgency> & { onboarding_step: AgencyOnboardingStepValue },
    expectedVersion?: number,
    session?: ClientSession,
  ): Promise<IDeliveryAgency | null> {
    const filter: Record<string, unknown> = { _id: agencyId };
    
    if (expectedVersion !== undefined) {
      if (expectedVersion === 0) {
        // Handle legacy documents where the version field does not exist yet
        filter.$or = [
          { version: 0 },
          { version: { $exists: false } },
          { version: null }
        ];
      } else {
        filter.version = expectedVersion;
      }
    }

    const query = DeliveryAgencyModel.findOneAndUpdate(
      filter,
      { $set: updates, $inc: { version: 1 } },
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  async markEmailVerified(userId: string, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findOneAndUpdate(
      { user_id: userId },
      { email_verified: true },
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  async updateWaVerified(userId: string, waData: { wa_phone_id: string; name?: string }, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findOneAndUpdate(
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
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  async updateStatus(userId: string, status: string, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findOneAndUpdate({ user_id: userId }, { status }, { new: true });
    if (session) query.session(session);
    return query.exec();
  }

  /** Admin action: update an agency's status by its own _id (not the underlying user_id). */
  async updateStatusById(agencyId: string, status: string, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findByIdAndUpdate(agencyId, { status }, { new: true });
    if (session) query.session(session);
    return query.exec();
  }

  async updateProfile(agencyId: string, updates: Partial<IDeliveryAgency>, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findByIdAndUpdate(agencyId, { $set: updates, $inc: { version: 1 } }, { new: true });
    if (session) query.session(session);
    return query.exec();
  }

  async updateOnboardingStep(agencyId: string, step: number, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findByIdAndUpdate(
      agencyId,
      { onboarding_step: step },
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  /** Admin-only: flip legit_verified in both locations for backward compatibility. */
  async setLegitVerified(agencyId: string, verified: boolean, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findByIdAndUpdate(
      agencyId,
      {
        $set: {
          legit_verified: verified,
          'kyc_details.legit_verified': verified,
        },
      },
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * Bump the policy-change counter. Called by AgencyProfileService whenever
   * `policies` is written with a different value, so the agency-connections
   * module can detect the change and pause connections that need reapproval.
   */
  async incrementPolicyVersion(agencyId: string, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findByIdAndUpdate(
      agencyId,
      { $inc: { policy_version: 1 } },
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  async unlinkWhatsApp(userId: string, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findOneAndUpdate(
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
      { new: true },
    );
    if (session) query.session(session);
    return query.exec();
  }

  // ─── Vendor-Facing Query ──────────────────────────────────────────────────────

  /**
   * Find delivery agencies available for vendor selection.
   *
   * Hard filters (always applied):
   *   - status ≠ 'inactive'
   *   - onboarding_step = 0 (fully completed)
   *
   * Optional filters:
   *   - search: regex match on agency_name, coverage_areas[], headquarters_addresses[].city,
   *             headquarters_addresses[].region, headquarters_addresses[].address_description
   *   - region: exact match on coverage_areas[] values
   *   - hq_city: case-insensitive match on headquarters_addresses[0].city
   *   - storage_based: policies.pricing.storage_based.enabled === true
   *   - pickup_based:  policies.pricing.pickup_based.enabled === true
   *   - returns_payer: policies.returns.payer === value
   *   - min_claim_deadline_days: policies.damage.claim_deadline_days >= value
   *
   * Returns a field-projected, lean result (no payout details, no KYC numbers).
   */
  async findAvailableForVendors(
    params: AgencyListQueryParams,
  ): Promise<{ agencies: AgencyWithMagazin[]; total: number }> {
    const { search, region, hq_city, storage_based, pickup_based, returns_payer, min_claim_deadline_days, page, limit } = params;

    // Non-name filters run on the agency document itself.
    const baseMatch: Record<string, unknown> = {
      status: { $ne: 'inactive' },
      onboarding_step: 0,
    };
    if (region && region.trim()) baseMatch.coverage_areas = new RegExp(region.trim(), 'i');
    if (hq_city && hq_city.trim()) baseMatch['headquarters_addresses.0.city'] = new RegExp(hq_city.trim(), 'i');
    if (storage_based === true) baseMatch['policies.pricing.storage_based.enabled'] = true;
    if (pickup_based === true) baseMatch['policies.pricing.pickup_based.enabled'] = true;
    if (returns_payer) baseMatch['policies.returns.payer'] = returns_payer;
    if (min_claim_deadline_days !== undefined && min_claim_deadline_days >= 0) {
      baseMatch['policies.damage.claim_deadline_days'] = { $gte: min_claim_deadline_days };
    }

    // The business name/logo live on the Magazin, so join it — the free-text search
    // and the name sort operate on `magazin.name`.
    const pipeline: PipelineStage[] = [
      { $match: baseMatch },
      { $lookup: { from: COLLECTIONS.AGENCY_MAGAZIN, localField: '_id', foreignField: 'agency_id', as: 'magazin' } },
      { $addFields: { magazin: { $arrayElemAt: ['$magazin', 0] } } },
    ];

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      pipeline.push({
        $match: {
          $or: [
            { 'magazin.name': searchRegex },
            { coverage_areas: searchRegex },
            { 'headquarters_addresses.city': searchRegex },
            { 'headquarters_addresses.region': searchRegex },
            { 'headquarters_addresses.address_description': searchRegex },
          ],
        },
      });
    }

    // Field-projected result (no payout details, no KYC numbers) + the magazin name/logo.
    pipeline.push({
      $facet: {
        data: [
          { $sort: { 'magazin.name': 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              'kyc_details.legit_verified': 1,
              headquarters_addresses: 1,
              coverage_areas: 1,
              policies: 1,
              status: 1,
              'magazin.name': 1,
              'magazin.logo_file_id': 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    });

    const [result] = await DeliveryAgencyModel.aggregate(pipeline).exec();
    const agencies = (result?.data ?? []) as AgencyWithMagazin[];
    const total = result?.total?.[0]?.count ?? 0;
    return { agencies, total };
  }

  // ─── Admin-Facing Query ────────────────────────────────────────────────────────

  /**
   * List all agencies for admin management — unlike findAvailableForVendors, applies
   * no hard filters (inactive and incomplete-onboarding agencies are included).
   */
  async findAllForAdmin(
    params: { status?: 'active' | 'pending_verification' | 'inactive'; page: number; limit: number },
    session?: ClientSession,
  ): Promise<{ agencies: AgencyWithMagazin[]; total: number }> {
    const { status, page, limit } = params;
    const match: Record<string, unknown> = {};
    if (status) match.status = status;

    // Business name/logo live on the Magazin — join it, and sort by its name.
    const pipeline: PipelineStage[] = [
      { $match: match },
      { $lookup: { from: COLLECTIONS.AGENCY_MAGAZIN, localField: '_id', foreignField: 'agency_id', as: 'magazin' } },
      { $addFields: { magazin: { $arrayElemAt: ['$magazin', 0] } } },
      {
        $facet: {
          data: [
            { $sort: { 'magazin.name': 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                status: 1,
                onboarding_step: 1,
                user_id: 1,
                created_at: 1,
                updated_at: 1,
                'magazin.name': 1,
                'magazin.logo_file_id': 1,
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const aggregate = DeliveryAgencyModel.aggregate(pipeline);
    if (session) aggregate.session(session);
    const [result] = await aggregate.exec();
    const agencies = (result?.data ?? []) as AgencyWithMagazin[];
    const total = result?.total?.[0]?.count ?? 0;
    return { agencies, total };
  }
}
