import { ClientSession, Types } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { logger } from '../../../../core/logging';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { getStorageProvider } from '../../../../core/storage/storage.instance';
import { toPlainText, RichDoc } from '../../../../core/richtext';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { entitlementService } from '../../../billing/services/entitlement.service';
import { VECTORISATION_COST } from '../../../billing/config/credit.config';
import { CreditTransactionModel } from '../../../billing/models/credit-transaction.model';
import type { ICreditWallet } from '../../../billing/models/credit-wallet.model';
import { publishWalletCredited } from '../../../billing/domain/wallet-credited.event';
import { categoryResolutionService } from '../../../categories/services/category-resolution.service';
import { categoryCatalogCache } from '../../../categories/services/category-catalog.cache';
import { FileRepositoryMongo } from '../../../catalog/repositories/mongo/file.repository.mongo';
import { FileReferenceRepositoryMongo } from '../../../catalog/repositories/mongo/file-reference.repository.mongo';
import { FileReferenceService, FileReferenceActor } from '../../../catalog/domain/services/media/FileReferenceService';
import type { FileReferenceEntityType } from '../../../catalog/models/file-reference.model';
import { resolveFileDetails } from '../../../catalog/read-models/file-detail.resolver';
import type { IListingContentDoc } from '../../models/listing.model';
import { listingRepository, ListingRepository, ListingRow } from '../../repositories/listing.repository';
import {
  listingContactRepository,
  ListingContactRepository,
  ListingContactSetDoc,
} from '../../repositories/listing-contact.repository';
import type { ListingWriteInput } from '../../validators/listing.validator';
import { LISTING_EVENTS, ListingStatus } from '../listing.types';
import {
  canPerform,
  classifyVideoUrl,
  detectPreflags,
  editOpensRevision,
  findMissing,
  listingSlugBase,
  ListingStateView,
  ProviderListingAction,
  slugCandidate,
  statusAfter,
} from '../listing-rules';
import {
  applyContactsPatch,
  applyContentPatch,
  cloneContacts,
  cloneContent,
  emptyContent,
  photoUnion,
} from './listing-content.mapper';
import { publishCapacityFreed, publishListingEvent } from './listing-events';
import { listingFundingService, ListingFundingService } from './listing-funding.service';
import { listingVectorisationService, ListingVectorisationService } from './listing-vectorisation.service';
import { youtubeOembedChecker, YoutubeOembedChecker } from './youtube-oembed.checker';
import {
  toVendorContentDto,
  toVendorListingDetail,
  toVendorListingSummary,
  VendorListingDetail,
  VendorListingSummary,
} from '../../dto/vendor-listing.dto';

/**
 * The provider's side of a listing (SERVICE-LISTINGS-PLAN L-5, O-18, § C-3 "Provider") —
 * create, edit, submit, withdraw, discard a revision, archive, and the provider's own reads.
 *
 * ── The working copy ─────────────────────────────────────────────────────────
 * Every edit lands in `pending` (+ `listing_contacts.pending`). A never-approved listing has
 * only a working copy. The first edit of a LIVE listing clones `published` into `pending` —
 * a revision (L-5) — and the approved version stays live, untouched, until an administrator
 * approves the revision. Contact edits are revisions like any other (stated defaults: no
 * bait-and-switch after approval).
 *
 * ── Every state change is a compare-and-set ──────────────────────────────────
 * The filter names the state this request READ (`status`, `review.state`), so a concurrent
 * submit, decision or second tab loses cleanly with `409 LISTING_STATUS_CONFLICT` rather than
 * acting on a state nobody is in.
 *
 * ── Money (O-18) ─────────────────────────────────────────────────────────────
 * Submitting debits the indexing fee through the ordinary `creditWalletService.debit` (its own
 * transaction: balance + ledger together). The listing's state change runs after it; if that
 * misses, the fee is credited straight back. Every refund (withdraw, discard, archive) is a
 * `creditInSession` INSIDE the transaction that moves the listing, so a refund cannot happen
 * without the move or the move without the refund.
 */

/**
 * `file_references.entityType` for a listing's photos.
 * `'listing'` is a member of the shared `FileReferenceEntityType` union and schema enum
 * (`catalog/models/file-reference.model.ts`, 2026-10-20).
 */
export const LISTING_FILE_ENTITY: FileReferenceEntityType = 'listing';
export const LISTING_FILE_FIELD = 'photos';

export function freshReview(): Record<string, unknown> {
  return {
    state: 'editing',
    submitted_at: null,
    decided_at: null,
    decided_by_user_id: null,
    decided_by_source: 'platform',
    decided_by_name: null,
    reasons: [],
    preflags: [],
    index_fee_ref: null,
  };
}

export function stateViewOf(row: Pick<ListingRow, 'status' | 'published' | 'pending' | 'review'>): ListingStateView {
  return {
    status: row.status,
    hasPublished: !!row.published,
    hasPending: !!row.pending,
    reviewState: row.review?.state ?? null,
  };
}

/** The CAS filter naming the state a decision was taken on. */
export function readStateFilter(row: ListingRow): Record<string, unknown> {
  return { _id: row._id, vendor_id: row.vendor_id, status: row.status, 'review.state': row.review?.state ?? null };
}

const conflict = (message: string) => createAppError(ERROR_CODES.LISTING_STATUS_CONFLICT, 409, message);
const notFound = () => createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');

type Wallet = Pick<typeof creditWalletService, 'debit' | 'credit' | 'creditInSession'>;
type Entitlements = Pick<typeof entitlementService, 'assertCanAddListings'>;
type Categories = Pick<typeof categoryResolutionService, 'resolveForWrite'>;
type Tx = Pick<typeof transactionManager, 'runInTransactionWithRetry'>;

export class ListingProviderService {
  constructor(
    private readonly repo: ListingRepository = listingRepository,
    private readonly contacts: ListingContactRepository = listingContactRepository,
    private readonly wallet: Wallet = creditWalletService,
    private readonly entitlements: Entitlements = entitlementService,
    private readonly categories: Categories = categoryResolutionService,
    private readonly oembed: Pick<YoutubeOembedChecker, 'check'> = youtubeOembedChecker,
    private readonly funding: Pick<ListingFundingService, 'reconcileVendor'> = listingFundingService,
    private readonly vectorisation: Pick<ListingVectorisationService, 'deindex'> = listingVectorisationService,
    private readonly fileRepo: FileRepositoryMongo = new FileRepositoryMongo(),
    private readonly fileRefs: Pick<FileReferenceService, 'reconcile'> = new FileReferenceService(
      new FileRepositoryMongo(),
      new FileReferenceRepositoryMongo(),
    ),
    private readonly tx: Tx = transactionManager,
    private readonly feeLedger: IndexFeeLedger = indexFeeLedger,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async list(vendorId: string, query: { status?: ListingStatus; page: number; limit: number }) {
    const { data, total } = await this.repo.listOwned(vendorId, query.status, query.page, query.limit);
    return {
      data: data.map(toVendorListingSummary) as VendorListingSummary[],
      meta: { total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) },
    };
  }

  async get(vendorId: string, listingId: string): Promise<VendorListingDetail> {
    const row = await this.repo.findOwned(listingId, vendorId);
    if (!row) throw notFound();
    return this.detail(row, vendorId);
  }

  private async detail(row: ListingRow, vendorId: string): Promise<VendorListingDetail> {
    const contacts = await this.contacts.getForOwner(row._id.toString(), vendorId);
    const photoIds = photoUnion(row.published, row.pending);
    const photos = await resolveFileDetails(photoIds, this.fileRepo, getStorageProvider());
    const contentDto = async (c: IListingContentDoc | null) =>
      c ? toVendorContentDto(c, await categoryCatalogCache.refsFor(c.category_ids), photos) : null;
    return toVendorListingDetail(row, {
      published: await contentDto(row.published),
      pending: await contentDto(row.pending),
      contacts,
    });
  }

  // ── Create / edit ──────────────────────────────────────────────────────────

  async create(vendorId: string, input: ListingWriteInput): Promise<VendorListingDetail> {
    const id = new Types.ObjectId();
    const categoryIds = input.content?.categories
      ? await this.categories.resolveForWrite(input.content.categories, { source: 'vendor', vendorId })
      : undefined;
    const content = applyContentPatch(emptyContent(), input.content, categoryIds);
    const contactSet = applyContactsPatch(null, input.contacts);
    await this.assertPhotosAreImages(content);

    const create = async (slug: string) =>
      this.tx.runInTransactionWithRetry(async (session) => {
        const row = await this.repo.create(
          {
            _id: id,
            vendor_id: new Types.ObjectId(vendorId),
            slug,
            status: 'draft',
            pending: content,
            review: freshReview() as never,
          } as never,
          session,
        );
        await this.contacts.upsertPending(id.toString(), vendorId, contactSet, session);
        await this.reconcilePhotos(id.toString(), [], photoUnion(content), { type: 'vendor', id: vendorId }, session);
        return row;
      });

    const row = await this.withUniqueSlug(listingSlugBase(content.title), undefined, create);
    return this.detail(row, vendorId);
  }

  async update(vendorId: string, listingId: string, input: ListingWriteInput): Promise<VendorListingDetail> {
    const row = await this.repo.findOwned(listingId, vendorId);
    if (!row) throw notFound();
    const view = stateViewOf(row);
    this.assertCan('edit', view);

    const opening = editOpensRevision(view);
    const current = await this.contacts.getForOwner(listingId, vendorId);
    const baseContent = opening ? cloneContent(row.published) : row.pending;
    const baseContacts = opening ? cloneContacts(current?.published) : current?.pending ?? null;

    const categoryIds = input.content?.categories
      ? await this.categories.resolveForWrite(input.content.categories, { source: 'vendor', vendorId })
      : undefined;
    const nextContent = applyContentPatch(baseContent, input.content, categoryIds);
    const contactsChanged = opening || input.contacts !== undefined;
    const nextContacts = contactsChanged ? applyContactsPatch(baseContacts, input.contacts) : null;
    await this.assertPhotosAreImages(nextContent);

    // The slug follows the title until the first approval, then never moves (§ C-2 / brief).
    const reslug = !row.published_at && input.content?.title !== undefined
      && listingSlugBase(nextContent.title) !== listingSlugBase(row.pending?.title);

    const write = async (slug: string | null) =>
      this.tx.runInTransactionWithRetry(async (session) => {
        const $set: Record<string, unknown> = { pending: nextContent };
        // A first edit, or the first edit after a rejection, starts a fresh working copy.
        if (opening || row.review?.state !== 'editing') $set.review = freshReview();
        if (slug) $set.slug = slug;
        const updated = await this.repo.casUpdate(readStateFilter(row), { $set }, session);
        if (!updated) throw conflict('This listing changed while you were editing it. Reload and try again.');
        if (nextContacts) await this.contacts.upsertPending(listingId, vendorId, nextContacts, session);
        await this.reconcilePhotos(
          listingId,
          photoUnion(row.published, row.pending),
          photoUnion(row.published, nextContent),
          { type: 'vendor', id: vendorId },
          session,
        );
        return updated;
      });

    const updated = reslug
      ? await this.withUniqueSlug(listingSlugBase(nextContent.title), listingId, write)
      : await write(null);
    return this.detail(updated, vendorId);
  }

  // ── Submit / withdraw / discard / archive ──────────────────────────────────

  async submit(vendorId: string, listingId: string): Promise<VendorListingDetail> {
    const row = await this.repo.findOwned(listingId, vendorId);
    if (!row) throw notFound();
    const view = stateViewOf(row);
    this.assertCan('submit', view);

    const current = await this.contacts.getForOwner(listingId, vendorId);
    const pendingContacts = current?.pending ?? null;

    const missing = findMissing(row.pending, pendingContacts);
    if (missing.length > 0) {
      throw createAppError(ERROR_CODES.LISTING_INCOMPLETE, 422, 'This listing is not complete yet.', { missing });
    }

    // The video: re-judge the host, then ask YouTube whether it can be watched.
    let checkedContacts: ListingContactSetDoc | null = null;
    const video = pendingContacts?.video ?? null;
    if (video) {
      const host = classifyVideoUrl(video.url);
      if (!host) {
        throw createAppError(ERROR_CODES.LISTING_VIDEO_LINK_INVALID, 422,
          'The location video must be a YouTube link (youtube.com or youtu.be) or a Google Drive file link.');
      }
      if (host === 'youtube') {
        const verdict = await this.oembed.check(video.url);
        if (verdict === 'gone') {
          throw createAppError(ERROR_CODES.LISTING_VIDEO_NOT_WATCHABLE, 422,
            'This YouTube video cannot be watched — it is private or was removed. Make it "unlisted" (not private) and try again.');
        }
        // Network trouble fails OPEN: accepted unchecked, and the reviewer watches it.
        checkedContacts = { ...cloneContacts(pendingContacts), video: { url: video.url, host, checked_at: verdict === 'watchable' ? new Date() : null } };
      }
    }

    // The plan slot (§ C-8a): only a listing that does not already hold one is checked — a
    // revision of a published listing adds nothing.
    if (!row.published) {
      const occupied = await this.repo.countOccupyingSlots(vendorId, listingId);
      await this.entitlements.assertCanAddListings(vendorId, occupied, 1);
    }

    const preflags = detectPreflags({
      title: row.pending?.title,
      company_name: row.pending?.company_name,
      area: row.pending?.area,
      description: row.pending?.description,
      description_rich: richPlainText(row.pending?.description_rich),
    });

    // The fee (O-18). 402 BILLING_INSUFFICIENT_CREDITS refuses the submission, unchanged.
    let feeRef: string | null = null;
    if (VECTORISATION_COST > 0) {
      await this.wallet.debit('vendor', vendorId, VECTORISATION_COST, 'vectorisation', listingId);
      feeRef = await this.feeLedger.latestFeeRowId(vendorId, listingId);
    }

    const now = new Date();
    try {
      await this.tx.runInTransactionWithRetry(async (session) => {
        const updated = await this.repo.casUpdate(
          readStateFilter(row),
          {
            $set: {
              status: statusAfter('submit', view),
              'review.state': 'pending_review',
              'review.submitted_at': now,
              'review.decided_at': null,
              'review.reasons': [],
              'review.preflags': preflags,
              'review.index_fee_ref': feeRef,
            },
          },
          session,
        );
        if (!updated) throw conflict('This listing changed while you were submitting it. Reload and try again.');
        if (checkedContacts) await this.contacts.upsertPending(listingId, vendorId, checkedContacts, session);
      });
    } catch (err) {
      if (feeRef) {
        await this.wallet
          .credit('vendor', vendorId, VECTORISATION_COST, 'refund', 'vectorisation', listingId)
          .catch((refundErr) => logger().error({ listingId, vendorId, err: refundErr }, 'listing submit: REFUND FAILED after a lost submit'));
      }
      throw err;
    }

    publishListingEvent(LISTING_EVENTS.SUBMITTED, listingId, vendorId, { revision: !!row.published });
    // The fee may have taken the balance under the first-reveal cost (L-10).
    if (feeRef) void this.funding.reconcileVendor(vendorId).catch((err) => logger().error({ vendorId, err }, 'listing submit: funding reconcile failed'));
    return this.get(vendorId, listingId);
  }

  async withdraw(vendorId: string, listingId: string): Promise<VendorListingDetail> {
    const row = await this.repo.findOwned(listingId, vendorId);
    if (!row) throw notFound();
    const view = stateViewOf(row);
    this.assertCan('withdraw', view);

    const refunded = await this.tx.runInTransactionWithRetry(async (session) => {
      const updated = await this.repo.casUpdate(
        readStateFilter(row),
        { $set: { status: statusAfter('withdraw', view), review: freshReview() } },
        session,
      );
      if (!updated) throw conflict('An administrator decided on this listing a moment ago. Reload to see the decision.');
      return this.refundFeeInSession(vendorId, listingId, row.review?.index_fee_ref ?? null, session);
    });
    // After the commit (§ C-5): the refund may bring a credit-suspended provider back.
    if (refunded) publishWalletCredited(refunded, 'vectorisation');
    return this.get(vendorId, listingId);
  }

  async discardRevision(vendorId: string, listingId: string): Promise<VendorListingDetail> {
    const row = await this.repo.findOwned(listingId, vendorId);
    if (!row) throw notFound();
    this.assertCan('discard_revision', stateViewOf(row));

    const refunded = await this.tx.runInTransactionWithRetry(async (session) => {
      const updated = await this.repo.casUpdate(readStateFilter(row), { $set: { pending: null, review: null } }, session);
      if (!updated) throw conflict('This listing changed a moment ago. Reload and try again.');
      await this.contacts.upsertPending(listingId, vendorId, null, session);
      await this.reconcilePhotos(listingId, photoUnion(row.published, row.pending), photoUnion(row.published),
        { type: 'vendor', id: vendorId }, session);
      return row.review?.state === 'pending_review'
        ? this.refundFeeInSession(vendorId, listingId, row.review.index_fee_ref ?? null, session)
        : null;
    });
    if (refunded) publishWalletCredited(refunded, 'vectorisation');
    return this.get(vendorId, listingId);
  }

  async archive(vendorId: string, listingId: string): Promise<VendorListingDetail> {
    const row = await this.repo.findOwned(listingId, vendorId);
    if (!row) throw notFound();
    this.assertCan('archive', stateViewOf(row));

    const refunded = await this.tx.runInTransactionWithRetry(async (session) => {
      const updated = await this.repo.casUpdate(
        readStateFilter(row),
        { $set: { status: 'archived', archived_at: new Date(), suspension: null, pending: null, review: null } },
        session,
      );
      if (!updated) throw conflict('This listing changed a moment ago. Reload and try again.');
      if (row.pending) {
        await this.contacts.upsertPending(listingId, vendorId, null, session);
        await this.reconcilePhotos(listingId, photoUnion(row.published, row.pending), photoUnion(row.published),
          { type: 'vendor', id: vendorId }, session);
      }
      return row.review?.state === 'pending_review'
        ? this.refundFeeInSession(vendorId, listingId, row.review.index_fee_ref ?? null, session)
        : null;
    });

    // After the commit: the refund's nudge, out of the AI index, and tell plan-quota a slot may
    // have freed (O-16).
    if (refunded) publishWalletCredited(refunded, 'vectorisation');
    void this.vectorisation.deindex(listingId, row.vectorised_data_id ?? null);
    publishCapacityFreed(vendorId);
    return this.get(vendorId, listingId);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private assertCan(action: ProviderListingAction, view: ListingStateView): void {
    if (canPerform(action, view)) return;
    const why: Record<ProviderListingAction, string> = {
      edit: view.reviewState === 'pending_review'
        ? 'This listing is waiting for review. Withdraw it first to make changes.'
        : 'This listing can no longer be edited.',
      submit: view.reviewState === 'pending_review'
        ? 'This listing is already waiting for review.'
        : 'There is nothing to submit — edit the listing first.',
      withdraw: 'This listing is not waiting for review.',
      discard_revision: 'There is no pending change to discard.',
      archive: 'This listing is already archived.',
    };
    throw conflict(why[action]);
  }

  /**
   * Return the indexing fee taken at submission, inside the caller's transaction. Refunds what
   * the ledger row actually took (the cost may have been re-tuned since).
   */
  private async refundFeeInSession(
    vendorId: string,
    listingId: string,
    feeRef: string | null,
    session: ClientSession,
  ): Promise<ICreditWallet | null> {
    return refundIndexFee(this.wallet, vendorId, listingId, feeRef, session, this.feeLedger);
  }

  private async assertPhotosAreImages(content: IListingContentDoc): Promise<void> {
    const ids = (content.photo_file_ids ?? []).map((id) => id.toString());
    if (ids.length === 0) return;
    const files = await this.fileRepo.findManyByIds(ids);
    const byId = new Map(files.map((f) => [f.id, f]));
    for (const id of ids) {
      const f = byId.get(id);
      if (!f) throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, `File not found: ${id}`);
      if (!f.mimeType?.startsWith('image/')) {
        throw createAppError(ERROR_CODES.CATALOG_FILE_TYPE_INVALID, 400, `A listing photo must be an image; file ${id} is ${f.mimeType}`);
      }
    }
  }

  /** Mirror the photos onto `file_references` — and refuse a file the provider does not own. */
  private async reconcilePhotos(
    listingId: string,
    previous: string[],
    next: string[],
    actor: FileReferenceActor,
    session: ClientSession,
  ): Promise<void> {
    await this.fileRefs.reconcile(
      { previousFileIds: previous, nextFileIds: next, actor, entityType: LISTING_FILE_ENTITY, entityId: listingId, field: LISTING_FILE_FIELD },
      { session },
    );
  }

  /** Try `base`, `base-2`, … until the unique index accepts one. */
  private async withUniqueSlug<T>(base: string, exceptId: string | undefined, write: (slug: string) => Promise<T>): Promise<T> {
    let n = 1;
    for (let attempts = 0; attempts < 25; attempts++) {
      let slug = slugCandidate(base, n);
      while (await this.repo.slugTaken(slug, exceptId)) slug = slugCandidate(base, ++n);
      try {
        return await write(slug);
      } catch (err) {
        if ((err as { code?: number })?.code === 11000 && /slug/.test(String((err as Error).message))) {
          n++;
          continue;
        }
        throw err;
      }
    }
    return write(`${base}-${new Types.ObjectId().toString().slice(-6)}`);
  }
}

/** The plain text of a stored rich description, for the pre-flags. Never throws. */
export function richPlainText(doc: unknown): string {
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { blocks?: unknown }).blocks)) return '';
  try {
    return toPlainText(doc as RichDoc);
  } catch {
    return '';
  }
}

/**
 * The two ledger reads the indexing fee needs — which row a submit's debit wrote, and how much
 * a given row took. Read-only on billing's ledger; injectable so the submit path is testable
 * without a database.
 */
export class IndexFeeLedger {
  /** The ledger row the submit debit just wrote — `review.index_fee_ref`. */
  async latestFeeRowId(vendorId: string, listingId: string): Promise<string> {
    const row = await CreditTransactionModel.findOne(
      { owner_type: 'vendor', owner_id: new Types.ObjectId(vendorId), reason_code: 'vectorisation', type: 'debit', ref: listingId },
      { _id: 1 },
    ).sort({ created_at: -1, _id: -1 }).lean<{ _id: Types.ObjectId }>();
    // The debit committed, so the row exists; the fallback only keeps "a fee was taken" true.
    return row?._id.toString() ?? `vectorisation:${listingId}`;
  }

  /** What a fee row took (positive), or `null` when the reference names no row. */
  async amountOf(feeRef: string, session?: ClientSession): Promise<number | null> {
    if (!Types.ObjectId.isValid(feeRef)) return null;
    const query = CreditTransactionModel.findById(feeRef, { amount: 1 });
    if (session) query.session(session);
    const row = await query.lean<{ amount: number }>();
    return row ? Math.abs(row.amount) : null;
  }
}

export const indexFeeLedger = new IndexFeeLedger();

/**
 * Refund a submission's indexing fee inside a transaction — the one refund path withdraw,
 * discard, archive and the administrator's reject share. `feeRef` null (nothing taken, or the
 * cost was 0) refunds nothing. The amount is what the ledger row took.
 *
 * ⚠ It returns the credited wallet, and EVERY caller must `publishWalletCredited(wallet,
 * 'vectorisation')` after its transaction commits — never inside it (billing's § C-5 rule for
 * `creditInSession`; `test:service-listings-billing` enumerates the callers).
 */
export async function refundIndexFee(
  wallet: Pick<typeof creditWalletService, 'creditInSession'>,
  vendorId: string,
  listingId: string,
  feeRef: string | null,
  session: ClientSession,
  ledger: Pick<IndexFeeLedger, 'amountOf'> = indexFeeLedger,
): Promise<ICreditWallet | null> {
  if (!feeRef) return null;
  const amount = (await ledger.amountOf(feeRef, session)) ?? VECTORISATION_COST;
  if (amount <= 0) return null;
  return wallet.creditInSession('vendor', vendorId, amount, 'refund', 'vectorisation', listingId, session);
}

export const listingProviderService = new ListingProviderService();
