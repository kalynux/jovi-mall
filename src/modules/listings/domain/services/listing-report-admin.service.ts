import { Types } from 'mongoose';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { transactionManager } from '../../../../core/database/transaction.manager';
import { actorStamp, ActorRef } from '../../../../core/types/actor-source.types';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { publishWalletCredited } from '../../../billing/domain/wallet-credited.event';
import { ICreditWallet } from '../../../billing/models/credit-wallet.model';
import { listingRepository, ListingRepository } from '../../repositories/listing.repository';
import { listingRevealRepository, ListingRevealRepository } from '../../repositories/listing-reveal.repository';
import {
  listingRevealBlockRepository,
  ListingRevealBlockRepository,
  ListingRevealBlockRow,
} from '../../repositories/listing-reveal-block.repository';

/**
 * What an administrator may do from a provider's lead report (SERVICE-LISTINGS-PLAN L-25,
 * L-29, L-31, § C-3 "Internal admin"): refund reveals, and block / lift a customer on one
 * listing. Reached ONLY through `/api/internal/admin/*` behind `requireAdminCaller`; wi-admin
 * holds the permissions (`catalog.listings.reveals.refund` — financial, tiers 1 + 2 —
 * and `catalog.listings.reveal-block`) and the fail-closed audit, and none is re-checked here.
 *
 * ── The refund is ONE transaction ────────────────────────────────────────────
 * The provider's wallet is credited (a `refund` ledger row, `listing_reveal_refund`,
 * `ref: revealId`) and the reveal is stamped with that row, together. The stamp is a
 * compare-and-set on `refund: null`, so two administrators refunding at once move the credits
 * once. The credit pays any debt first (L-10) and, after commit, the wallet nudge may bring
 * listings suspended for credits back live — the same path every other credit takes.
 *
 * A refunded reveal stops counting toward the customer's daily cap (L-30) and is shown as
 * refunded on the provider's lead. The customer keeps the value: it was shown to them.
 */
export interface RevealRefundResult {
  revealId: string;
  refundedCredits: number;
  balanceAfter: number;
}

export interface RevealBlockResult {
  listingId: string;
  customerId: string;
  activeBlock: { id: string; reason: string; ticketId: string | null; blockedAt: string } | null;
}

type Wallet = Pick<typeof creditWalletService, 'creditInSession' | 'getBalance'>;
type Tx = Pick<typeof transactionManager, 'runInTransactionWithRetry'>;

class RefundRaceLost extends Error {}

const blockView = (row: ListingRevealBlockRow | null): RevealBlockResult['activeBlock'] =>
  row && !row.lifted_at
    ? {
        id: row._id.toString(),
        reason: row.reason,
        ticketId: row.ticket_id ? row.ticket_id.toString() : null,
        blockedAt: new Date(row.blocked_at).toISOString(),
      }
    : null;

export class ListingReportAdminService {
  constructor(
    private readonly reveals: Pick<ListingRevealRepository, 'findById' | 'markRefunded' | 'ledgerRefFor'> = listingRevealRepository,
    private readonly blocks: Pick<ListingRevealBlockRepository, 'place' | 'lift'> = listingRevealBlockRepository,
    private readonly listings: Pick<ListingRepository, 'findById'> = listingRepository,
    private readonly wallet: Wallet = creditWalletService,
    private readonly tx: Tx = transactionManager,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async refundReveal(revealId: string, input: { ticketId?: string | null; note: string }, actor: ActorRef): Promise<RevealRefundResult> {
    const reveal = await this.reveals.findById(revealId);
    if (!reveal) throw createAppError(ERROR_CODES.LISTING_REVEAL_NOT_FOUND, 404, 'Reveal not found');
    if (reveal.refund) throw createAppError(ERROR_CODES.LISTING_REVEAL_ALREADY_REFUNDED, 409, 'This reveal was already refunded');

    const vendorId = reveal.vendor_id.toString();
    const amount = reveal.cost;
    let credited: ICreditWallet | null = null;

    try {
      await this.tx.runInTransactionWithRetry(async (session) => {
        credited = null;
        let ledgerRef = '';
        if (amount > 0) {
          credited = await this.wallet.creditInSession('vendor', vendorId, amount, 'refund', 'listing_reveal_refund', revealId, session);
          ledgerRef = (await this.reveals.ledgerRefFor(vendorId, reveal._id, session, 'listing_reveal_refund')) ?? '';
        }
        const stamped = await this.reveals.markRefunded(
          reveal._id,
          {
            at: this.clock(),
            ...actorStamp('by', actor),
            ticket_id: input.ticketId ? new Types.ObjectId(input.ticketId) : null,
            ledger_ref: ledgerRef || 'none',
            note: input.note,
          },
          session,
        );
        // Lost the race to another administrator: abort, so the credit above never commits.
        if (!stamped) throw new RefundRaceLost();
      });
    } catch (err) {
      if (err instanceof RefundRaceLost) {
        throw createAppError(ERROR_CODES.LISTING_REVEAL_ALREADY_REFUNDED, 409, 'This reveal was already refunded');
      }
      throw err;
    }

    // Post-commit (§ C-5): the credit may resume listings suspended for credits.
    if (credited) publishWalletCredited(credited, 'listing_reveal_refund');
    const balanceAfter = credited ? (credited as ICreditWallet).balance : await this.wallet.getBalance('vendor', vendorId);
    return { revealId, refundedCredits: amount, balanceAfter };
  }

  async blockCustomer(
    listingId: string,
    customerId: string,
    input: { reason: string; ticketId?: string | null },
    actor: ActorRef,
  ): Promise<RevealBlockResult> {
    const listing = await this.listings.findById(listingId);
    if (!listing) throw createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');
    const placed = await this.blocks.place({
      customerId,
      listingId,
      vendorId: listing.vendor_id.toString(),
      reason: input.reason,
      ticketId: input.ticketId ?? null,
      actor,
      at: this.clock(),
    });
    if (!placed) {
      throw createAppError(ERROR_CODES.LISTING_REVEAL_BLOCK_EXISTS, 409, 'This customer is already blocked on this listing');
    }
    return { listingId, customerId, activeBlock: blockView(placed) };
  }

  async liftBlock(listingId: string, customerId: string, note: string | null, actor: ActorRef): Promise<RevealBlockResult> {
    const listing = await this.listings.findById(listingId);
    if (!listing) throw createAppError(ERROR_CODES.LISTING_NOT_FOUND, 404, 'Listing not found');
    const lifted = await this.blocks.lift(customerId, listingId, note, actor, this.clock());
    if (!lifted) {
      throw createAppError(ERROR_CODES.LISTING_REVEAL_BLOCK_NOT_FOUND, 404, 'This customer is not blocked on this listing');
    }
    return { listingId, customerId, activeBlock: null };
  }
}

export const listingReportAdminService = new ListingReportAdminService();
