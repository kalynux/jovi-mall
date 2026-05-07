import { ClientSession, FilterQuery } from 'mongoose';
import { DeliveryAgencyModel, IDeliveryAgency } from './delivery-agency.model';
import { AgencyOnboardingStepValue } from '../../core/constants/onboarding-steps';

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
   * Atomic onboarding update — single findOneAndUpdate that applies data + step + updated_at
   * in one atomic operation. Uses optimistic concurrency via updated_at check.
   *
   * @param agencyId - Agency document _id
   * @param updates - Fields to update (data + onboarding_step)
   * @param expectedUpdatedAt - The updated_at timestamp the client last read (for optimistic concurrency)
   * @param session - Optional MongoDB session for transaction support
   * @returns Updated document, or null if concurrency conflict (updated_at mismatch)
   */
  async atomicOnboardingUpdate(
    agencyId: string,
    updates: Partial<IDeliveryAgency> & { onboarding_step: AgencyOnboardingStepValue },
    expectedUpdatedAt?: Date,
    session?: ClientSession,
  ): Promise<IDeliveryAgency | null> {
    const filter: Record<string, unknown> = { _id: agencyId };
    if (expectedUpdatedAt) {
      filter.updated_at = expectedUpdatedAt;
    }

    const query = DeliveryAgencyModel.findOneAndUpdate(
      filter,
      { $set: updates },
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

  async updateProfile(agencyId: string, updates: Partial<IDeliveryAgency>, session?: ClientSession): Promise<IDeliveryAgency | null> {
    const query = DeliveryAgencyModel.findByIdAndUpdate(agencyId, updates, { new: true });
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
  ): Promise<{ agencies: IDeliveryAgency[]; total: number }> {
    const { search, region, hq_city, storage_based, pickup_based, returns_payer, min_claim_deadline_days, page, limit } = params;

    const filter: FilterQuery<IDeliveryAgency> = {
      status: { $ne: 'inactive' },
      onboarding_step: 0,
    };

    // ── Free-text search ──────────────────────────────────────────────────────
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      filter.$or = [
        { agency_name: searchRegex },
        { coverage_areas: searchRegex },
        { 'headquarters_addresses.city': searchRegex },
        { 'headquarters_addresses.region': searchRegex },
        { 'headquarters_addresses.address_description': searchRegex },
      ];
    }

    // ── Region filter ─────────────────────────────────────────────────────────
    if (region && region.trim()) {
      filter.coverage_areas = new RegExp(region.trim(), 'i');
    }

    // ── Headquarters city filter ──────────────────────────────────────────────
    if (hq_city && hq_city.trim()) {
      filter['headquarters_addresses.0.city'] = new RegExp(hq_city.trim(), 'i');
    }

    // ── Policy filters ────────────────────────────────────────────────────────
    if (storage_based === true) {
      filter['policies.pricing.storage_based.enabled'] = true;
    }

    if (pickup_based === true) {
      filter['policies.pricing.pickup_based.enabled'] = true;
    }

    if (returns_payer) {
      filter['policies.returns.payer'] = returns_payer;
    }

    if (min_claim_deadline_days !== undefined && min_claim_deadline_days >= 0) {
      filter['policies.damage.claim_deadline_days'] = { $gte: min_claim_deadline_days };
    }

    // ── Execute ───────────────────────────────────────────────────────────────
    const [agencies, total] = await Promise.all([
      DeliveryAgencyModel.find(filter)
        .select(
          'agency_name logo_url kyc_details.legit_verified headquarters_addresses coverage_areas policies status',
        )
        .sort({ agency_name: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      DeliveryAgencyModel.countDocuments(filter).exec(),
    ]);

    return { agencies: agencies as unknown as IDeliveryAgency[], total };
  }
}
