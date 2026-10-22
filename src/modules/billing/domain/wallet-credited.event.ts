import { eventBus } from '../../../core/events/event-bus';
import { logger } from '../../../core/logging';
import type { BillingOwnerType } from '../billing.types';
import type { CreditReasonCode } from '../models/credit-transaction.model';

/**
 * `billing.wallet.credited` — a wallet's balance went UP (SERVICE-LISTINGS-PLAN § C-5, L-10).
 *
 * The listings module subscribes to it: a provider whose listings were suspended
 * `insufficient_credits` gets them back the moment a top-up, a plan allowance, an adjustment or
 * a refund brings the balance back to the first-reveal cost. Billing PUBLISHES and knows nothing
 * about listings — the same shape as `plan.activated` → plan-quota.
 *
 * ⛔ **Published after EVERY credit, by every path that credits.** `test:service-listings-billing`
 * enumerates every caller of the wallet's credit primitives and fails on one that does not
 * publish. A path that forgets is a provider who topped up and whose listings stay offline
 * until the nightly reconcile — paid for, and invisible.
 *
 * ⚠ **A nudge, never the guarantee.** The bus is in-process, unpersisted and swallows handler
 * errors, so durability comes from a reconcile pass on the listings side, exactly as plan-quota's
 * worker stands behind `plan.activated`. And it is **post-commit, fire-and-forget**: published
 * inside the transaction, a handler could resume listings for a credit that then rolled back.
 */
export const WALLET_CREDITED_EVENT = 'billing.wallet.credited' as const;

/** The payload, verbatim from § C-5. `balanceAfter` is the balance the credit produced. */
export interface WalletCreditedPayload {
  type: typeof WALLET_CREDITED_EVENT;
  ownerType: BillingOwnerType;
  ownerId: string;
  balanceAfter: number;
  reasonCode: CreditReasonCode;
}

/** The fields of a wallet the event is built from — an `ICreditWallet` satisfies it. */
export interface CreditedWalletShape {
  owner_type: BillingOwnerType;
  owner_id: { toString(): string };
  balance: number;
}

export function walletCreditedPayload(wallet: CreditedWalletShape, reasonCode: CreditReasonCode): WalletCreditedPayload {
  return {
    type: WALLET_CREDITED_EVENT,
    ownerType: wallet.owner_type,
    ownerId: wallet.owner_id.toString(),
    balanceAfter: wallet.balance,
    reasonCode,
  };
}

/**
 * Publish the nudge. Call it AFTER the transaction that credited the wallet has committed, with
 * the wallet document that transaction returned. Never throws, never awaits a handler.
 */
export function publishWalletCredited(wallet: CreditedWalletShape, reasonCode: CreditReasonCode): void {
  const payload = walletCreditedPayload(wallet, reasonCode);
  void eventBus
    .publish(WALLET_CREDITED_EVENT, {
      eventType: WALLET_CREDITED_EVENT,
      aggregateId: payload.ownerId,
      occurredAt: new Date(),
      payload: { ...payload },
    })
    .catch((err) =>
      logger().error({ err, ownerType: payload.ownerType, ownerId: payload.ownerId }, 'billing.wallet.credited publish failed'),
    );
}
