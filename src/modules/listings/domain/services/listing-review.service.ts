import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { actorStamp, ActorRef } from '../../../../core/types/actor-source.types';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { publishWalletCredited } from '../../../billing/domain/wallet-credited.event';
import { LISTING_REVEAL_FIRST_COST } from '../../../billing/config/credit.config';
import { FileRepositoryMongo } from '../../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService } from '../../../catalog/domain/services/media/FileReferenceService';
import { listingRepository, ListingRepository, ListingRow } from '../../repositories/listing.repository';
import { listingContactRepository, ListingContactRepository } from '../../repositories/listing-contact.repository';
import { LISTING_EVENTS, ListingContactField, ListingStatus, ListingSuspensionReason } from '../listing.types';
import { availableFieldsOf, statusAfter } from '../listing-rules';
import { publishListingEvent } from './listing-events';
import { ListingFundingService } from './listing-funding.service';
import { listingVectorisationService, ListingVectorisationService } from './listing-vectorisation.service';
import { LISTING_FILE_ENTITY, LISTING_FILE_FIELD, refundIndexFee, stateViewOf } from './listing-provider.service';
import { photoUnion } from './listing-content.mapper';

/**
 * The administrator's decisions on a listing (SERVICE-LISTINGS-PLAN L-5, O-12, O-13, § C-3
 * "Internal admin", § C-8a) — approve, reject, suspend, unsuspend. Reached only through
 * `/api/internal/admin/listings` behind `requireAdminCaller`; wi-admin holds the permissions,
 * the tiers and the audit, and this service re-checks none of them (the ADR-004 posture).
 *
 * ── Approve is ONE transaction across both collections ───────────────────────
 * `listings.pending → published` and `listing_contacts.pending → published` commit together
 * or not at all: a half-approved listing would sell contacts nobody reviewed, or show content
 * whose contacts are gone. `available_fields` is derived from the newly published contact set
 * as NAMES (`availableFieldsOf`) — the only thing that crosses from the sensitive collection to
 * the public one.
 *
 * ── Approval with an empty wallet (§ C-8a) ───────────────────────────────────
 * A provider whose balance is under the first-reveal cost is published straight into
 * `suspended` / `insufficient_credits`, so they come back at the next top-up like any other.
 */

export interface AdminListingResult {
  id: string;
  status: ListingStatus;
  reviewState: string | null;
  suspension: { reason: ListingSuspensionReason; previousStatus: ListingStatus } | null;
  availableFields: ListingContactField[];
  publishedAt: string | null;
}

export function toAdminListingResult(row: ListingRow): AdminListingResult {
  return {
    id: row._id.toString(),
    status: row.status,
    reviewState: row.review?.state ?? null,
    suspension: row.suspension ? { reason: row.suspension.reason, previousStatus: row.suspension.previous_status } : null,
    availableFields: [...(row.available_fields ?? [])],
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  };
}

const notFound = () => createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');
const conflict = (message: string) => createAppError(ERROR_CODES.LISTING_STATUS_CONFLICT, 409, message);

type Wallet = Pick<typeof creditWalletService, 'getBalance' | 'creditInSession'>;
type Tx = Pick<typeof transactionManager, 'runInTransactionWithRetry'>;

export class ListingReviewService {
  constructor(
    private readonly repo: ListingRepository = listingRepository,
    private readonly contacts: ListingContactRepository = listingContactRepository,
    private readonly wallet: Wallet = creditWalletService,
    private readonly vectorisation: Pick<ListingVectorisationService, 'index' | 'deindex'> = listingVectorisationService,
    private readonly fileRefs: Pick<FileReferenceService, 'reconcile'> = new FileReferenceService(
      new FileRepositoryMongo(),
      new FileReferenceRepositoryMongo(),
    ),
    private readonly tx: Tx = transactionManager,
    private readonly firstRevealCost: number = LISTING_REVEAL_FIRST_COST,
  ) {}

  async approve(listingId: string, actor: ActorRef): Promise<AdminListingResult> {
    const row = await this.repo.findById(listingId);
    if (!row) throw notFound();
    if (row.review?.state !== 'pending_review' || !row.pending) {
      throw conflict('This listing is not waiting for review.');
    }
    const vendorId = row.vendor_id.toString();
    const balance = await this.wallet.getBalance('vendor', vendorId);
    const underfunded = balance < this.firstRevealCost;
    const feeTaken = !!row.review.index_fee_ref;
    const now = new Date();

    const updated = await this.tx.runInTransactionWithRetry(async (session) => {
      const published = await this.contacts.publishPending(listingId, session);
      // NAMES only — never a value (the approve path's one crossing, see the header).
      const available = availableFieldsOf(published);

      const $set: Record<string, unknown> = {
        published: row.pending,
        pending: null,
        review: null,
        available_fields: available,
        last_decision: { decision: 'approved', at: now, ...actorStamp('by', actor), reasons: [] },
        published_at: row.published_at ?? now,
        vectorisation_status: 'not_started',
        vectorisation_job: null,
      };
      // A suspended listing's revision is approved INTO its suspension; anything else goes live,
      // or straight into a funding suspension when the wallet cannot pay a first reveal.
      if (row.status !== 'suspended') {
        if (underfunded) {
          $set.status = 'suspended';
          $set.suspension = ListingFundingService.insufficientCreditsSuspension(now);
        } else {
          $set.status = 'live';
          $set.suspension = null;
        }
      } else if (row.suspension && row.suspension.previous_status !== 'live') {
        // A first submission HELD by a downgrade while in the queue (O-16: `plan_quota_exceeded`,
        // previous_status 'pending_review'). It stays held — approval buys no plan slot — but it
        // is now an approved listing, so the quota restore must bring it back LIVE, not into a
        // review that no longer exists.
        $set['suspension.previous_status'] = 'live';
      }
      const moved = await this.repo.casUpdate(
        { _id: row._id, status: row.status, 'review.state': 'pending_review' },
        { $set },
        session,
      );
      if (!moved) throw conflict('This listing changed while it was being reviewed. Reload the queue.');
      // The superseded published photos are no longer the listing's.
      await this.fileRefs.reconcile(
        {
          previousFileIds: photoUnion(row.published, row.pending),
          nextFileIds: photoUnion(row.pending),
          actor: { type: 'admin', id: actor.userId },
          entityType: LISTING_FILE_ENTITY,
          entityId: listingId,
          field: LISTING_FILE_FIELD,
        },
        { session },
      );
      return moved;
    });

    publishListingEvent(LISTING_EVENTS.APPROVED, listingId, vendorId, { revision: !!row.published });
    if (updated.status === 'live') {
      // Charged at submission (O-18); a failed index returns that fee.
      void this.vectorisation.index(listingId, { billed: feeTaken });
    } else {
      // Not live (approved INTO a suspension): an earlier index of the OLD content must not stay
      // searchable. The fee is KEPT — the index it paid for is deferred, not failed (O-18 returns
      // it only on a failure): the resume or the unsuspension indexes this content, unbilled.
      // Refunding here would also be self-defeating: the refund alone can lift the balance back
      // to the first-reveal cost and resume the listing at once, indexed for free.
      void this.vectorisation.deindex(listingId, row.vectorised_data_id ?? null);
      if (updated.suspension?.reason === 'insufficient_credits' && row.status !== 'suspended') {
        publishListingEvent(LISTING_EVENTS.SUSPENDED, listingId, vendorId, { reason: 'insufficient_credits' });
      }
    }
    return toAdminListingResult(updated);
  }

  async reject(listingId: string, reasons: string[], actor: ActorRef): Promise<AdminListingResult> {
    const row = await this.repo.findById(listingId);
    if (!row) throw notFound();
    if (row.review?.state !== 'pending_review') throw conflict('This listing is not waiting for review.');
    const vendorId = row.vendor_id.toString();
    const now = new Date();

    const { moved: updated, refunded } = await this.tx.runInTransactionWithRetry(async (session) => {
      const moved = await this.repo.casUpdate(
        { _id: row._id, status: row.status, 'review.state': 'pending_review' },
        {
          $set: {
            status: statusAfter('reject', stateViewOf(row)),
            'review.state': 'rejected',
            'review.reasons': reasons,
            'review.decided_at': now,
            ...prefixed('review.', actorStamp('decided_by', actor)),
            'review.index_fee_ref': null,
            last_decision: { decision: 'rejected', at: now, ...actorStamp('by', actor), reasons },
          },
        },
        session,
      );
      if (!moved) throw conflict('This listing changed while it was being reviewed. Reload the queue.');
      return { moved, refunded: await refundIndexFee(this.wallet, vendorId, listingId, row.review?.index_fee_ref ?? null, session) };
    });

    // After the commit (§ C-5): the refund's nudge, then the decision.
    if (refunded) publishWalletCredited(refunded, 'vectorisation');
    publishListingEvent(LISTING_EVENTS.REJECTED, listingId, vendorId, { reasons, revision: !!row.published });
    return toAdminListingResult(updated);
  }

  /** `platform_oversight` — from live, or over a funding suspension (§ C-3). */
  async suspend(listingId: string, note: string, actor: ActorRef): Promise<AdminListingResult> {
    const row = await this.repo.findById(listingId);
    if (!row) throw notFound();
    const fromFunding = row.status === 'suspended' && row.suspension?.reason === 'insufficient_credits';
    if (row.status !== 'live' && !fromFunding) {
      throw conflict('Only a live listing (or one paused for credits) can be suspended.');
    }
    const updated = await this.repo.casUpdate(
      fromFunding
        ? { _id: row._id, status: 'suspended', 'suspension.reason': 'insufficient_credits' }
        : { _id: row._id, status: 'live' },
      {
        $set: {
          status: 'suspended',
          suspension: { reason: 'platform_oversight', previous_status: 'live', at: new Date(), note, ...actorStamp('by', actor) },
        },
      },
    );
    if (!updated) throw conflict('This listing changed a moment ago. Reload and try again.');
    const vendorId = row.vendor_id.toString();
    void this.vectorisation.deindex(listingId, row.vectorised_data_id ?? null);
    publishListingEvent(LISTING_EVENTS.SUSPENDED, listingId, vendorId, { reason: 'platform_oversight' });
    return toAdminListingResult(updated);
  }

  /**
   * Lift ONLY a `platform_oversight` suspension, back to its exact `previous_status` — and then
   * re-check funding in the same write: a provider under the first-reveal cost goes straight into
   * `insufficient_credits` instead of flickering live.
   */
  async unsuspend(listingId: string, _actor: ActorRef): Promise<AdminListingResult> {
    const row = await this.repo.findById(listingId);
    if (!row) throw notFound();
    if (row.status !== 'suspended' || row.suspension?.reason !== 'platform_oversight') {
      throw conflict('Only a listing an administrator suspended can be brought back here.');
    }
    const vendorId = row.vendor_id.toString();
    const back = row.suspension.previous_status;
    const underfunded = back === 'live' && (await this.wallet.getBalance('vendor', vendorId)) < this.firstRevealCost;
    const updated = await this.repo.casUpdate(
      { _id: row._id, status: 'suspended', 'suspension.reason': 'platform_oversight' },
      {
        $set: underfunded
          ? { status: 'suspended', suspension: ListingFundingService.insufficientCreditsSuspension(new Date()) }
          : { status: back, suspension: null },
      },
    );
    if (!updated) throw conflict('This listing changed a moment ago. Reload and try again.');
    if (updated.status === 'live') {
      publishListingEvent(LISTING_EVENTS.RESUMED, listingId, vendorId);
      void this.vectorisation.index(listingId, { billed: false });
    } else if (underfunded) {
      publishListingEvent(LISTING_EVENTS.SUSPENDED, listingId, vendorId, { reason: 'insufficient_credits' });
    }
    return toAdminListingResult(updated);
  }
}

/** `{ a: 1 }` → `{ 'review.a': 1 }` for a dotted `$set` into a sub-document. */
function prefixed(prefix: string, obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${prefix}${k}`, v]));
}

export const listingReviewService = new ListingReviewService();
