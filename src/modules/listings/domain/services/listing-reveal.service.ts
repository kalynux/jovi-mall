import { ClientSession, Types } from 'mongoose';
import { createAppError, AppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { logger } from '../../../../core/logging';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { LISTING_REVEAL_FIRST_COST, LISTING_REVEAL_NEXT_COST } from '../../../billing/config/credit.config';
import { listingRepository, ListingRepository, ListingRow } from '../../repositories/listing.repository';
import { listingContactRepository, ListingContactRepository } from '../../repositories/listing-contact.repository';
import { listingLeadRepository, ListingLeadRepository, ListingLeadRow } from '../../repositories/listing-lead.repository';
import { listingRevealRepository, ListingRevealRepository, RevealVendorFacts } from '../../repositories/listing-reveal.repository';
import { LISTING_EVENTS, ListingContactField, ListingLeadChannel } from '../listing.types';
import {
  effectiveListingSettings,
  exceedsDailyCap,
  isCurrentLead,
  leadWindowFrom,
  liveDebitFallback,
  platformDayBounds,
  revealFingerprint,
  revealPathFor,
  revealPrice,
  RevealCosts,
  RevealPath,
  RevealValue,
  revealValueOf,
  shouldSuspendAfterDebit,
} from '../reveal-rules';
import { publishListingEvent } from './listing-events';
import { listingFundingService, ListingFundingService } from './listing-funding.service';
import { youtubeOembedChecker, YoutubeOembedChecker } from './youtube-oembed.checker';

/**
 * ListingRevealService — a signed-in customer unlocks ONE contact field of a listing, and the
 * provider pays for it in credits (SERVICE-LISTINGS-PLAN § The reveal, L-7 … L-11, L-29, L-30,
 * § C-8a). This is the platform's revenue on a sale that happens away from it.
 *
 * The rules are `reveal-rules.ts` (pure, pinned by `test:service-listings-reveal`); this file
 * reads the facts, asks the rules, and writes the money record:
 *
 *   1. already revealed in this window   → the value again, nothing charged (even on a listing
 *                                          that has since gone offline, § C-8a)
 *   2. reachability                      → live, grace (L-10) or refuse (`LISTING_UNREACHABLE`)
 *   3. an active block (L-29)            → the same neutral refusal; the customer is not told
 *      the daily cap (L-30)              → `LISTING_REVEAL_DAILY_LIMIT`
 *   4. price                             → first or next (L-7)
 *   5. debit                             → `debitInSession` (live) or `debitAllowingDebtInSession`
 *                                          (grace, down to the provider's floor)
 *   6. the reveal row + the ledger row   → one transaction
 *   7. below the first-reveal cost       → every live listing suspended `insufficient_credits`,
 *                                          inside the same transaction; events after commit
 *
 * ⛔ **This is the ONLY caller of `debitAllowingDebtInSession`** (`test:service-listings-billing`
 * § 5). Every other debit on the platform keeps balances at or above zero.
 *
 * ⛔ **The value is read from the APPROVED contact set only** (`readPublishedField`), one field,
 * and is never written anywhere: the reveal row keeps a fingerprint (L-9).
 *
 * ── Concurrency ──────────────────────────────────────────────────────────────
 * Two taps on the SAME field: the unique `(lead_id, field)` index rejects the loser's insert,
 * its transaction aborts (no debit survives), and it answers with the winner's reveal, free.
 * Two first taps on two DIFFERENT fields within the same instant can each open a lead (the
 * window starts at the tap) and each pay the first-reveal price. A bot tap is sequential and a
 * web tap needs two buttons pressed in the same millisecond, so this is accepted rather than
 * locked; the provider can report it (L-31) and an administrator refunds.
 */

export interface RevealRequest {
  /** `customers._id` — the role entity, which is what leads, reveals and blocks are keyed by. */
  customerId: string;
  /** `users._id` — used ONLY to recognise the provider revealing their own listing. */
  userId: string;
  listingId: string;
  field: ListingContactField;
  channel: ListingLeadChannel;
}

export interface RevealResult {
  field: ListingContactField;
  value: RevealValue;
  charged: boolean;
  cost: number;
  alreadyRevealed: boolean;
  /** When this customer's window on this listing ends; `null` on a provider's own listing. */
  windowEndsAt: string | null;
  /** What the NEXT field of this listing costs this customer within the window. */
  nextCost: number;
}

/** What a reveal tells its caller beyond the result — the bot's opt-in question needs the provider. */
export interface RevealOutcome {
  result: RevealResult;
  vendorId: string;
  /** True on the reveal that OPENED a lead (the first field of a window). */
  openedLead: boolean;
}

type Wallet = Pick<typeof creditWalletService, 'debitInSession' | 'debitAllowingDebtInSession'>;
type Tx = Pick<typeof transactionManager, 'runInTransactionWithRetry'>;
type Funding = Pick<ListingFundingService, 'suspendForInsufficientCredits' | 'afterSuspended'>;

const notFound = (): AppError => createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');
const unreachable = (): AppError => createAppError(ERROR_CODES.LISTING_UNREACHABLE, 422);
const fieldUnavailable = (field: string): AppError =>
  createAppError(ERROR_CODES.LISTING_FIELD_UNAVAILABLE, 422, 'This business has not given this contact detail', { field });

const isDuplicateKey = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;

/** A debit the wallet refused (`BILLING_INSUFFICIENT_CREDITS`) — the live path's fall-back trigger. */
const isInsufficientCredits = (err: unknown): boolean =>
  err instanceof AppError && err.code === ERROR_CODES.BILLING_INSUFFICIENT_CREDITS;

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** Raised inside the transaction when a concurrent identical reveal already committed. */
class AlreadyRevealedInTx extends Error {}

export class ListingRevealService {
  constructor(
    private readonly listings: Pick<ListingRepository, 'findById'> = listingRepository,
    private readonly contacts: Pick<ListingContactRepository, 'readPublishedField'> = listingContactRepository,
    private readonly leads: Pick<ListingLeadRepository, 'findCurrent' | 'create' | 'addField'> = listingLeadRepository,
    private readonly reveals: Pick<
      ListingRevealRepository,
      'insert' | 'findByLeadAndField' | 'spentBetween' | 'hasActiveBlock' | 'ledgerRefFor' | 'vendorFacts'
    > = listingRevealRepository,
    private readonly wallet: Wallet = creditWalletService,
    private readonly funding: Funding = listingFundingService,
    private readonly oembed: Pick<YoutubeOembedChecker, 'check'> = youtubeOembedChecker,
    private readonly tx: Tx = transactionManager,
    private readonly costs: RevealCosts = { first: LISTING_REVEAL_FIRST_COST, next: LISTING_REVEAL_NEXT_COST },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The public price list a card draws on its buttons (§ C-3 `revealCosts`). */
  get revealCosts(): RevealCosts {
    return { ...this.costs };
  }

  async reveal(req: RevealRequest): Promise<RevealOutcome> {
    const listing = await this.listings.findById(req.listingId);
    // Never approved = never public: the same 404 an unknown id gets.
    if (!listing || !listing.published) throw notFound();
    const vendorId = listing.vendor_id.toString();
    const vendor = await this.reveals.vendorFacts(vendorId);
    if (!vendor || !vendor.isProvider) throw notFound();

    // § C-8a: a provider revealing their own listing gets the value free and opens no lead.
    if (vendor.userId && vendor.userId === req.userId) {
      const value = await this.readValue(listing, req.field);
      return {
        vendorId,
        openedLead: false,
        result: this.resultOf(req.field, value, { charged: false, cost: 0, alreadyRevealed: false, windowEnd: null }),
      };
    }

    const now = this.clock();
    const current = await this.leads.findCurrent(req.customerId, req.listingId, now);

    // Step 1 — already paid for in this window: the value again, free, whatever the listing's
    // status is now. (An erased contact — a closed provider — has nothing left to return.)
    if (current && isCurrentLead(current, now) && current.fields_revealed.includes(req.field)) {
      const value = await this.readValue(listing, req.field);
      return { vendorId, openedLead: false, result: this.alreadyRevealedResult(req.field, value, current) };
    }

    if (!(listing.available_fields ?? []).includes(req.field)) throw fieldUnavailable(req.field);

    // Step 2 — may this customer reveal from this listing at all?
    const settings = effectiveListingSettings(vendor.settings);
    const path = this.pathFor(listing, vendor, current);
    if (path === 'refuse') throw unreachable();

    // Step 3 — L-29 block (neutral), then the L-30 daily cap. Nothing charged either way.
    if (await this.reveals.hasActiveBlock(req.customerId, req.listingId)) throw unreachable();
    const price = revealPrice(current, this.costs);
    const day = platformDayBounds(now);
    const spentToday = await this.reveals.spentBetween(req.customerId, req.listingId, day.start, day.end);
    if (exceedsDailyCap(spentToday, price, settings.max_credits_per_customer_per_day)) {
      throw createAppError(ERROR_CODES.LISTING_REVEAL_DAILY_LIMIT, 422);
    }

    // The value BEFORE any money moves: an absent field, or a YouTube video that is gone,
    // costs the provider nothing.
    const value = await this.readValue(listing, req.field);
    await this.assertVideoWatchable(req.field, value, listing);

    let suspended: Array<{ id: string; vectorisedDataId: string | null }> = [];
    let outcome: RevealOutcome;
    try {
      outcome = await this.tx.runInTransactionWithRetry(async (session) => {
        suspended = [];
        const lead = await this.leads.findCurrent(req.customerId, req.listingId, now, session);
        if (lead && lead.fields_revealed.includes(req.field)) throw new AlreadyRevealedInTx();

        const revealId = new Types.ObjectId();
        const balanceAfter = await this.debit(path, vendorId, price, settings.debt_floor, !!lead?.engaged_while_live, settings.on_empty, revealId, session);

        let leadId: Types.ObjectId;
        let windowEnd: Date;
        if (lead) {
          await this.leads.addField(lead._id, req.field, req.channel, session);
          leadId = lead._id;
          windowEnd = lead.window_end;
        } else {
          const window = leadWindowFrom(now);
          leadId = new Types.ObjectId();
          await this.leads.create(
            {
              _id: leadId,
              customerId: req.customerId,
              listingId: req.listingId,
              vendorId,
              windowStart: window.start,
              windowEnd: window.end,
              field: req.field,
              channel: req.channel,
            },
            session,
          );
          windowEnd = window.end;
        }

        await this.reveals.insert(
          {
            _id: revealId,
            leadId,
            listingId: req.listingId,
            vendorId,
            customerId: req.customerId,
            field: req.field,
            cost: price,
            chargedIntoDebt: balanceAfter < 0,
            valueFingerprint: revealFingerprint(req.field, value),
            ledgerRef: await this.reveals.ledgerRefFor(vendorId, revealId, session),
            at: now,
          },
          session,
        );

        // Step 7 — the provider can no longer pay a first reveal: their live listings close to
        // NEW customers (engaged ones keep the grace, L-10). Same transaction; events after it.
        if (shouldSuspendAfterDebit(balanceAfter, this.costs)) {
          suspended = await this.funding.suspendForInsufficientCredits(vendorId, session);
        }

        return {
          vendorId,
          openedLead: !lead,
          result: this.resultOf(req.field, value, { charged: true, cost: price, alreadyRevealed: false, windowEnd }),
        };
      });
    } catch (err) {
      if (err instanceof AlreadyRevealedInTx || isDuplicateKey(err)) {
        // A concurrent identical tap won. Answer with its reveal, charging nothing.
        const winner = await this.leads.findCurrent(req.customerId, req.listingId, this.clock());
        if (winner && winner.fields_revealed.includes(req.field)) {
          return { vendorId, openedLead: false, result: this.alreadyRevealedResult(req.field, value, winner) };
        }
      }
      throw err;
    }

    if (suspended.length > 0) {
      logger().info({ vendorId, suspended: suspended.length }, 'listings: provider below the first-reveal cost, listings suspended');
      this.funding.afterSuspended(vendorId, suspended);
    }
    return outcome;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private pathFor(listing: ListingRow, vendor: RevealVendorFacts, current: ListingLeadRow | null): RevealPath {
    const settings = effectiveListingSettings(vendor.settings);
    return revealPathFor({
      status: listing.status,
      suspensionReason: listing.suspension?.reason ?? null,
      vendorActive: vendor.active,
      currentLeadEngaged: !!current?.engaged_while_live,
      onEmpty: settings.on_empty,
    });
  }

  /**
   * Step 5. Live: the ordinary debit; when the balance cannot cover it, the SAME grace rule a
   * suspended listing applies decides whether this one engaged customer is served into debt.
   * Grace: the debt path down to the provider's floor. Either refusal is `LISTING_UNREACHABLE`
   * (neutral — the customer is never told the business is out of credits). Returns the balance.
   */
  private async debit(
    path: RevealPath,
    vendorId: string,
    price: number,
    floor: number | null,
    engaged: boolean,
    onEmpty: 'stop' | 'continue_engaged',
    revealId: Types.ObjectId,
    session: ClientSession,
  ): Promise<number> {
    const ref = revealId.toString();
    if (path === 'live') {
      try {
        const wallet = await this.wallet.debitInSession('vendor', vendorId, price, 'listing_reveal', ref, session);
        return wallet.balance;
      } catch (err) {
        if (!isInsufficientCredits(err)) throw err;
        if (liveDebitFallback(engaged, onEmpty) === 'refuse') throw unreachable();
      }
    }
    const wallet = await this.wallet.debitAllowingDebtInSession('vendor', vendorId, price, floor, 'listing_reveal', ref, session);
    if (!wallet) throw unreachable(); // the provider's own floor (L-11)
    return wallet.balance;
  }

  private async readValue(listing: ListingRow, field: ListingContactField): Promise<RevealValue> {
    const raw = await this.contacts.readPublishedField(listing._id.toString(), field);
    const value = revealValueOf(field, raw);
    if (!value) throw fieldUnavailable(field);
    return value;
  }

  /**
   * § Location video: a YouTube link is re-checked at reveal. A definite "gone" charges nothing,
   * tells the customer, and alerts the provider to replace it (a revision, so it is reviewed).
   * A network failure or timeout FAILS OPEN (§ C-8a): YouTube being down must not strand every
   * location video on the platform. Drive cannot be checked and is served as given.
   */
  private async assertVideoWatchable(field: ListingContactField, value: RevealValue, listing: ListingRow): Promise<void> {
    if (field !== 'video') return;
    const video = value as { url: string; host: string };
    if (video.host !== 'youtube') return;
    if ((await this.oembed.check(video.url)) !== 'gone') return;
    publishListingEvent(LISTING_EVENTS.VIDEO_UNAVAILABLE, listing._id.toString(), listing.vendor_id.toString());
    throw createAppError(ERROR_CODES.LISTING_VIDEO_UNAVAILABLE, 422);
  }

  private alreadyRevealedResult(field: ListingContactField, value: RevealValue, lead: ListingLeadRow): RevealResult {
    return this.resultOf(field, value, { charged: false, cost: 0, alreadyRevealed: true, windowEnd: lead.window_end });
  }

  private resultOf(
    field: ListingContactField,
    value: RevealValue,
    o: { charged: boolean; cost: number; alreadyRevealed: boolean; windowEnd: Date | null },
  ): RevealResult {
    return {
      field,
      value,
      charged: o.charged,
      cost: o.cost,
      alreadyRevealed: o.alreadyRevealed,
      windowEndsAt: iso(o.windowEnd),
      nextCost: this.costs.next,
    };
  }
}

export const listingRevealService = new ListingRevealService();
