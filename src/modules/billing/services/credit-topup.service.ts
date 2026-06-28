import { Types } from 'mongoose';
import { transactionManager } from '../../../core/database/transaction.manager';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CreditTopupRepository } from '../repositories/credit-topup.repository';
import { CreditWalletService, creditWalletService } from './credit-wallet.service';
import { findCreditPack } from '../config/credit.config';
import { ICreditTopup, CreditTopupGateway } from '../models/credit-topup.model';
import { CreditTopupModel } from '../models/credit-topup.model';
import { PaymentGateway, PaymentChannelInfo } from '../../payments/gateways/gateway.interface';
import { NotchPayGateway } from '../../payments/gateways/notchpay.gateway';
import { MyCoolPayGateway } from '../../payments/gateways/mycoolpay.gateway';
import { StripeGateway } from '../../payments/gateways/stripe.gateway';

/**
 * CreditTopupService - vendor purchase of credit packs.
 *
 * Reuses the payments-module gateway adapters directly (they treat the order
 * reference as a plain label, so no Order/PaymentTransaction is involved).
 * Completion is idempotent and credits the wallet. Confirmation is driven by the
 * gateway's verify path (`verifyAndComplete`); a production webhook can later
 * call `completeTopup` directly without other changes.
 */
export class CreditTopupService {
  private readonly gateways: Map<CreditTopupGateway, PaymentGateway>;

  constructor(
    private readonly repo: CreditTopupRepository = new CreditTopupRepository(),
    private readonly wallet: CreditWalletService = creditWalletService
  ) {
    this.gateways = new Map<CreditTopupGateway, PaymentGateway>([
      ['NOTCHPAY', new NotchPayGateway()],
      ['MYCOOLPAY', new MyCoolPayGateway()],
      ['STRIPE', new StripeGateway()],
    ]);
  }

  /** Start a top-up: create a pending record and open a gateway charge. */
  async initiateTopup(
    vendorId: string,
    packCode: string,
    gateway: CreditTopupGateway,
    channel: PaymentChannelInfo
  ): Promise<{ topup: ICreditTopup; instructions: unknown }> {
    const pack = findCreditPack(packCode);
    if (!pack) {
      throw createAppError(ERROR_CODES.BILLING_TOPUP_PACK_NOT_FOUND, 404, `Unknown credit pack '${packCode}'`);
    }
    const adapter = this.gateways.get(gateway);
    if (!adapter) {
      throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, `Unsupported gateway '${gateway}'`);
    }

    const topup = await this.repo.create({
      vendor_id: new Types.ObjectId(vendorId),
      pack_code: pack.code,
      credits: pack.credits,
      price: pack.price,
      currency: pack.currency,
      status: 'pending',
      gateway,
    });

    const result = await adapter.initiatePayment({
      orderId: topup._id.toString(), // used by adapters only as a reference label
      userId: vendorId,
      amount: pack.price,
      currency: pack.currency,
      channel,
      metadata: { purpose: 'credit_topup', topupId: topup._id.toString() },
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
  async verifyAndComplete(vendorId: string, topupId: string): Promise<ICreditTopup> {
    const topup = await this.repo.findById(topupId);
    if (!topup || topup.vendor_id.toString() !== vendorId) {
      throw createAppError(ERROR_CODES.BILLING_TOPUP_NOT_FOUND, 404, 'Top-up not found');
    }
    if (topup.status === 'paid') return topup; // idempotent
    if (!topup.gateway || !topup.gateway_ref) {
      throw createAppError(ERROR_CODES.BILLING_TOPUP_INVALID_STATE, 409, 'Top-up has no gateway reference yet');
    }

    const adapter = this.gateways.get(topup.gateway)!;
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
   * Idempotently mark a top-up paid and credit the wallet, atomically.
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
        'vendor',
        topup.vendor_id.toString(),
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
   * Atomically flips `paid → reversed` and debits the granted credits back out
   * of the wallet. The debit is a FORCED movement (negative credit) — it may
   * drive the balance negative if the vendor already spent the credits, which is
   * the correct outcome for a lost dispute. Idempotent: a top-up is only
   * reversed once (the atomic status claim guards concurrent webhook deliveries).
   *
   * Note: this only undoes the internal credit grant. The customer's money is
   * returned by Stripe itself (the dispute/refund) — we do NOT call the refund API.
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
        'vendor',
        claimed.vendor_id.toString(),
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

}

export const creditTopupService = new CreditTopupService();
