import { Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CreditTopupRepository } from '../repositories/credit-topup.repository';
import { CreditWalletService, creditWalletService } from './credit-wallet.service';
import { findCreditPack } from '../config/credit.config';
import { ICreditTopup, CreditTopupGateway } from '../models/credit-topup.model';
import { CreditTopupModel } from '../models/credit-topup.model';
import { BillingOwnerType } from '../billing.types';
import { PaymentChannelInfo } from '../../payments/gateways/gateway.interface';
import { getPaymentGateway } from '../../payments/gateways/registry';
import { mintMerchantRef } from '../../payments/domain/merchant-reference';

/**
 * CreditTopupService - an owner's (vendor/agency/agent) purchase of credit packs.
 *
 * Reuses the payments-module gateway adapters directly (they treat the order
 * reference as a plain label, so no Order/PaymentTransaction is involved).
 * Completion is idempotent and credits the owner's wallet. The owner is stored on
 * the top-up row, so `completeTopup` (from a verify poll or a payment webhook)
 * needs no owner argument.
 */
export class CreditTopupService {
  constructor(
    private readonly repo: CreditTopupRepository = new CreditTopupRepository(),
    private readonly wallet: CreditWalletService = creditWalletService
  ) {}

  /** Start a top-up: create a pending record and open a gateway charge. */
  async initiateTopup(
    ownerType: BillingOwnerType,
    ownerId: string,
    packCode: string,
    gateway: CreditTopupGateway,
    channel: PaymentChannelInfo
  ): Promise<{ topup: ICreditTopup; instructions: unknown }> {
    const pack = findCreditPack(packCode);
    if (!pack) {
      throw createAppError(ERROR_CODES.BILLING_TOPUP_PACK_NOT_FOUND, 404, `Unknown credit pack '${packCode}'`);
    }
    const adapter = getPaymentGateway(gateway);

    // Minted BEFORE the charge and stored on the row, because the callback may
    // arrive before `initiatePayment` has even returned — mobile-money
    // confirmations are not ordered relative to the request that started them.
    const merchantRef = mintMerchantRef('ct');

    const topup = await this.repo.create({
      owner_type: ownerType,
      owner_id: new Types.ObjectId(ownerId),
      pack_code: pack.code,
      credits: pack.credits,
      price: pack.price,
      currency: pack.currency,
      status: 'pending',
      gateway,
      merchant_ref: merchantRef,
    });

    const result = await adapter.initiatePayment({
      orderId: topup._id.toString(), // used by adapters only as a reference label
      userId: ownerId,
      amount: pack.price,
      currency: pack.currency,
      channel,
      merchantRef,
      metadata: {
        purpose: 'credit_topup',
        topupId: topup._id.toString(),
        ownerType,
        // Stripe stamps this into the PaymentIntent's metadata, which is how
        // its callback reports a merchant reference at all.
        merchantRef,
      },
    });

    if (!result.success) {
      await this.repo.setStatus(topup._id, 'failed');
      throw createAppError(
        ERROR_CODES.PAYMENT_INITIATION_FAILED,
        502,
        result.error || 'Failed to start the credit top-up payment'
      );
    }

    const updated = await this.repo.setStatus(topup._id, 'pending', { gateway_ref: result.gatewayRef });
    // Already SUCCEEDED on initiation (rare for mobile money) → complete now.
    if (result.status === 'SUCCEEDED') {
      await this.completeTopup(topup._id.toString());
    }
    return { topup: updated ?? topup, instructions: result.instructions ?? null };
  }

  /** Poll the gateway and complete/fail the top-up accordingly. */
  async verifyAndComplete(
    ownerType: BillingOwnerType,
    ownerId: string,
    topupId: string
  ): Promise<ICreditTopup> {
    const topup = await this.repo.findById(topupId);
    if (!topup || topup.owner_type !== ownerType || topup.owner_id.toString() !== ownerId) {
      throw createAppError(ERROR_CODES.BILLING_TOPUP_NOT_FOUND, 404, 'Top-up not found');
    }
    if (topup.status === 'paid') return topup; // idempotent
    if (!topup.gateway || !topup.gateway_ref) {
      throw createAppError(ERROR_CODES.BILLING_TOPUP_INVALID_STATE, 409, 'Top-up has no gateway reference yet');
    }

    const adapter = getPaymentGateway(topup.gateway);
    const verification = await adapter.verifyPayment({ gatewayRef: topup.gateway_ref });

    if (verification.status === 'SUCCEEDED') {
      return this.completeTopup(topupId);
    }
    if (verification.status === 'FAILED' || verification.status === 'CANCELLED') {
      return (await this.repo.setStatus(topup._id, 'failed')) ?? topup;
    }
    return topup; // still pending
  }

  /**
   * Idempotently mark a top-up paid and credit the owner's wallet, atomically.
   * Safe to call from a verify poll or a future payment webhook.
   */
  async completeTopup(topupId: string): Promise<ICreditTopup> {
    return transactionManager.runInTransaction(async (session) => {
      const topup = await CreditTopupModel.findById(topupId).session(session);
      if (!topup) {
        throw createAppError(ERROR_CODES.BILLING_TOPUP_NOT_FOUND, 404, 'Top-up not found');
      }
      if (topup.status === 'paid') return topup; // already completed

      topup.status = 'paid';
      await topup.save({ session });
      await this.wallet.creditInSession(
        topup.owner_type,
        topup.owner_id.toString(),
        topup.credits,
        'topup',
        'topup_purchase',
        topup._id.toString(),
        session
      );
      return topup;
    });
  }

  /**
   * Reverse a previously-paid top-up (charge-back / refund claw-back).
   *
   * Atomically flips `paid → reversed` and debits the granted credits back out of
   * the wallet. The debit is a FORCED movement (negative credit) — it may drive
   * the balance negative if the owner already spent the credits, which is the
   * correct outcome for a lost dispute. Idempotent: a top-up is only reversed once
   * (the atomic status claim guards concurrent webhook deliveries).
   */
  async reverseTopup(topupId: string, reason: 'chargeback' | 'refund' = 'chargeback'): Promise<ICreditTopup | null> {
    return transactionManager.runInTransaction(async (session) => {
      // Atomic claim: only a currently-`paid` top-up can be reversed, exactly once.
      const claimed = await CreditTopupModel.findOneAndUpdate(
        { _id: topupId, status: 'paid' },
        { $set: { status: 'reversed' } },
        { new: true, session }
      );
      if (!claimed) return null; // not paid / already reversed → no-op

      await this.wallet.creditInSession(
        claimed.owner_type,
        claimed.owner_id.toString(),
        -claimed.credits, // negative = forced claw-back, may go below zero
        'refund',
        'topup_reversal',
        claimed._id.toString(),
        session
      );
      console.log(`[CreditTopup] Reversed top-up ${claimed._id} (${reason}); clawed back ${claimed.credits} credits`);
      return claimed;
    });
  }

  /** Reverse a paid top-up located by its gateway PaymentIntent reference. Returns null if none matches. */
  async reverseByGatewayRef(gatewayRef: string, reason: 'chargeback' | 'refund' = 'chargeback'): Promise<ICreditTopup | null> {
    const topup = await CreditTopupModel.findOne({ gateway_ref: gatewayRef });
    if (!topup) return null;
    return this.reverseTopup(topup._id.toString(), reason);
  }

  /**
   * Find a top-up by the reference WE minted, so a mobile-money callback can
   * settle one.
   *
   * The `gateway_ref` fallback matters: the callback may beat
   * `initiateTopup`'s own `setStatus`, and it may also be for a row created
   * before `merchant_ref` existed.
   */
  async findByReference(merchantRef: string | null, gatewayRef: string): Promise<ICreditTopup | null> {
    if (merchantRef) {
      const byMerchant = await CreditTopupModel.findOne({ merchant_ref: merchantRef });
      if (byMerchant) return byMerchant;
    }
    return CreditTopupModel.findOne({ gateway_ref: gatewayRef });
  }

  /** Mark failed from a terminal callback. Never touches a row that already settled. */
  async failTopup(topupId: string): Promise<void> {
    await CreditTopupModel.updateOne({ _id: topupId, status: 'pending' }, { $set: { status: 'failed' } });
  }
}

export const creditTopupService = new CreditTopupService();
