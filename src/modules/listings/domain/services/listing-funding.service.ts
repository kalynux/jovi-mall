import { ClientSession } from 'mongoose';
import { logger } from '../../../../core/logging';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { LISTING_REVEAL_FIRST_COST } from '../../../billing/config/credit.config';
import { isProviderVendor } from '../../../vendors/domain/vendor-kind';
import { listingRepository, ListingRepository } from '../../repositories/listing.repository';
import { listingSettingsRepository, ListingSettingsRepository } from '../../repositories/listing-settings.repository';
import { LISTING_EVENTS } from '../listing.types';
import { publishListingEvent } from './listing-events';
import { listingVectorisationService, ListingVectorisationService } from './listing-vectorisation.service';

/**
 * Funding (SERVICE-LISTINGS-PLAN L-10, § C-8a) — a provider whose credit balance is below the
 * first-reveal cost has every LIVE listing suspended `insufficient_credits`, and gets each one
 * back, to its exact `previous_status`, when the balance recovers.
 *
 * ⛔ **It touches no other suspension reason.** `platform_oversight` is lifted only by an
 * administrator and `plan_quota_exceeded` only by the plan-quota sweep; a top-up must never
 * resurrect a listing an administrator took down.
 *
 * Three entry points:
 *   reconcileVendor(vendorId)            — read the balance, move listings either way. Called by
 *                                          the `billing.wallet.credited` subscriber, after a
 *                                          provider's own debits here, and by the sweep.
 *   suspendForInsufficientCredits(v, s)  — inside the CALLER's transaction (the wave-2 reveal,
 *                                          whose own debit is what crossed the line). The caller
 *                                          runs `afterSuspended` once it has committed.
 *   reconcileAllProviderFunding()        — the durability backstop: the event is a nudge, the
 *                                          sweep is what makes the outcome certain (§ C-5).
 *
 * Post-commit effects (events, the AI index) never run inside a session.
 */
export interface FundingOutcome {
  vendorId: string;
  balance: number;
  resumed: Array<{ id: string; status: string }>;
  suspended: Array<{ id: string; vectorisedDataId: string | null }>;
}

type Wallet = Pick<typeof creditWalletService, 'getBalance'>;

export class ListingFundingService {
  constructor(
    private readonly repo: ListingRepository = listingRepository,
    private readonly wallet: Wallet = creditWalletService,
    private readonly vectorisation: Pick<ListingVectorisationService, 'index' | 'deindex'> = listingVectorisationService,
    private readonly vendors: Pick<ListingSettingsRepository, 'kindOf'> = listingSettingsRepository,
    private readonly firstRevealCost: number = LISTING_REVEAL_FIRST_COST,
  ) {}

  /** The `suspension` block a funding suspension writes — platform-stamped, `previous_status: 'live'`. */
  static insufficientCreditsSuspension(at: Date = new Date()): Record<string, unknown> {
    return {
      reason: 'insufficient_credits',
      previous_status: 'live',
      at,
      note: null,
      by_user_id: null,
      by_source: 'platform',
      by_name: null,
    };
  }

  /**
   * Bring one provider's listings in line with their balance. With a `session`, the writes join
   * it and the caller must run `afterReconcile` after its commit; without one, this does both.
   */
  async reconcileVendor(vendorId: string, session?: ClientSession): Promise<FundingOutcome> {
    const balance = await this.wallet.getBalance('vendor', vendorId);
    const outcome: FundingOutcome = { vendorId, balance, resumed: [], suspended: [] };

    if (balance >= this.firstRevealCost) {
      const held = await this.repo.findForFunding(
        vendorId,
        { status: 'suspended', 'suspension.reason': 'insufficient_credits' },
        session,
      );
      for (const row of held) {
        const back = row.suspension?.previous_status ?? 'live';
        const moved = await this.repo.casUpdate(
          { _id: row._id, status: 'suspended', 'suspension.reason': 'insufficient_credits' },
          { $set: { status: back, suspension: null } },
          session,
        );
        if (moved) outcome.resumed.push({ id: row._id.toString(), status: moved.status });
      }
    } else {
      outcome.suspended = await this.suspendForInsufficientCredits(vendorId, session);
    }

    if (!session) this.afterReconcile(outcome);
    return outcome;
  }

  /** Suspend every LIVE listing of a provider for lack of credits. Joins the caller's session. */
  async suspendForInsufficientCredits(
    vendorId: string,
    session?: ClientSession,
  ): Promise<Array<{ id: string; vectorisedDataId: string | null }>> {
    const live = await this.repo.findForFunding(vendorId, { status: 'live' }, session);
    const out: Array<{ id: string; vectorisedDataId: string | null }> = [];
    const at = new Date();
    for (const row of live) {
      const moved = await this.repo.casUpdate(
        { _id: row._id, status: 'live' },
        { $set: { status: 'suspended', suspension: ListingFundingService.insufficientCreditsSuspension(at) } },
        session,
      );
      if (moved) out.push({ id: row._id.toString(), vectorisedDataId: row.vectorised_data_id ?? null });
    }
    return out;
  }

  /** Post-commit half of `suspendForInsufficientCredits`: events + out of the AI index. */
  afterSuspended(vendorId: string, suspended: Array<{ id: string; vectorisedDataId: string | null }>): void {
    for (const s of suspended) {
      publishListingEvent(LISTING_EVENTS.SUSPENDED, s.id, vendorId, { reason: 'insufficient_credits' });
      void this.vectorisation.deindex(s.id, s.vectorisedDataId);
    }
  }

  /** Post-commit half of `reconcileVendor`. */
  afterReconcile(outcome: FundingOutcome): void {
    this.afterSuspended(outcome.vendorId, outcome.suspended);
    for (const r of outcome.resumed) {
      publishListingEvent(LISTING_EVENTS.RESUMED, r.id, outcome.vendorId);
      // Free re-index: the provider did not ask for the removal (see the vectorisation header).
      if (r.status === 'live') void this.vectorisation.index(r.id, { billed: false });
    }
  }

  /** Reconcile only when the vendor is a provider — the subscriber's and the sweep's guard. */
  async reconcileIfProvider(vendorId: string): Promise<FundingOutcome | null> {
    const vendor = await this.vendors.kindOf(vendorId);
    if (!vendor || !isProviderVendor(vendor)) return null;
    return this.reconcileVendor(vendorId);
  }

  /**
   * The durability backstop: every provider with a live or credit-suspended listing, recomputed.
   * Idempotent — a provider already in line moves nothing. One failure never stops the sweep.
   */
  async reconcileAllProviderFunding(): Promise<{ vendors: number; resumed: number; suspended: number; errors: number }> {
    const ids = await this.repo.vendorIdsForFundingSweep();
    const totals = { vendors: 0, resumed: 0, suspended: 0, errors: 0 };
    for (const vendorId of ids) {
      try {
        const outcome = await this.reconcileIfProvider(vendorId);
        if (!outcome) continue;
        totals.vendors++;
        totals.resumed += outcome.resumed.length;
        totals.suspended += outcome.suspended.length;
      } catch (err) {
        totals.errors++;
        logger().error({ vendorId, err }, 'listing funding sweep: vendor failed');
      }
    }
    if (totals.resumed || totals.suspended || totals.errors) {
      logger().info(totals, 'listing funding sweep: done');
    }
    return totals;
  }
}

export const listingFundingService = new ListingFundingService();
