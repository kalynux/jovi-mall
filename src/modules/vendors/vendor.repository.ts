import { ClientSession, PipelineStage, Types } from 'mongoose';
import { VendorModel, IVendor, VendorStatus } from './vendor.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';
import { VendorOnboardingStep } from '../../core/constants/onboarding-steps';
import { ActorRef, actorStamp } from '../../core/types/actor-source.types';
import { COLLECTIONS } from '../../core/database/collections';
import { buildSearchRegex } from '../../core/utils/regex.util';
import { activationFilter, ACTIVATION_TARGET } from '../../core/accounts/activation';

/**
 * A vendor row joined to its Store's business name + logo. The public business
 * name/logo live on the Store (see `src/modules/store/`), not on the vendor, so
 * list/browse queries `$lookup` it and expose it as this lean sub-field.
 */
export type VendorWithStore = IVendor & {
  store?: { name?: string; logo_file_id?: Types.ObjectId | null } | null;
};

// ─── Query Params Types ───────────────────────────────────────────────────────

export interface VendorListQueryParams {
  /** Free-text search across business_name, display_name, and business_addresses[].city / state / address_line1 */
  search?: string;
  /** Filter by business address city (case-insensitive) */
  city?: string;
  /** Filter by business address state/region (case-insensitive) */
  state?: string;
  /** If true, only return vendors whose return policy accepts returns */
  return_eligible?: boolean;
  /** If true, only return vendors whose cancellation policy allows cancellation */
  cancellable?: boolean;
  /** Pagination */
  page: number;
  limit: number;
}

export class VendorRepository {
  async create(vendorData: Partial<IVendor>): Promise<IVendor> {
    const vendor = new VendorModel(vendorData);
    return await vendor.save();
  }

  async findByUserId(userId: string): Promise<IVendor | null> {
    return await VendorModel.findOne({ user_id: userId });
  }

  async findById(vendorId: string, session?: ClientSession): Promise<IVendor | null> {
    const query = VendorModel.findById(vendorId);
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * Verify the email address. Nothing else.
   *
   * ⚠ **THIS USED TO ACTIVATE THE VENDOR, AND DELIBERATELY NO LONGER DOES** (owner decision,
   * 2026-09-15). Email was this role's route out of `pending_verification` — and it was the
   * only role that had one, which is how vendor, agency and agent ended up with three
   * different answers to the same question. Activation is now one rule for all three, a
   * **proved phone and a name**, and it lives in `core/accounts/activation.ts`.
   *
   * What that costs, stated plainly: a new vendor who verifies their email and stops is
   * `pending_verification` until they also verify their phone. Clicking the link no longer
   * finishes onboarding on its own.
   *
   * ⚠ **No vendor is DEMOTED by this.** Promotion is the only direction anything here moves,
   * so vendors already `active` from an email verification stay active. There is no sweep
   * and no backfill — see the activation module's header for why none is needed.
   */
  async markEmailVerified(userId: string): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { user_id: userId },
      { $set: { email_verified: true } },
      { new: true }
    );
  }

  /**
   * Promote out of `pending_verification` when the fundamentals are proved.
   *
   * The whole rule lives in the filter — see `activationFilter`. A miss returns `null` and
   * is the ordinary case, not an error: most calls land on an account that is already
   * active, or has not proved a phone yet.
   */
  async activateIfFundamentalsMet(userId: string): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { user_id: userId, ...activationFilter('display_name') },
      { $set: { status: ACTIVATION_TARGET } },
      { new: true }
    );
  }

  /**
   * Land a confirmed contact change on the profile — the value AND its verified flag,
   * together (Phase 6 · 6.D.1). See `CustomerRepository.setVerifiedContact` for the full
   * reasoning; the same method exists on all four role repositories.
   *
   * ⚠ **Does not touch `status`, and neither does `markEmailVerified` above any more.**
   * This paragraph used to contrast the two — that one was a `$cond` pipeline promoting a
   * vendor out of `pending_verification`, this one deliberately was not — and the contrast
   * is gone: the activation split of 2026-09-15 moved every promotion to
   * `activateIfFundamentalsMet`, so both methods now write their own field and nothing else.
   *
   * The rule the contrast existed to protect is unchanged and now holds structurally: a
   * `suspended` vendor must not walk their own suspension back by editing their contact
   * details. With one writer of `status` on this path there is no second route to close.
   */
  async setVerifiedContact(
    userId: string,
    contact: { email?: string; phone?: string }
  ): Promise<IVendor | null> {
    const set: Record<string, unknown> = {};
    if (contact.email !== undefined) {
      set.email = contact.email;
      set.email_verified = true;
    }
    if (contact.phone !== undefined) {
      set.phone = contact.phone;
      set.phone_verified = true;
    }
    if (Object.keys(set).length === 0) return await VendorModel.findOne({ user_id: userId });

    return await VendorModel.findOneAndUpdate({ user_id: userId }, { $set: set }, { new: true });
  }

  /**
   * Move the vendor between statuses, but only from the status the caller believes it
   * is in — the vendor half of the compare-and-set every two-actor document on this
   * platform now uses (`UserRepository.applyStatusChangeIfCurrent`,
   * `ShipmentRepository.applyStatusChangeIfCurrent`).
   *
   * Two administrators can hold one vendor's screen open. Without the guard both read
   * `active`, both write `inactive`, and the loser's audit row claims a transition that
   * never happened while their reason silently overwrites the winner's. A miss returns
   * null and the caller raises `VENDOR_STATUS_CONFLICT`.
   *
   * `fields` carries the whole suspension stamp or the whole clearing of it — never a
   * fragment, or a reason outlives the suspension it describes.
   *
   * Session-aware, unlike the user version: this write is the first step of a
   * transaction that also suspends the vendor's products.
   */
  async applyStatusChangeIfCurrent(
    vendorId: string,
    fromStatus: VendorStatus,
    toStatus: VendorStatus,
    fields: Record<string, unknown>,
    session?: ClientSession,
  ): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { _id: vendorId, status: fromStatus },
      { $set: { status: toStatus, ...fields } },
      { new: true, session }
    );
  }

  /**
   * Update vendor profile with optimistic locking.
   * Checks version matches before applying the update and increments atomically.
   */
  async updateProfileWithVersion(
    vendorId: string,
    currentVersion: number,
    updates: Partial<IVendor>
  ): Promise<IVendor | null> {
    return await VendorModel.findOneAndUpdate(
      { _id: vendorId, version: currentVersion },
      { ...updates, $inc: { version: 1 } },
      { new: true }
    );
  }

  /**
   * Update profile without version check.
   * Use only for system-initiated updates (e.g., onboarding step recalculation).
   */
  async updateProfile(vendorId: string, updates: Partial<IVendor>, session?: ClientSession): Promise<IVendor | null> {
    return await VendorModel.findByIdAndUpdate(vendorId, updates, { new: true, session });
  }

  /**
   * Find the ids of every vendor whose default_delivery_agency_id points at the given agency.
   * Used to fan out the suspend/restore cascade when an agency is deactivated/reactivated.
   */
  async findVendorIdsByDefaultAgency(agencyId: string, session?: ClientSession): Promise<string[]> {
    const query = VendorModel.find({ default_delivery_agency_id: agencyId }, { _id: 1 });
    if (session) query.session(session);
    const docs = await query.lean();
    return docs.map(d => d._id.toString());
  }

  /**
   * Atomic onboarding update with optional optimistic concurrency check.
   * When expectedVersion is provided, the update only proceeds if the document's
   * current version matches — returning null on a version mismatch.
   */
  async atomicOnboardingUpdate(
    vendorId: string,
    updates: Partial<IVendor>,
    expectedVersion?: number,
  ): Promise<IVendor | null> {
    const filter: Record<string, unknown> = { _id: vendorId };
    if (expectedVersion !== undefined) {
      filter.version = expectedVersion;
    }
    return await VendorModel.findOneAndUpdate(
      filter,
      { $set: updates, $inc: { version: 1 } },
      { new: true },
    );
  }

  /**
   * Set the onboarding step. Called by the service after field-presence recalculation.
   */
  async updateOnboardingStep(vendorId: string, step: number): Promise<IVendor | null> {
    return await VendorModel.findByIdAndUpdate(
      vendorId,
      { onboarding_step: step, $inc: { version: 1 } },
      { new: true }
    );
  }

  /**
   * Admin-only: record a business-verification verdict, as ONE compare-and-set.
   *
   * Replaces `setLegitVerified`, which wrote a bare boolean to two places — one of them
   * a top-level `legit_verified` whose schema path was commented out, so Mongoose's
   * strict mode silently dropped half of every write. That field is gone; this writes
   * the whole verdict in one `$set` so the boolean, the status, the timestamp, the
   * rejection reason and the reviewer stamp can never disagree.
   *
   * `legit_verified` stays as the boolean projection of `status === 'verified'` because
   * `agency-vendor-browse.dto.ts` renders `kycVerified` from it.
   *
   * ── Why the predicate, added 2026-09-15 ──────────────────────────────────────
   * ⚠ **The "already holds this verdict" rule is not new — its ATOMICITY is.** The rule
   * lived in `AdminVendorService.setKycVerdict` as a read, a comparison and then an
   * unguarded write, which refuses the second administrator only when the two are far
   * enough apart in time. Two reviewers submitting opposite verdicts in the same instant
   * both read the old value, both passed the check, and both wrote — the loser's stamp
   * landing on top of the winner's with no 409 anywhere and an audit row in wi-admin
   * claiming a transition that was immediately overwritten.
   *
   * The predicate is a `$ne` on the verdict being written, so it refuses a REPEAT and
   * admits everything else — a rejected vendor re-verifies, which is the documented
   * re-review loop and the behaviour agencies were given in the same change (BR-026 § 2).
   * `$ne` also matches a vendor with no `kyc_details` at all, so a document predating the
   * sub-document is reviewable.
   *
   * Returning null on a miss lets the service answer 409 — the same shape as
   * `DeliveryAgencyRepository.markVerifiedIfNotVerified`, which is now this method's twin.
   */
  async setKycVerdict(
    vendorId: string,
    verdict: 'verified' | 'rejected',
    actor: ActorRef,
    rejectionReason?: string | null,
    session?: ClientSession,
  ): Promise<IVendor | null> {
    const verified = verdict === 'verified';

    return await VendorModel.findOneAndUpdate(
      { _id: vendorId, 'kyc_details.status': { $ne: verdict } },
      {
        $set: {
          'kyc_details.status': verdict,
          'kyc_details.legit_verified': verified,
          // Cleared on rejection rather than left behind: a `verified_at` beside a
          // `rejected` status describes an approval that has been withdrawn, and the
          // durable record of it is the wi-admin audit row.
          'kyc_details.verified_at': verified ? new Date() : null,
          'kyc_details.rejection_reason': verified ? null : (rejectionReason ?? null),
          ...actorStamp('kyc_details.reviewed_by', actor),
        },
      },
      { new: true, session }
    );
  }

  /**
   * Paginated vendor summaries for an agency's "who set me as default" view
   * (requirement #7). Read-only, field-projected — vendors cannot see or change
   * this from the agency side.
   */
  async findByDefaultAgency(agencyId: string, pagination: PaginationOptions = { page: 1, limit: 20 }): Promise<Page<VendorWithStore>> {
    const { page, limit } = pagination;
    const match = { default_delivery_agency_id: new Types.ObjectId(agencyId) };

    // Business name lives on the Store — join it and sort by its name.
    const pipeline: PipelineStage[] = [
      { $match: match },
      { $lookup: { from: COLLECTIONS.STORE, localField: '_id', foreignField: 'vendor_id', as: 'store' } },
      { $addFields: { store: { $arrayElemAt: ['$store', 0] } } },
      {
        $facet: {
          data: [
            { $sort: { 'store.name': 1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                display_name: 1,
                email: 1,
                phone: 1,
                status: 1,
                business_addresses: 1,
                'store.name': 1,
                'store.logo_file_id': 1,
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await VendorModel.aggregate(pipeline).exec();
    const docs = (result?.data ?? []) as VendorWithStore[];
    const total = result?.total?.[0]?.count ?? 0;
    return { data: docs, meta: { total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Bump the policy-change counter. Called by VendorProfileService whenever
   * `policies` is written with a different value, so the agency-connections
   * module can detect the change and pause connections that need reapproval.
   */
  async incrementPolicyVersion(vendorId: string, session?: ClientSession): Promise<IVendor | null> {
    return await VendorModel.findByIdAndUpdate(
      vendorId,
      { $inc: { policy_version: 1 } },
      { new: true, session }
    );
  }

  // ─── Agency-Facing Query ──────────────────────────────────────────────────

  /**
   * Find vendors available for an agency to search/request a connection with.
   * Symmetric to DeliveryAgencyRepository.findAvailableForVendors.
   *
   * Hard filters (always applied):
   *   - status ≠ 'inactive'
   *   - onboarding_step = 0 (fully completed)
   *
   * Returns a field-projected, lean result (no payout details, no KYC numbers).
   */
  async findAvailableForAgencies(
    params: VendorListQueryParams,
  ): Promise<{ vendors: VendorWithStore[]; total: number }> {
    const { search, city, state, return_eligible, cancellable, page, limit } = params;

    // Non-name filters run on the vendor document itself.
    const baseMatch: Record<string, unknown> = {
      status: { $ne: 'inactive' },
      onboarding_step: VendorOnboardingStep.COMPLETED,
    };
    if (city && city.trim()) baseMatch['business_addresses.city'] = buildSearchRegex(city);
    if (state && state.trim()) baseMatch['business_addresses.state'] = buildSearchRegex(state);
    if (return_eligible === true) baseMatch['policies.return_policy.return_eligible'] = true;
    if (cancellable === true) baseMatch['policies.cancellation_policy.cancellable'] = true;

    // Business name/logo live on the Store — join it; free-text search and the
    // name sort operate on `store.name`.
    const pipeline: PipelineStage[] = [
      { $match: baseMatch },
      { $lookup: { from: COLLECTIONS.STORE, localField: '_id', foreignField: 'vendor_id', as: 'store' } },
      { $addFields: { store: { $arrayElemAt: ['$store', 0] } } },
    ];

    if (search && search.trim()) {
      const searchRegex = buildSearchRegex(search);
      pipeline.push({
        $match: {
          $or: [
            { 'store.name': searchRegex },
            { display_name: searchRegex },
            { 'business_addresses.city': searchRegex },
            { 'business_addresses.state': searchRegex },
            { 'business_addresses.address_line1': searchRegex },
          ],
        },
      });
    }

    pipeline.push({
      $facet: {
        data: [
          { $sort: { 'store.name': 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
          {
            $project: {
              display_name: 1,
              business_addresses: 1,
              'kyc_details.legit_verified': 1,
              policies: 1,
              status: 1,
              'store.name': 1,
              'store.logo_file_id': 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    });

    const [result] = await VendorModel.aggregate(pipeline).exec();
    const vendors = (result?.data ?? []) as VendorWithStore[];
    const total = result?.total?.[0]?.count ?? 0;
    return { vendors, total };
  }
}
