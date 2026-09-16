import crypto from 'crypto';
import { Types } from 'mongoose';
import {
  PaymentTransactionModel,
  IPaymentTransaction,
  PaymentStatus,
  PaymentGatewayType
} from '../models/payment-transaction.model';
import { PaymentChannelInfo } from '../gateways/gateway.interface';
import { getPaymentGateway } from '../gateways/registry';
import { mintMerchantRef } from '../domain/merchant-reference';
import { NormalizedWebhookEvent } from '../domain/webhook-verification';
import { WebhookOutcome } from '../domain/webhook-response';
import { amountsEqual, currenciesEqual } from '../domain/money';
import { PAYMENTS_CONFIG } from '../config/payments.config';
import { OrderRepository } from '../../orders/order.repository';
import { OrderService } from '../../orders/order.service';
import { OrderModel } from '../../orders/order.model';
import { Booking, IBooking } from '../../booking/models/booking.model';
import { BookingCalendarSyncService } from '../../booking/services/booking-calendar-sync.service';

/**
 * What a refund is being issued against.
 *
 * Orders and bookings are the platform's two payable things, and they share one
 * refund pipeline (`PaymentOrchestratorService.refundPayment`) precisely so the
 * money invariants — refundable balance, gateway support, escrow reversal —
 * cannot be implemented twice and diverge.
 */
/**
 * What a new payment attempt must carry.
 *
 * The union is the model's own rule, lifted to compile time: `PaymentTransactionSchema`
 * refuses a row that does not have EXACTLY ONE of `orderId`, `bookingId` and `cartId`, and
 * refuses a cart row with no `orderIds`. That check runs in `pre('validate')`, so until this
 * type existed the only way to find out you had dropped the source field was to watch an
 * initiate fail at runtime — which is exactly how it was found.
 */
type NewPaymentAttempt = {
  userId: Types.ObjectId;
  gateway: PaymentGatewayType;
  method: 'MOBILE' | 'CARD' | 'CASH';
  status: PaymentStatus;
  gatewayRef: string;
  amountSnapshot: number;
  currencySnapshot: string;
  idempotencyKey: string;
  merchantRef: string;
  rawGatewayPayloads: unknown[];
  purpose?: 'primary' | 'booking_balance';
} & (
  | { orderId: Types.ObjectId }
  | { cartId: Types.ObjectId; orderIds: Types.ObjectId[] }
  | { bookingId: Types.ObjectId }
);

export type RefundSource =
  | { kind: 'order'; orderId: string }
  | { kind: 'booking'; bookingId: string };
import { RefundTransactionModel } from '../models/refund-transaction.model';
import { createAppError, AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { eventBus } from '../../../core/events/event-bus';
import { transactionManager } from '../../../core/database/transaction.manager';
import { earningsSplitService } from '../../earnings/services/earnings-split.service';
import { earningsRefundService } from '../../earnings/services/earnings-refund.service';

/**
 * PaymentOrchestratorService - Gateway-agnostic payment orchestration
 * 
 * RESPONSIBILITIES:
 * - Gateway selection and routing
 * - Idempotency enforcement
 * - Payment state management
 * - Order state transitions
 * - Fulfillment triggering
 * 
 * GUARANTEES:
 * - Idempotent payment initiation (hash-based deduplication)
 * - Safe webhook retries (payload hash deduplication)
 * - No payment without valid order
 * - No duplicate charges
 * - Atomic state transitions
 * 
 * MENTAL MODEL:
 * This is a state machine orchestrator, not a random service.
 */
export class PaymentOrchestratorService {
  private orderRepo: OrderRepository;
  private orderService: OrderService;
  private calendarSync: BookingCalendarSyncService;

  constructor() {
    this.orderRepo = new OrderRepository();
    this.orderService = new OrderService();
    this.calendarSync = new BookingCalendarSyncService();
    // Gateways come from the shared registry (`gateways/registry.ts`). This
    // class used to build its own three-entry Map, and so did CreditTopupService
    // and PlanPurchaseService — three copies of one lookup table, free to drift.
  }

  /**
   * Initiate payment for an order
   * 
   * IDEMPOTENT: Multiple calls with same orderId return existing transaction
   * 
   * FLOW:
   * 1. Load and validate order
   * 2. Generate idempotency key
   * 3. Check for existing payment transaction
   * 4. If exists and completed, return success
   * 5. If exists and pending, return existing session
   * 6. Create new transaction
   * 7. Call gateway
   * 8. Update transaction with gateway response
   * 9. Return payment instructions
   * 
   * @param orderId - Order to pay for
   * @param gateway - Which gateway to use
   * @param channel - Payment channel info (phone, card, etc.)
   * @returns Payment instructions or existing transaction
   */
  async initiatePayment(
    orderId: string,
    gateway: PaymentGatewayType,
    channel: PaymentChannelInfo
  ): Promise<{
    transactionId: string;
    status: PaymentStatus;
    instructions?: any;
    message: string;
  }> {
    // 1. LOAD AND VALIDATE ORDER
    const order = await this.orderRepo.findById(orderId);

    if (!order) {
      throw createAppError(ERROR_CODES.PAYMENT_ORDER_NOT_FOUND, 404);
    }

    // Validate order belongs to customer (assuming userId from channel or context)
    // In production, get userId from authenticated session
    const userId = order.customer_id.toString();

    // COD orders are paid in cash at handoff (see src/modules/cod/) — they
    // never go through a gateway.
    if (order.payment_method === 'cash_on_delivery') {
      throw createAppError(ERROR_CODES.PAYMENT_ORDER_IS_COD, 422, 'This order is cash on delivery — no online payment is required');
    }

    // Validate order status
    if (order.payment_status === 'paid') {
      throw createAppError(ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID, 409);
    }

    if (order.payment_status !== 'AWAITING_PAYMENT' && order.payment_status !== 'pending') {
      throw createAppError(ERROR_CODES.PAYMENT_INVALID_ORDER_STATUS, 400, undefined, { status: order.payment_status });
    }

    // 2. GENERATE IDEMPOTENCY KEY
    const idempotencyKey = this.generateIdempotencyKey(orderId, userId, order.total_amount);

    // 3. CHECK FOR EXISTING TRANSACTION
    // One shape for every "you already have this payment" answer in this method. The
    // dead-attempt check, the live-attempt guard and the lost create race all mean the
    // same thing to a caller, and all three are reachable from one impatient customer
    // pressing Pay repeatedly.
    const respondWithExisting = (tx: IPaymentTransaction) => ({
      transactionId: tx._id.toString(),
      status: tx.status,
      instructions: this.lastInstructions(tx),
      message: tx.status === 'SUCCEEDED'
        ? 'Payment already completed'
        : 'Payment already initiated. Complete the pending payment.'
    });

    const existingTx = await PaymentTransactionModel.findOne({ idempotencyKey });

    if (existingTx) {
      // Already completed
      if (existingTx.status === 'SUCCEEDED') {
        return {
          transactionId: existingTx._id.toString(),
          status: existingTx.status,
          message: 'Payment already completed'
        };
      }

      // Already initiated/pending - return existing session
      if (existingTx.status === 'INITIATED' || existingTx.status === 'PENDING') {
        return respondWithExisting(existingTx);
      }

      // Failed/cancelled → this is a NEW attempt, and it needs the key the dead one holds.
      // Only once we KNOW it is dead, though: `FAILED` is written for a refusal AND for a
      // call that merely errored, and a live charge can be sitting behind the second kind.
      const settledAttempt = await this.releaseDeadAttempt(existingTx);
      if (settledAttempt) return respondWithExisting(settledAttempt);
    }

    // 4. CREATE NEW PAYMENT TRANSACTION
    const gatewayInstance = getPaymentGateway(gateway);

    // Determine payment method
    const method = gateway === 'STRIPE' ? 'CARD' : 'MOBILE';

    // Create transaction in INITIATED state
    // A second LIVE charge over money that already has one — the hole the idempotency key
    // cannot see, because that key is (source, user, AMOUNT) while this asks about the money
    // itself. Two routes reach the same order (the cart path and the single-order path), and
    // a group total moves when one order in it settles or is cancelled, so one customer can
    // compute two different keys over overlapping orders and open two charges that nothing
    // links. Answered with the live attempt rather than an error: from the customer's side
    // this IS their payment, and the prompt is already on their phone.
    const liveElsewhere = await this.findLiveAttempt({
      $or: [
        { orderId: new Types.ObjectId(orderId) },
        { orderIds: new Types.ObjectId(orderId) }
      ]
    });
    if (liveElsewhere) return respondWithExisting(liveElsewhere);

    const attempt = await this.openAttempt({
      orderId: new Types.ObjectId(orderId),
      userId: new Types.ObjectId(userId),
      gateway,
      method,
      status: 'INITIATED',
      gatewayRef: '', // Will be updated after gateway call
      amountSnapshot: order.total_amount,
      currencySnapshot: order.currency,
      idempotencyKey,
      merchantRef: mintMerchantRef('pt'),
      rawGatewayPayloads: []
    }, idempotencyKey);
    if ('raced' in attempt) return respondWithExisting(attempt.raced);
    const transaction = attempt.opened;

    // 5. CALL GATEWAY
    try {
      const gatewayResult = await gatewayInstance.initiatePayment({
        orderId,
        userId,
        amount: order.total_amount,
        currency: order.currency,
        channel,
        merchantRef: transaction.merchantRef!,
        metadata: { idempotencyKey, merchantRef: transaction.merchantRef }
      });

      // 6. UPDATE TRANSACTION WITH GATEWAY RESPONSE
      transaction.gatewayRef = gatewayResult.gatewayRef;
      transaction.status = gatewayResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'initiate',
        ...gatewayResult.rawResponse,
        instructions: gatewayResult.instructions ?? null
      });

      // Compute payload hash for webhook deduplication
      transaction.gatewayPayloadHash = this.hashPayload(gatewayResult.rawResponse);

      await transaction.save();

      // 7. UPDATE ORDER STATUS — only if the gateway actually took the charge.
      //
      // ⚠ This used to advance unconditionally, and the failure mode is the one a
      // shopper reports as "the app said it was waiting for my payment and my phone
      // never rang". A refused initiation (bad credentials, an operator the gateway
      // will not route, a provider 4xx) returns `success: false` here, and marking
      // the order AWAITING_PAYMENT then states as fact something no gateway is
      // waiting for — so nothing ever arrives and nothing ever times it out.
      //
      // `pending` is the honest answer, and it costs the customer nothing: it is
      // equally payable (`initiatePayment` and `initiatePaymentForCart` both accept
      // `pending` and `AWAITING_PAYMENT`), so the retry path is untouched.
      //
      // Deliberately NOT written as `failed`: only `cancelOrder` writes that, and a
      // declined attempt that poisoned the order would make every retry impossible —
      // see the storefront's own note in the order-detail requirements.
      if (order.payment_status === 'pending' && gatewayResult.success) {
        order.payment_status = 'AWAITING_PAYMENT';
        await order.save();
      }

      // 8. RETURN PAYMENT INSTRUCTIONS
      return {
        transactionId: transaction._id.toString(),
        status: transaction.status,
        instructions: gatewayResult.instructions,
        message: gatewayResult.success
          ? 'Payment initiated successfully'
          : gatewayResult.error || 'Payment initiation failed'
      };

    } catch (error: any) {
      // Update transaction to failed
      await this.recordFailedAttempt(transaction, error);

      throw createAppError(ERROR_CODES.PAYMENT_INITIATION_FAILED, 502, undefined, { cause: error.message });
    }
  }

  /**
   * Initiate a SINGLE payment for a whole checkout group (multi-vendor cart).
   *
   * A cart splits into one order per vendor sharing a `cart_id`. The customer
   * pays once for the group total; on success the webhook fans settlement out to
   * every order (each runs its own earnings split, fulfilment and events).
   *
   * IDEMPOTENT: keyed by hash(cartId + userId + groupTotal) — repeated calls
   * return the existing transaction.
   *
   * @param cartId - Checkout group id (cart_id shared by the split orders)
   * @param gateway - Which gateway to use
   * @param channel - Payment channel info (phone, card, etc.)
   */
  async initiatePaymentForCart(
    cartId: string,
    gateway: PaymentGatewayType,
    channel: PaymentChannelInfo
  ): Promise<{
    transactionId: string;
    status: PaymentStatus;
    instructions?: any;
    message: string;
  }> {
    // 1. LOAD THE GROUP'S ORDERS
    const orders = await OrderModel.find({ cart_id: cartId });
    if (orders.length === 0) {
      throw createAppError(ERROR_CODES.PAYMENT_CART_NOT_FOUND, 404, undefined, { cartId });
    }

    // The payment method is chosen for the WHOLE checkout group — a COD group
    // is paid in cash at handoff (see src/modules/cod/), never via a gateway.
    if (orders.some(o => o.payment_method === 'cash_on_delivery')) {
      throw createAppError(ERROR_CODES.PAYMENT_ORDER_IS_COD, 422, 'This checkout is cash on delivery — no online payment is required', { cartId });
    }

    // All orders already paid → nothing to do
    if (orders.every(o => o.payment_status === 'paid')) {
      throw createAppError(ERROR_CODES.PAYMENT_ORDER_ALREADY_PAID, 409, undefined, { cartId });
    }

    // Payable = still awaiting payment (never re-charge a paid order)
    const payable = orders.filter(
      o => o.payment_status === 'AWAITING_PAYMENT' || o.payment_status === 'pending'
    );
    if (payable.length === 0) {
      throw createAppError(ERROR_CODES.PAYMENT_CART_NO_PAYABLE_ORDERS, 409, undefined, { cartId });
    }

    // Single currency across the group (guaranteed at checkout, re-checked here)
    const currencies = [...new Set(payable.map(o => o.currency))];
    if (currencies.length > 1) {
      throw createAppError(ERROR_CODES.PAYMENT_CART_MIXED_CURRENCY, 400, undefined, { cartId, currencies });
    }
    const currency = currencies[0];

    const userId = payable[0].customer_id.toString();
    const groupTotal = payable.reduce((sum, o) => sum + o.total_amount, 0);
    const orderIds = payable.map(o => o._id);

    // 2. IDEMPOTENCY KEY (cartId stands in for orderId)
    const idempotencyKey = this.generateIdempotencyKey(cartId, userId, groupTotal);

    // 3. CHECK FOR EXISTING TRANSACTION
    // One shape for every "you already have this payment" answer in this method. The
    // dead-attempt check, the live-attempt guard and the lost create race all mean the
    // same thing to a caller, and all three are reachable from one impatient customer
    // pressing Pay repeatedly.
    const respondWithExisting = (tx: IPaymentTransaction) => ({
      transactionId: tx._id.toString(),
      status: tx.status,
      instructions: this.lastInstructions(tx),
      message: tx.status === 'SUCCEEDED'
        ? 'Payment already completed'
        : 'Payment already initiated. Complete the pending payment.'
    });

    const existingTx = await PaymentTransactionModel.findOne({ idempotencyKey });
    if (existingTx) {
      if (existingTx.status === 'SUCCEEDED') {
        return {
          transactionId: existingTx._id.toString(),
          status: existingTx.status,
          message: 'Payment already completed'
        };
      }
      if (existingTx.status === 'INITIATED' || existingTx.status === 'PENDING') {
        return respondWithExisting(existingTx);
      }
      // Failed/cancelled → this is a NEW attempt, and it needs the key the dead one holds.
      // Only once we KNOW it is dead, though: `FAILED` is written for a refusal AND for a
      // call that merely errored, and a live charge can be sitting behind the second kind.
      const settledAttempt = await this.releaseDeadAttempt(existingTx);
      if (settledAttempt) return respondWithExisting(settledAttempt);
    }

    // 4. CREATE NEW PAYMENT TRANSACTION (group)
    const gatewayInstance = getPaymentGateway(gateway);

    const method = gateway === 'STRIPE' ? 'CARD' : 'MOBILE';

    // A second LIVE charge over money that already has one — the hole the idempotency key
    // cannot see, because that key is (source, user, AMOUNT) while this asks about the money
    // itself. Two routes reach the same order (the cart path and the single-order path), and
    // a group total moves when one order in it settles or is cancelled, so one customer can
    // compute two different keys over overlapping orders and open two charges that nothing
    // links. Answered with the live attempt rather than an error: from the customer's side
    // this IS their payment, and the prompt is already on their phone.
    const liveElsewhere = await this.findLiveAttempt({
      $or: [
        { cartId: new Types.ObjectId(cartId) },
        { orderId: { $in: orderIds } },
        { orderIds: { $in: orderIds } }
      ]
    });
    if (liveElsewhere) return respondWithExisting(liveElsewhere);

    const attempt = await this.openAttempt({
      cartId: new Types.ObjectId(cartId),
      orderIds,
      userId: new Types.ObjectId(userId),
      gateway,
      method,
      status: 'INITIATED',
      gatewayRef: '',
      amountSnapshot: groupTotal,
      currencySnapshot: currency,
      idempotencyKey,
      merchantRef: mintMerchantRef('pt'),
      rawGatewayPayloads: []
    }, idempotencyKey);
    if ('raced' in attempt) return respondWithExisting(attempt.raced);
    const transaction = attempt.opened;

    // 5. CALL GATEWAY ONCE for the group total (cartId is the external reference)
    try {
      const gatewayResult = await gatewayInstance.initiatePayment({
        orderId: cartId,
        userId,
        amount: groupTotal,
        currency,
        channel,
        merchantRef: transaction.merchantRef!,
        metadata: { idempotencyKey, cartId, merchantRef: transaction.merchantRef }
      });

      transaction.gatewayRef = gatewayResult.gatewayRef;
      transaction.status = gatewayResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'initiate',
        ...gatewayResult.rawResponse,
        instructions: gatewayResult.instructions ?? null
      });
      transaction.gatewayPayloadHash = this.hashPayload(gatewayResult.rawResponse);
      await transaction.save();

      return {
        transactionId: transaction._id.toString(),
        status: transaction.status,
        instructions: gatewayResult.instructions,
        message: gatewayResult.success
          ? 'Payment initiated successfully'
          : gatewayResult.error || 'Payment initiation failed'
      };
    } catch (error: any) {
      await this.recordFailedAttempt(transaction, error);

      throw createAppError(ERROR_CODES.PAYMENT_INITIATION_FAILED, 502, undefined, { cause: error.message });
    }
  }

  /**
   * Refund a paid ORDER or BOOKING (full or partial).
   *
   * Eligibility (the vendor's return policy, a booking's cancellation policy) is
   * the CALLER's responsibility — see `VendorRefundService` and
   * `BookingRefundService`. This method enforces the money invariants and
   * orchestrates the gateway call + persistence:
   *
   * 1. Resolve the SUCCEEDED PaymentTransaction for the source.
   * 2. Validate the requested amount against the remaining refundable balance.
   * 3. Create a pending RefundTransaction.
   * 4. Call the gateway's refund API (outside any DB transaction).
   * 5. On success: atomically finalize the refund, bump totalRefunded /
   *    hasPartialRefund, flip the payment + source status to refunded when fully
   *    refunded. On failure: mark the refund failed and throw.
   *
   * The two sources differ in exactly four places — the payment lookup, the
   * RefundTransaction's foreign key, the source-status write, and which earnings
   * reversal runs. Everything else is shared, deliberately: forking this into a
   * parallel booking implementation is how the two would drift on the money rules.
   *
   * @returns A summary of the refund outcome.
   */
  async refundPayment(params: {
    source: RefundSource;
    vendorId: string;
    initiatedBy: string;   // the acting user's id
    initiatedByRole?: 'vendor' | 'admin' | 'customer';
    amount: number;        // amount to refund (already resolved by caller)
    reason?: string;
  }): Promise<{
    refundId: string;
    status: 'completed' | 'failed';
    amount: number;
    currency: string;
    totalRefunded: number;
    fullyRefunded: boolean;
  }> {
    const { source, vendorId, initiatedBy, amount, reason } = params;
    const initiatedByRole = params.initiatedByRole ?? 'vendor';
    const isBooking = source.kind === 'booking';
    const sourceId = isBooking ? source.bookingId : source.orderId;

    // 1. Resolve the successful payment for this source.
    //
    // `orderIds` as well as `orderId`: a CART checkout writes ONE payment for N orders
    // (`cartId` + `orderIds[]`, and never `orderId` — the model's pre-save hook enforces
    // exactly one source field). Matching on `orderId` alone therefore found nothing for
    // the entire cart-checkout population, so every such order — the overwhelming majority
    // — answered `REFUND_PAYMENT_NOT_FOUND` on the vendor's own refund endpoint.
    const paymentTx = await PaymentTransactionModel.findOne({
      ...(isBooking
        ? { bookingId: new Types.ObjectId(sourceId) }
        : { $or: [{ orderId: new Types.ObjectId(sourceId) }, { orderIds: new Types.ObjectId(sourceId) }] }),
      status: 'SUCCEEDED'
    });
    if (!paymentTx) {
      throw createAppError(ERROR_CODES.REFUND_PAYMENT_NOT_FOUND, 404);
    }

    // 2. Validate the amount against the remaining refundable balance FOR THIS SOURCE.
    //
    // On a group payment the payment's own balance is the WHOLE CART's, so validating
    // against it alone would let one vendor's refund be paid out of another vendor's
    // customer's money. `refundableCeilingFor` narrows it to this order's own share; on a
    // single-source payment the two are identical, which is why nothing noticed.
    const ceiling = await this.refundableCeilingFor(paymentTx, sourceId, isBooking);

    if (paymentTx.amountSnapshot - paymentTx.totalRefunded <= 0 || ceiling.remaining <= 0) {
      throw createAppError(ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED, 409);
    }
    if (amount <= 0 || amount > ceiling.remaining) {
      throw createAppError(ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX, 400, undefined, {
        requested: amount,
        remaining: ceiling.remaining,
        ...(ceiling.isGrouped ? { scope: 'order', groupPaymentId: paymentTx._id.toString() } : {})
      });
    }

    // 3. Resolve the gateway adapter. Not all providers have a refund API, and
    //    the ABSENCE of the method is how that is expressed — see the header of
    //    `MyCoolPayGateway`. This guard was previously dead: both mobile
    //    gateways defined a `refundPayment` that always failed, so the code
    //    actually raised was `REFUND_GATEWAY_FAILED` while the api-doc and
    //    `AdminRefundService` both promised `REFUND_GATEWAY_NOT_SUPPORTED`.
    const gatewayInstance = getPaymentGateway(paymentTx.gateway);
    if (typeof gatewayInstance.refundPayment !== 'function') {
      throw createAppError(ERROR_CODES.REFUND_GATEWAY_NOT_SUPPORTED, 400, undefined, {
        gateway: paymentTx.gateway
      });
    }

    // 4. Create the refund record in 'pending' state (audit trail before gateway call).
    const refund = await RefundTransactionModel.create({
      paymentTransactionId: paymentTx._id,
      ...(isBooking
        ? { bookingId: new Types.ObjectId(sourceId) }
        : { orderId: new Types.ObjectId(sourceId) }),
      vendorId: new Types.ObjectId(vendorId),
      userId: paymentTx.userId,
      refundAmount: amount,
      currency: paymentTx.currencySnapshot,
      reason,
      status: 'pending',
      gateway: paymentTx.gateway,
      initiatedBy: new Types.ObjectId(initiatedBy),
      initiatedByRole
    });

    // 5. Call the gateway (external; kept outside the DB transaction).
    const gatewayResult = await gatewayInstance.refundPayment({
      gatewayRef: paymentTx.gatewayRef,
      amount,
      // The currency the original charge was recorded in. It used to travel
      // inside `metadata` and Stripe read it as `metadata.currency ?? 'xaf'`,
      // which is a default in the one operation where a wrong currency means a
      // wrong refund amount.
      currency: paymentTx.currencySnapshot,
      reason,
      metadata: {
        [isBooking ? 'bookingId' : 'orderId']: sourceId,
        vendorId,
        refundId: refund._id.toString()
      }
    });

    if (!gatewayResult.success) {
      refund.status = 'failed';
      await refund.save();

      // A provider that WON'T refund is a different answer from one that
      // COULDN'T. `REFUND_GATEWAY_NOT_SUPPORTED` is categorised `business_rule`
      // and is documented as an expected outcome, so `BookingRefundService`
      // routes it to the manual-payout ticket instead of treating it as an
      // outage — which is where this money genuinely has to go.
      if (gatewayResult.unsupported) {
        throw createAppError(ERROR_CODES.REFUND_GATEWAY_NOT_SUPPORTED, 400, undefined, {
          gateway: paymentTx.gateway,
          reason: gatewayResult.error
        });
      }

      throw createAppError(ERROR_CODES.REFUND_GATEWAY_FAILED, 502, undefined, {
        error: gatewayResult.error
      });
    }

    // 6. Finalize atomically: refund record + payment totals + order status.
    //
    // TWO booleans, because a group payment makes them different questions:
    //
    //   sourceFullyRefunded  — is THIS order/booking square? Drives the source's own
    //                          payment_status and the escrow reversal.
    //   paymentFullyRefunded — is the whole PAYMENT exhausted? Drives the gateway
    //                          transaction's status.
    //
    // On a single-source payment they are always equal. On a two-vendor cart, refunding
    // one order fully must unwind that order and its earnings while leaving the payment
    // `SUCCEEDED` with a balance for the other. Using one boolean for both meant a
    // refunded order kept `payment_status: 'paid'` and its vendor kept the money.
    const newTotalRefunded = paymentTx.totalRefunded + amount;
    const paymentFullyRefunded = newTotalRefunded >= paymentTx.amountSnapshot;
    const sourceFullyRefunded = ceiling.alreadyRefunded + amount >= ceiling.sourceTotal;

    await transactionManager.runInTransaction(async (session) => {
      refund.status = 'completed';
      refund.completedAt = new Date();
      refund.gatewayRefundRef = gatewayResult.refundRef;
      await refund.save({ session });

      paymentTx.totalRefunded = newTotalRefunded;
      paymentTx.hasPartialRefund = !paymentFullyRefunded && newTotalRefunded > 0;
      if (paymentFullyRefunded) {
        paymentTx.status = 'REFUNDED';
      }
      await paymentTx.save({ session });

      // The source's payment status only flips to 'refunded' on a FULL refund —
      // a partial refund leaves it paid, with the balance tracked on the payment.
      if (sourceFullyRefunded) {
        if (isBooking) {
          await Booking.updateOne(
            { _id: new Types.ObjectId(sourceId) },
            { $set: { paymentStatus: 'refunded' } },
            { session }
          );
        } else {
          await OrderModel.updateOne(
            { _id: new Types.ObjectId(sourceId) },
            { $set: { payment_status: 'refunded', updated_at: new Date() } },
            { session }
          );
        }
      }
    });

    // On a full refund of THIS source, reverse its still-held earnings out of escrow.
    // Best-effort: a failure must not fail the (already-completed) refund.
    if (sourceFullyRefunded) {
      try {
        if (isBooking) {
          await earningsRefundService.onRefund('booking', sourceId);
        } else {
          await earningsRefundService.onOrderRefund(sourceId);
        }
      } catch (error) {
        console.error('[PaymentOrchestrator] Failed to reverse earnings on refund:', error);
      }
    }

    // 7. Emit a domain event (fire-and-forget).
    eventBus.publish('payment.refunded', {
      eventType: 'payment.refunded',
      aggregateId: sourceId,
      payload: {
        ...(isBooking ? { bookingId: sourceId } : { orderId: sourceId }),
        sourceKind: source.kind,
        vendorId,
        refundId: refund._id.toString(),
        amount,
        currency: paymentTx.currencySnapshot,
        // The SOURCE's verdict — subscribers act on the order/booking, not on the cart.
        fullyRefunded: sourceFullyRefunded
      },
      occurredAt: new Date()
    }).catch(() => { /* non-blocking */ });

    return {
      refundId: refund._id.toString(),
      status: 'completed',
      amount,
      currency: paymentTx.currencySnapshot,
      totalRefunded: newTotalRefunded,
      fullyRefunded: sourceFullyRefunded
    };
  }

  /**
   * How much of a payment may still be refunded AGAINST ONE SOURCE.
   *
   * ── Why this is not just `amountSnapshot - totalRefunded` ─────────────────
   * A cart checkout settles N orders with ONE payment (`cartId` + `orderIds[]`), so the
   * payment's own balance is the whole cart's. Validating a single order's refund against
   * it would let one vendor's refund be paid out of another vendor's customer's money —
   * and would let the sum of per-order refunds exceed what any one customer was charged
   * for that order. The ceiling has to be the order's own share.
   *
   * `alreadyRefunded` is tallied from COMPLETED refunds carrying this order's id.
   * Deliberately not from a counter on the order: `refund_transactions` is the ledger, it
   * is indexed on `orderId`, and a second counter is a second thing to keep in step.
   *
   * On a single-source payment (`orderId`/`bookingId` set) the source total IS the payment
   * snapshot, so this returns exactly what the old arithmetic did. That equivalence is
   * what makes the change safe for every path that already worked.
   */
  private async refundableCeilingFor(
    paymentTx: IPaymentTransaction,
    sourceId: string,
    isBooking: boolean
  ): Promise<{ remaining: number; alreadyRefunded: number; sourceTotal: number; isGrouped: boolean }> {
    const isGrouped = !isBooking && !paymentTx.orderId && (paymentTx.orderIds?.length ?? 0) > 0;

    if (!isGrouped) {
      return {
        remaining: paymentTx.amountSnapshot - paymentTx.totalRefunded,
        alreadyRefunded: paymentTx.totalRefunded,
        sourceTotal: paymentTx.amountSnapshot,
        isGrouped: false
      };
    }

    const order = await OrderModel.findById(sourceId).select('total_amount').lean().exec();
    if (!order) {
      throw createAppError(ERROR_CODES.REFUND_ORDER_NOT_FOUND, 404, undefined, { orderId: sourceId });
    }

    const [tally] = await RefundTransactionModel.aggregate<{ total: number }>([
      { $match: { orderId: new Types.ObjectId(sourceId), status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$refundAmount' } } }
    ]);
    const alreadyRefunded = tally?.total ?? 0;
    const sourceTotal = (order as { total_amount: number }).total_amount;

    return {
      // Never more than the payment itself still has — the group balance remains a hard
      // upper bound, so a data inconsistency can only narrow the ceiling, never widen it.
      remaining: Math.min(sourceTotal - alreadyRefunded, paymentTx.amountSnapshot - paymentTx.totalRefunded),
      alreadyRefunded,
      sourceTotal,
      isGrouped: true
    };
  }

  /**
   * Initiate payment for a booking
   * 
   * IDEMPOTENT: Multiple calls with same bookingId return existing transaction
   * 
   * USER REFINEMENTS APPLIED:
   * - Sets paymentMethod early ('online')
   * - Rejects if paymentStatus === 'pending' (safety lock)
   * - Auto-paid free bookings handled by Booking model pre-save hook
   * 
   * FLOW:
   * 1. Load and validate booking
   * 2. Validate payment eligibility
   * 3. Generate idempotency key
   * 4. Check for existing payment transaction
   * 5. Create new transaction
   * 6. Call gateway
   * 7. Update booking status to 'pending' and set paymentMethod
   * 8. Update calendar event
   * 9. Return payment instructions
   * 
   * @param bookingId - Booking to pay for
   * @param gateway - Which gateway to use
   * @param channel - Payment channel info (phone, card, etc.)
   * @returns Payment instructions or existing transaction
   */
  async initiateBookingPayment(
    bookingId: string,
    gateway: PaymentGatewayType,
    channel: PaymentChannelInfo
  ): Promise<{
    transactionId: string;
    status: PaymentStatus;
    instructions?: any;
    message: string;
  }> {
    // 1. LOAD AND VALIDATE BOOKING
    const booking = await Booking.findById(bookingId);

    if (!booking) {
      throw createAppError(ERROR_CODES.PAYMENT_BOOKING_NOT_FOUND, 404);
    }

    // 2. VALIDATE PAYMENT ELIGIBILITY

    // Check if cancelled
    if (booking.status === 'cancelled') {
      throw createAppError(ERROR_CODES.PAYMENT_BOOKING_CANCELLED, 400);
    }

    // Check if payment is required
    if (!booking.requiresPayment) {
      throw createAppError(ERROR_CODES.PAYMENT_BOOKING_NO_PAYMENT_REQUIRED, 400);
    }

    // Check if already paid
    if (booking.paymentStatus === 'paid') {
      throw createAppError(ERROR_CODES.PAYMENT_BOOKING_ALREADY_PAID, 409);
    }

    // USER REFINEMENT: Safety lock - reject if pending
    if (booking.paymentStatus === 'pending') {
      throw createAppError(ERROR_CODES.PAYMENT_BOOKING_IN_PROGRESS, 409);
    }

    const userId = booking.userId.toString();

    // 3. GENERATE IDEMPOTENCY KEY
    const idempotencyKey = this.generateIdempotencyKey(
      bookingId,
      userId,
      booking.priceSnapshot
    );

    // 4. CHECK FOR EXISTING TRANSACTION
    // One shape for every "you already have this payment" answer in this method. The
    // dead-attempt check, the live-attempt guard and the lost create race all mean the
    // same thing to a caller, and all three are reachable from one impatient customer
    // pressing Pay repeatedly.
    const respondWithExisting = (tx: IPaymentTransaction) => ({
      transactionId: tx._id.toString(),
      status: tx.status,
      instructions: this.lastInstructions(tx),
      message: tx.status === 'SUCCEEDED'
        ? 'Payment already completed'
        : 'Payment already initiated. Complete the pending payment.'
    });

    const existingTx = await PaymentTransactionModel.findOne({ idempotencyKey });

    if (existingTx) {
      // Already completed
      if (existingTx.status === 'SUCCEEDED') {
        return {
          transactionId: existingTx._id.toString(),
          status: existingTx.status,
          message: 'Payment already completed'
        };
      }

      // Already initiated/pending - return existing session
      if (existingTx.status === 'INITIATED' || existingTx.status === 'PENDING') {
        return respondWithExisting(existingTx);
      }

      // Failed/cancelled → this is a NEW attempt, and it needs the key the dead one holds.
      // Only once we KNOW it is dead, though: `FAILED` is written for a refusal AND for a
      // call that merely errored, and a live charge can be sitting behind the second kind.
      const settledAttempt = await this.releaseDeadAttempt(existingTx);
      if (settledAttempt) return respondWithExisting(settledAttempt);
    }

    // 5. CREATE NEW PAYMENT TRANSACTION
    const gatewayInstance = getPaymentGateway(gateway);

    // Determine payment method
    const method = gateway === 'STRIPE' ? 'CARD' : 'MOBILE';

    // Create transaction in INITIATED state
    // A second LIVE charge over money that already has one — the hole the idempotency key
    // cannot see, because that key is (source, user, AMOUNT) while this asks about the money
    // itself. Two routes reach the same order (the cart path and the single-order path), and
    // a group total moves when one order in it settles or is cancelled, so one customer can
    // compute two different keys over overlapping orders and open two charges that nothing
    // links. Answered with the live attempt rather than an error: from the customer's side
    // this IS their payment, and the prompt is already on their phone.
    const liveElsewhere = await this.findLiveAttempt({
      bookingId: new Types.ObjectId(bookingId),
      purpose: 'primary'
    });
    if (liveElsewhere) return respondWithExisting(liveElsewhere);

    const attempt = await this.openAttempt({
      bookingId: new Types.ObjectId(bookingId),
      userId: new Types.ObjectId(userId),
      gateway,
      method,
      status: 'INITIATED',
      gatewayRef: '', // Will be updated after gateway call
      amountSnapshot: booking.priceSnapshot,
      currencySnapshot: booking.currency,
      idempotencyKey,
      merchantRef: mintMerchantRef('pt'),
      rawGatewayPayloads: []
    }, idempotencyKey);
    if ('raced' in attempt) return respondWithExisting(attempt.raced);
    const transaction = attempt.opened;

    // 6. CALL GATEWAY
    try {
      const gatewayResult = await gatewayInstance.initiatePayment({
        orderId: bookingId, // Gateway uses this as reference ID
        userId,
        amount: booking.priceSnapshot,
        currency: booking.currency,
        channel,
        merchantRef: transaction.merchantRef!,
        metadata: { idempotencyKey, bookingId, merchantRef: transaction.merchantRef }
      });

      // 7. UPDATE TRANSACTION WITH GATEWAY RESPONSE
      transaction.gatewayRef = gatewayResult.gatewayRef;
      transaction.status = gatewayResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'initiate',
        ...gatewayResult.rawResponse,
        instructions: gatewayResult.instructions ?? null
      });

      // Compute payload hash for webhook deduplication
      transaction.gatewayPayloadHash = this.hashPayload(gatewayResult.rawResponse);

      await transaction.save();

      // 8. UPDATE BOOKING STATUS
      // USER REFINEMENT: Set paymentMethod early
      booking.paymentStatus = 'pending';
      booking.paymentMethod = 'online';
      await booking.save();

      // 9. UPDATE CALENDAR EVENT
      await this.calendarSync.syncBookingPaymentStatus(booking);

      // 10. RETURN PAYMENT INSTRUCTIONS
      return {
        transactionId: transaction._id.toString(),
        status: transaction.status,
        instructions: gatewayResult.instructions,
        message: gatewayResult.success
          ? 'Payment initiated successfully'
          : gatewayResult.error || 'Payment initiation failed'
      };

    } catch (error: any) {
      // Update transaction to failed
      await this.recordFailedAttempt(transaction, error);

      // Update booking payment status
      booking.paymentStatus = 'failed';
      await booking.save();

      throw createAppError(ERROR_CODES.PAYMENT_INITIATION_FAILED, 502, undefined, { cause: error.message });
    }
  }

  /**
   * Initiate payment for a booking's OUTSTANDING BALANCE.
   *
   * A booking can be paid twice — once for the quoted price, and again for what a
   * longer-than-booked service actually cost. This is the second payment.
   *
   * It is deliberately a separate method from `initiateBookingPayment` rather than
   * a flag on it, because almost every guard inverts: that one refuses a `paid`
   * booking, this one REQUIRES it; that one charges `priceSnapshot`, this one
   * charges `settlement.balanceDue`. Folding them together would produce a method
   * where half the checks apply.
   *
   * The resulting transaction carries `purpose: 'booking_balance'`, which is what
   * lets the webhook credit the balance instead of no-oping on an already-paid
   * booking.
   */
  async initiateBookingBalancePayment(
    bookingId: string,
    gateway: PaymentGatewayType,
    channel: PaymentChannelInfo
  ): Promise<{
    transactionId: string;
    status: PaymentStatus;
    amount: number;
    currency: string;
    instructions?: any;
    message: string;
  }> {
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      throw createAppError(ERROR_CODES.PAYMENT_BOOKING_NOT_FOUND, 404);
    }

    // A balance only exists once the vendor has settled the appointment.
    if (booking.status !== 'completed') {
      throw createAppError(ERROR_CODES.BOOKING_NOT_COMPLETED, 409, undefined, {
        status: booking.status
      });
    }

    const settlement = booking.settlement;
    if (!settlement || settlement.balanceDue <= 0) {
      throw createAppError(ERROR_CODES.BOOKING_NO_BALANCE_DUE, 400);
    }

    const outstanding = settlement.balanceDue - (settlement.balancePaid ?? 0);
    if (outstanding <= 0) {
      throw createAppError(ERROR_CODES.BOOKING_BALANCE_ALREADY_SETTLED, 409);
    }

    const userId = booking.userId.toString();

    // Scoped by purpose so it can never collide with the ORIGINAL booking payment,
    // whose key is hash(bookingId, userId, priceSnapshot).
    const idempotencyKey = this.generateIdempotencyKey(
      `${bookingId}:balance`,
      userId,
      outstanding
    );

    // One shape for every "you already have this payment" answer in this method. The
    // dead-attempt check, the live-attempt guard and the lost create race all mean the
    // same thing to a caller, and all three are reachable from one impatient customer
    // pressing Pay repeatedly.
    const respondWithExisting = (tx: IPaymentTransaction) => ({
      transactionId: tx._id.toString(),
      status: tx.status,
      amount: outstanding,
      currency: booking.currency,
      instructions: this.lastInstructions(tx),
      message: tx.status === 'SUCCEEDED'
        ? 'Balance already paid'
        : 'Balance payment already initiated. Complete the pending payment.'
    });

    const existingTx = await PaymentTransactionModel.findOne({ idempotencyKey });
    if (existingTx) {
      if (existingTx.status === 'SUCCEEDED') {
        return {
          transactionId: existingTx._id.toString(),
          status: existingTx.status,
          amount: outstanding,
          currency: booking.currency,
          message: 'Balance already paid'
        };
      }
      if (existingTx.status === 'INITIATED' || existingTx.status === 'PENDING') {
        return respondWithExisting(existingTx);
      }
      // Failed/cancelled → this is a NEW attempt, and it needs the key the dead one holds.
      // Only once we KNOW it is dead, though: `FAILED` is written for a refusal AND for a
      // call that merely errored, and a live charge can be sitting behind the second kind.
      const settledAttempt = await this.releaseDeadAttempt(existingTx);
      if (settledAttempt) return respondWithExisting(settledAttempt);
    }

    const gatewayInstance = getPaymentGateway(gateway);

    // A second LIVE charge over money that already has one — the hole the idempotency key
    // cannot see, because that key is (source, user, AMOUNT) while this asks about the money
    // itself. Two routes reach the same order (the cart path and the single-order path), and
    // a group total moves when one order in it settles or is cancelled, so one customer can
    // compute two different keys over overlapping orders and open two charges that nothing
    // links. Answered with the live attempt rather than an error: from the customer's side
    // this IS their payment, and the prompt is already on their phone.
    const liveElsewhere = await this.findLiveAttempt({
      bookingId: new Types.ObjectId(bookingId),
      purpose: 'booking_balance'
    });
    if (liveElsewhere) return respondWithExisting(liveElsewhere);

    const attempt = await this.openAttempt({
      bookingId: new Types.ObjectId(bookingId),
      purpose: 'booking_balance',
      userId: new Types.ObjectId(userId),
      gateway,
      method: gateway === 'STRIPE' ? 'CARD' : 'MOBILE',
      status: 'INITIATED',
      gatewayRef: '',
      amountSnapshot: outstanding,
      currencySnapshot: booking.currency,
      idempotencyKey,
      merchantRef: mintMerchantRef('pt'),
      rawGatewayPayloads: []
    }, idempotencyKey);
    if ('raced' in attempt) return respondWithExisting(attempt.raced);
    const transaction = attempt.opened;

    try {
      const gatewayResult = await gatewayInstance.initiatePayment({
        orderId: bookingId,
        userId,
        amount: outstanding,
        currency: booking.currency,
        channel,
        merchantRef: transaction.merchantRef!,
        metadata: { idempotencyKey, bookingId, purpose: 'booking_balance', merchantRef: transaction.merchantRef }
      });

      transaction.gatewayRef = gatewayResult.gatewayRef;
      transaction.status = gatewayResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'initiate',
        ...gatewayResult.rawResponse,
        instructions: gatewayResult.instructions ?? null
      });
      transaction.gatewayPayloadHash = this.hashPayload(gatewayResult.rawResponse);
      await transaction.save();

      // NOTE: `booking.paymentStatus` is deliberately NOT touched. It describes the
      // ORIGINAL payment and is already `paid`; moving it to `pending` here would
      // make a fully-paid booking look unpaid, and the unpaid-booking sweep could
      // then cancel a completed appointment.

      return {
        transactionId: transaction._id.toString(),
        status: transaction.status,
        amount: outstanding,
        currency: booking.currency,
        instructions: gatewayResult.instructions,
        message: gatewayResult.success
          ? 'Balance payment initiated successfully'
          : gatewayResult.error || 'Balance payment initiation failed'
      };
    } catch (error: any) {
      await this.recordFailedAttempt(transaction, error);

      throw createAppError(ERROR_CODES.PAYMENT_INITIATION_FAILED, 502, undefined, {
        cause: error.message
      });
    }
  }

  /**
   * Verify payment status
   *
   * IDEMPOTENT: Can be called multiple times
   *
   * @param transactionId - Payment transaction ID
   * @returns Updated transaction status
   */
  async verifyPayment(transactionId: string): Promise<{
    transactionId: string;
    status: PaymentStatus;
    message: string;
  }> {
    // Load transaction
    const transaction = await PaymentTransactionModel.findById(transactionId);

    if (!transaction) {
      throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404);
    }

    // Already in terminal state
    if (transaction.status === 'SUCCEEDED' || transaction.status === 'FAILED' || transaction.status === 'CANCELLED') {
      return {
        transactionId: transaction._id.toString(),
        status: transaction.status,
        message: `Payment ${transaction.status.toLowerCase()}`
      };
    }

    // Call gateway to verify
    const gatewayInstance = getPaymentGateway(transaction.gateway);

    try {
      const verifyResult = await gatewayInstance.verifyPayment({
        gatewayRef: transaction.gatewayRef
      });

      // Update transaction status
      const previousStatus = transaction.status;
      transaction.status = verifyResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'verify',
        ...verifyResult.rawResponse
      });

      // Update payload hash
      transaction.gatewayPayloadHash = this.hashPayload(verifyResult.rawResponse);

      await transaction.save();

      // Trigger fulfillment if payment succeeded (status changed to SUCCEEDED)
      if (transaction.status === 'SUCCEEDED' && (previousStatus as string) !== 'SUCCEEDED') {
        await this.handlePaymentSuccess(transaction);
      }

      /**
       * ⚠ **The TRANSITION is the guard, exactly as it is for success above.** Nothing
       * de-duplicates a notification once it has been dispatched — `createIfNotExists` upserts
       * the in-app row but still re-delivers the push and the WhatsApp message — so the only
       * thing standing between a customer and three identical "payment did not go through"
       * messages is that this fires on the *change* into a dead status, not on the status.
       * `verifyPayment` also returns early on an already-terminal transaction, which is the
       * belt to that brace.
       *
       * ⚠ **This path carries the reconciliation sweep as well as a client poll.**
       * `PaymentReconciliationWorker` closes a payment whose callback never arrived by calling
       * this very method — deliberately, rather than the gateway directly — so a customer whose
       * failure is discovered ten minutes later by the cron is told here. That customer is
       * precisely the one who has been sitting in silence longest, and they were the reason
       * this had to cover more than the webhook.
       */
      if (this.isDeadStatus(transaction.status) && !this.isDeadStatus(previousStatus)) {
        await this.handlePaymentFailure(transaction);
      }

      return {
        transactionId: transaction._id.toString(),
        status: transaction.status,
        message: verifyResult.success ? 'Payment verified successfully' : verifyResult.error || 'Verification failed'
      };

    } catch (error: any) {
      throw createAppError(ERROR_CODES.PAYMENT_VERIFICATION_FAILED, 502, undefined, { cause: error.message });
    }
  }

  /**
   * Handle webhook from payment gateway
   * 
   * IDEMPOTENT: Payload hash prevents duplicate processing
   * 
   * @param gateway - Gateway that sent webhook
   * @param payload - Webhook payload
   * @param signature - Webhook signature for verification
   * @returns Success indicator
   */
  async applyWebhookEvent(
    gateway: PaymentGatewayType,
    event: NormalizedWebhookEvent
  ): Promise<WebhookOutcome> {
    // 1. LOCATE THE TRANSACTION.
    //
    //    `merchantRef` first — it is the reference WE minted and the gateway
    //    echoed back, so it identifies the row without depending on our having
    //    already stored the provider's id. That matters: a mobile-money
    //    callback can arrive before `initiatePayment` has written `gatewayRef`,
    //    in which case the old `(gateway, gatewayRef)` lookup found nothing and
    //    the confirmation was dropped as "unknown transaction".
    const transaction = await this.findTransactionForEvent(gateway, event);

    if (!transaction) {
      console.warn(
        `[PaymentOrchestrator] Webhook for unknown transaction: ${event.gatewayRef} (merchantRef=${event.merchantRef ?? 'none'})`
      );
      return { kind: 'unknown_transaction' };
    }

    // 2. CROSS-CHECK THE MONEY.
    //
    //    The signature has already passed, so this is not about forgery in the
    //    ordinary sense — it is about never settling on the provider's figure
    //    rather than our own. It is ALSO the compensating control for
    //    My-CoolPay's MD5 signature: an attacker who defeated that construction
    //    still cannot choose what the payment is worth.
    if (event.amount !== null && !amountsEqual(event.amount, transaction.amountSnapshot)) {
      console.error(
        `[PaymentOrchestrator] AMOUNT MISMATCH on ${transaction._id}: gateway reported ${event.amount}, recorded ${transaction.amountSnapshot}`
      );
      return {
        kind: 'amount_mismatch',
        detail: `reported ${event.amount}, recorded ${transaction.amountSnapshot}`,
      };
    }
    if (event.currency !== null && !currenciesEqual(event.currency, transaction.currencySnapshot)) {
      console.error(
        `[PaymentOrchestrator] CURRENCY MISMATCH on ${transaction._id}: gateway reported ${event.currency}, recorded ${transaction.currencySnapshot}`
      );
      return {
        kind: 'amount_mismatch',
        detail: `reported ${event.currency}, recorded ${transaction.currencySnapshot}`,
      };
    }

    const previousStatus = transaction.status;
    const newStatus = event.status as PaymentStatus;

    // 3. NEVER WALK A TERMINAL TRANSACTION BACKWARDS.
    //
    //    Both gateways map an unrecognised status word to PENDING, and Stripe
    //    sends dozens of event types we do not model. The previous code wrote
    //    whatever it computed, so an unrelated `charge.updated` on a settled
    //    PaymentIntent rewrote a SUCCEEDED transaction to PENDING — leaving a
    //    fulfilled, split, delivered order whose payment record says it is
    //    still waiting.
    const isTerminal = (s: PaymentStatus) => s === 'SUCCEEDED' || s === 'REFUNDED';
    if (isTerminal(previousStatus) && newStatus !== previousStatus) {
      return {
        kind: 'ignored',
        detail: `transaction is already ${previousStatus}; ignoring ${event.eventType}`,
      };
    }
    if (newStatus === previousStatus) {
      return { kind: 'ignored', detail: `no status change (${previousStatus})` };
    }

    // 4. APPLY.
    transaction.status = newStatus;
    transaction.rawGatewayPayloads.push({
      timestamp: new Date(),
      type: 'webhook',
      event: event.eventType,
      eventId: event.eventId,
      ...(event.raw as Record<string, unknown>),
    });
    await transaction.save();

    // 5. FULFIL.
    //
    //    The `previousStatus !== 'SUCCEEDED'` guard is kept even though step 3
    //    now makes it unreachable: this is the line standing between one
    //    payment and two earnings splits, and a guard on money is worth having
    //    twice.
    if (newStatus === 'SUCCEEDED' && previousStatus !== 'SUCCEEDED') {
      await this.handlePaymentSuccess(transaction);
    }

    /**
     * 6. TELL THE CUSTOMER IT DID NOT WORK.
     *
     *    ⚠ **This is the path that matters most, because it is the one that is silent.** A
     *    refused mobile-money push produces no error anywhere a customer can see: the screen
     *    they paid from has closed, the chat says nothing, and the order sits unpaid. Until
     *    this line existed, a failed payment was indistinguishable from a successful one that
     *    had gone quiet, and the customer waited for an order that was never coming.
     *
     *    Step 3 above has already returned `ignored` when the status did not change, so
     *    reaching here IS the transition — the same de-duplication the success branch relies on.
     */
    if (this.isDeadStatus(newStatus) && !this.isDeadStatus(previousStatus)) {
      await this.handlePaymentFailure(transaction);
    }

    console.log(
      `[PaymentOrchestrator] Webhook applied to ${transaction._id}: ${previousStatus} → ${newStatus}`
    );
    return { kind: 'processed', detail: `${previousStatus} → ${newStatus}` };
  }

  /**
   * Resolve the transaction a callback belongs to.
   *
   * Two keys, tried in order of reliability. `merchantRef` is ours and is
   * written before the charge is opened; `gatewayRef` is theirs and is written
   * only once their response comes back, which may be after their callback.
   */
  private async findTransactionForEvent(
    gateway: PaymentGatewayType,
    event: NormalizedWebhookEvent
  ): Promise<IPaymentTransaction | null> {
    if (event.merchantRef) {
      const byMerchant = await PaymentTransactionModel.findOne({ merchantRef: event.merchantRef });
      if (byMerchant) return byMerchant;
    }
    if (!event.gatewayRef) return null;
    return PaymentTransactionModel.findOne({ gateway, gatewayRef: event.gatewayRef });
  }

  /**
   * Submit the one-time code for a mobile-money charge that reported
   * `requiresOtp` (My-CoolPay Orange Money).
   *
   * The endpoint in front of this is unauthenticated, like `initiate` and
   * `verify` beside it, so the attempt counter is the only thing bounding a
   * six-digit guess. It lives on the transaction — the object being attacked —
   * and exhausting it fails the payment rather than throttling it, because
   * waiting would not make a wrong code right.
   */
  async authorizePayment(
    transactionId: string,
    code: string
  ): Promise<{ transactionId: string; status: PaymentStatus; instructions?: any; message: string }> {
    if (!Types.ObjectId.isValid(transactionId)) {
      throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404);
    }
    const transaction = await PaymentTransactionModel.findById(transactionId);
    if (!transaction) {
      throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404);
    }

    const gatewayInstance = getPaymentGateway(transaction.gateway);
    if (typeof gatewayInstance.authorizePayment !== 'function') {
      throw createAppError(ERROR_CODES.PAYMENT_OTP_NOT_REQUIRED, 422, undefined, {
        gateway: transaction.gateway,
      });
    }
    if (transaction.status !== 'PENDING' && transaction.status !== 'INITIATED') {
      throw createAppError(ERROR_CODES.PAYMENT_OTP_NOT_REQUIRED, 422, undefined, {
        status: transaction.status,
      });
    }

    // Counted BEFORE the call, so an attacker cannot spend attempts for free by
    // aborting the request while the gateway is still thinking.
    transaction.otpAttempts = (transaction.otpAttempts ?? 0) + 1;
    if (transaction.otpAttempts > PAYMENTS_CONFIG.OTP_MAX_ATTEMPTS) {
      transaction.status = 'FAILED';
      await transaction.save();
      throw createAppError(ERROR_CODES.PAYMENT_OTP_ATTEMPTS_EXCEEDED, 422);
    }
    await transaction.save();

    const result = await gatewayInstance.authorizePayment({
      gatewayRef: transaction.gatewayRef,
      code,
    });

    if (!result.success) {
      throw createAppError(ERROR_CODES.PAYMENT_OTP_INVALID, 422, undefined, {
        attemptsRemaining: Math.max(0, PAYMENTS_CONFIG.OTP_MAX_ATTEMPTS - transaction.otpAttempts),
      });
    }

    transaction.rawGatewayPayloads.push({
      timestamp: new Date(),
      type: 'authorize',
      ...(result.rawResponse ?? {}),
    });
    await transaction.save();

    return {
      transactionId: transaction._id.toString(),
      status: transaction.status,
      instructions: result.instructions,
      message: 'Code accepted. Confirm the payment prompt on your phone.',
    };
  }

  /**
   * Handle successful payment
   * 
   * ROUTES TO:
   * - Order fulfillment if transaction.orderId is set
   * - Booking finalization if transaction.bookingId is set
   * 
   * EMITS EVENTS:
   * - payment.received.partial (if amount < total)
   * - payment.received.full (if amount >= total)
   * 
   * IDEMPOTENT: Both routes implement idempotency checks
   * 
   * @param transaction - Successful payment transaction
   */
  private async handlePaymentSuccess(transaction: IPaymentTransaction): Promise<void> {
    try {
      // Route based on transaction type
      if (transaction.cartId && transaction.orderIds && transaction.orderIds.length > 0) {
        // CHECKOUT GROUP: one payment settles every order in the group. Each
        // order independently flips to paid, splits earnings per its own vendor
        // commission, dispatches/fulfils and syncs.
        console.log(`[PaymentOrchestrator] Processing payment success for cart group ${transaction.cartId} (${transaction.orderIds.length} orders)`);
        for (const orderId of transaction.orderIds) {
          await this.orderService.handlePaymentSuccess(orderId.toString());
        }

        // Emit a full-payment event per order (the group total always covers each order's total)
        await this.emitCartGroupPaymentEvents(transaction);

        console.log(`[PaymentOrchestrator] Payment success handled for cart group ${transaction.cartId}`);
      } else if (transaction.orderId) {
        console.log(`[PaymentOrchestrator] Processing payment success for order ${transaction.orderId}`);
        await this.orderService.handlePaymentSuccess(transaction.orderId.toString());

        // Emit payment event for order
        await this.emitPaymentEvent(transaction, 'order');

        console.log(`[PaymentOrchestrator] Payment success handled for order ${transaction.orderId}`);
      } else if (transaction.bookingId) {
        console.log(`[PaymentOrchestrator] Processing payment success for booking ${transaction.bookingId}`);
        await this.handleBookingPaymentSuccess(transaction);

        // Emit payment event for booking
        await this.emitPaymentEvent(transaction, 'booking');

        console.log(`[PaymentOrchestrator] Payment success handled for booking ${transaction.bookingId}`);
      } else {
        console.error('[PaymentOrchestrator] Transaction has neither orderId nor bookingId');
      }
    } catch (error: any) {
      console.error('[PaymentOrchestrator] Failed to handle payment success:', error);
      // Don't throw - webhook should still return 200 to prevent retries
    }
  }

  /**
   * Is this a status the gateway has told us the money will not arrive under?
   *
   * ⚠ **Both, and they are one thing to the person holding the phone.** To the platform a
   * refusal and an abandonment are different; to the customer both mean *the money did not
   * move and my items are still waiting*, and both are fixed by the same action. Splitting
   * them here would give the notification a distinction it could only narrate as blame.
   *
   * ⚠ **`REFUNDED` is deliberately NOT here.** The payment went through; what happened
   * afterwards belongs to the order's own story and already has its own situation.
   */
  private isDeadStatus(status: PaymentStatus): boolean {
    return status === 'FAILED' || status === 'CANCELLED';
  }

  /**
   * Tell the customer a charge did not go through.
   *
   * ── ⚠ THE SILENCE THIS CLOSES WAS THE DEFECT ────────────────────────────────
   * Every other checkout outcome said something. A failed payment said nothing — this class
   * published `payment.received.full` on success and published NOTHING on FAILED or CANCELLED,
   * on any path — so from the customer's side a refused push was indistinguishable from a
   * successful payment that had gone quiet. They waited for an order that was not coming, and
   * the copy that would have told them (`order.payment_failed`) sat in the catalogue with no
   * trigger.
   *
   * ── WHERE IT IS *NOT* CALLED FROM, AND WHY EACH OMISSION IS DELIBERATE ──────
   * Three other places write `FAILED`, and notifying from any of them would be wrong:
   *
   *   - **`recordFailedAttempt`** — written from the CATCH of the gateway call, which
   *     `releaseDeadAttempt` spends thirty lines explaining cannot tell a refusal from a
   *     timeout. A timeout means the charge may be live and the money may be moving. Telling
   *     somebody their payment failed while their handset is still prompting them is worse
   *     than telling them nothing, and the caller already gets a 502 to render.
   *   - **`releaseDeadAttempt`** — reached only from inside a NEW attempt, i.e. the customer
   *     is already paying again. "Your payment failed" arriving as they press pay is noise
   *     about a decision they have already made.
   *   - **`authorizePayment`'s exhausted OTP** — the customer is in the request, typing codes,
   *     and is told by its 422. A push about it lands seconds later saying the same thing.
   *
   * What the two call sites have in common is that **the gateway told us**, and that is the
   * only evidence worth waking somebody up for.
   *
   * ── ONE EVENT PER ORDER, AS SUCCESS ALREADY DOES ────────────────────────────
   * A multi-vendor basket is several orders settled by one charge, and `order.created` and
   * `order.payment.received` both already speak per order — so a customer who received three
   * "order created" messages receives three about the failure. Consistency was chosen over a
   * single group message because the alternative means naming one order number out of three
   * and quoting a total larger than the order it names.
   *
   * ⚠ **Secondary, and it never throws.** A webhook must still answer 200 or the gateway
   * retries, and a notification that failed to send must not turn a recorded payment outcome
   * into a re-delivered callback.
   */
  private async handlePaymentFailure(transaction: IPaymentTransaction): Promise<void> {
    try {
      const orderIds =
        transaction.orderIds && transaction.orderIds.length > 0
          ? transaction.orderIds
          : transaction.orderId
            ? [transaction.orderId]
            : [];

      /**
       * ⚠ **No orders means this was not a customer order**, and the silence is correct: the
       * same charge pipeline carries bookings, plan purchases and credit top-ups, each of which
       * has its own story and its own audience. `handleOrderPaymentReceived` drops a payload
       * with no `orderId` for exactly this reason; dropping it here rather than there keeps a
       * booking failure from ever reaching a subscriber written about orders.
       */
      if (orderIds.length === 0) return;

      const orders = await OrderModel.find({ _id: { $in: orderIds } });
      for (const order of orders) {
        await eventBus.publish('payment.failed', {
          eventType: 'payment.failed',
          aggregateId: order._id.toString(),
          occurredAt: new Date(),
          payload: {
            vendorId: order.vendor_id.toString(),
            paymentId: transaction._id.toString(),
            orderId: order._id.toString(),
            customerId: order.customer_id?.toString(),
            cartId: transaction.cartId?.toString(),
            orderNumber: order.order_number,
            /**
             * ⚠ **The ORDER's amount, not the charge's.** A group charge covers several orders
             * and the copy names one order — quoting the group total beside a single order
             * number would tell a customer they were charged for more than that order is worth.
             */
            amount: order.total_amount,
            currency: transaction.currencySnapshot,
            status: transaction.status,
            aggregateType: 'order'
          }
        });
      }

      console.log(
        `[PaymentOrchestrator] Emitted payment.failed for ${orders.length} order(s) on transaction ${transaction._id}`
      );
    } catch (error: any) {
      console.error('[PaymentOrchestrator] Failed to emit payment failure event:', error);
      // Don't throw - this is a secondary operation
    }
  }

  /**
   * Handle successful booking payment
   * 
   * IDEMPOTENT: Checks if already paid before processing
   * 
   * FLOW:
   * 1. Load booking
   * 2. Idempotency check (return if already paid)
   * 3. Update booking payment status to 'paid'
   * 4. Link payment transaction
   * 5. Set paymentMethod if not already set
   * 6. Sync calendar event
   * 
   * @param transaction - Successful payment transaction for booking
   */
  private async handleBookingPaymentSuccess(transaction: IPaymentTransaction): Promise<void> {
    if (!transaction.bookingId) {
      throw createAppError(ERROR_CODES.PAYMENT_MISSING_BOOKING_ID, 500);
    }

    const booking = await Booking.findById(transaction.bookingId);

    if (!booking) {
      console.error(`[PaymentOrchestrator] Booking ${transaction.bookingId} not found for transaction ${transaction._id}`);
      return;
    }

    // A balance payment settles the completion shortfall, NOT the original price.
    // It must branch before the already-paid check below, which would otherwise
    // swallow it — the booking is `paid` by definition when a balance exists.
    if (transaction.purpose === 'booking_balance') {
      await this.handleBookingBalanceSuccess(booking, transaction);
      return;
    }

    // IDEMPOTENCY CHECK
    if (booking.paymentStatus === 'paid') {
      console.log(`[PaymentOrchestrator] Booking ${booking._id} already paid. Skipping duplicate payment processing.`);
      return; // No-op, already processed
    }

    // Update booking payment status
    booking.paymentStatus = 'paid';
    booking.paymentTransactionId = transaction._id as Types.ObjectId;

    // USER REFINEMENT: Ensure paymentMethod is set
    if (!booking.paymentMethod) {
      booking.paymentMethod = 'online';
    }

    await booking.save();

    // Sync calendar event with new payment status
    await this.calendarSync.syncBookingPaymentStatus(booking);

    // Split the paid amount into held earnings (vendor net + platform commission).
    // Idempotent and best-effort: a failure must not fail webhook processing.
    try {
      await earningsSplitService.splitBooking(booking);
    } catch (error) {
      console.error('[PaymentOrchestrator] Failed to split booking earnings:', error);
    }

    console.log(`[PaymentOrchestrator] Booking ${booking._id} marked as paid and calendar updated`);
  }

  /**
   * Credit a successful BALANCE payment against a completed booking.
   *
   * Splits the extra into platform commission + vendor net exactly as the original
   * payment does, and matures it immediately: the appointment is already
   * `completed`, so the escrow clock that `splitBooking` alone would leave waiting
   * on a completion that has already happened would never start.
   */
  private async handleBookingBalanceSuccess(
    booking: IBooking,
    transaction: IPaymentTransaction
  ): Promise<void> {
    const settlement = booking.settlement;
    if (!settlement) {
      console.error(`[PaymentOrchestrator] Booking ${booking._id} balance paid but no settlement recorded`);
      return;
    }

    // IDEMPOTENCY: the same transaction arriving twice must not double-credit.
    if (settlement.balanceTransactionId?.toString() === transaction._id?.toString()) {
      console.log(`[PaymentOrchestrator] Balance for booking ${booking._id} already credited.`);
      return;
    }

    settlement.balancePaid = Math.min(
      settlement.balanceDue,
      (settlement.balancePaid ?? 0) + transaction.amountSnapshot
    );
    settlement.balancePaidAt = new Date();
    settlement.balancePaymentMethod = 'online';
    settlement.balanceTransactionId = transaction._id as Types.ObjectId;
    booking.settlement = settlement;
    await booking.save();

    try {
      await earningsSplitService.splitBookingBalance(booking, transaction.amountSnapshot);
    } catch (error) {
      console.error('[PaymentOrchestrator] Failed to split booking balance earnings:', error);
    }

    console.log(
      `[PaymentOrchestrator] Booking ${booking._id} balance of ${transaction.amountSnapshot} credited`
    );
  }

  /**
   * Hand the idempotency key back, so a retry can take it.
   *
   * `idempotencyKey` is `unique`, and all four initiate paths derive it from the same three
   * facts — source id, user, amount — so a retry of the same intent computes the SAME key.
   * The four "failed/cancelled → fall through to a fresh transaction" branches therefore
   * could not do what they said: `create()` collided on the index and answered
   * `DATABASE_UNIQUE_CONSTRAINT_VIOLATION` 409, so a customer whose first attempt failed
   * could never try again — for that cart, at that price, ever. The branch existed from the
   * first commit and had never once run to completion, because nothing reached it until the
   * `gatewayRef` validation defect was fixed and initiate began writing rows at all.
   *
   * The dead attempt is KEPT, never reused and never deleted. It holds the failure in
   * `rawGatewayPayloads`, and — the part that matters for money — it keeps its `merchantRef`,
   * which is what routes a late webhook home if the gateway settles a charge we had given up
   * on. Only its claim on the key is retired, because that key means "the LIVE attempt at
   * this intent" and a dead attempt is not it. Reusing the row instead would have to mint a
   * fresh `merchantRef` over the old one (the gateway refuses a repeated reference), which
   * is precisely how that late webhook would be orphaned.
   *
   * Suffixed with the row's own `_id`, so the retired value stays unique however many
   * attempts a customer makes.
   *
   * ⚠ What this does NOT decide is whether retrying is safe. `FAILED` is written both when
   * the gateway refused outright and when the call merely errored — a timeout can leave a
   * charge live at the provider — so a retry after the second kind can double-charge. That
   * is a pre-existing property of the fall-through branch, not of retiring the key; closing
   * it means verifying the dead attempt against the gateway before allowing the retry.
   */
  /**
   * Is there already a LIVE attempt over this money?
   *
   * `INITIATED` is the window between the row being written and the gateway answering;
   * `PENDING` is a prompt sitting on the customer's handset. Both mean a charge may complete
   * without anything else happening, so a second one must not be opened beside it.
   *
   * Scoped by the MONEY, not by the request: an order reached through the cart path and the
   * same order reached through the single-order path compute different idempotency keys, and
   * so does the same cart after one of its orders settles or is cancelled (the group total is
   * part of the key). The unique index cannot see any of that; this can.
   */
  private async findLiveAttempt(
    scope: Record<string, unknown>
  ): Promise<IPaymentTransaction | null> {
    return PaymentTransactionModel.findOne({
      ...scope,
      status: { $in: ['INITIATED', 'PENDING'] }
    });
  }

  /**
   * Open the attempt, or report that a concurrent request already did.
   *
   * The idempotency check and `findLiveAttempt` are both read-then-write, so two clicks
   * landing inside the same millisecond pass them both and race to `create`. The unique index
   * on `idempotencyKey` is what actually decides it — and it decides correctly, which is why
   * only ONE of the two ever reaches a gateway. What it produced was a raw
   * `DATABASE_UNIQUE_CONSTRAINT_VIOLATION` 409 at the loser, which is a true statement about
   * the database and a useless one to a customer who pressed a button twice. The loser now
   * gets the winner's transaction, which is what idempotency promised in the first place.
   *
   * Only a duplicate on THIS key is treated this way. Any other write failure is still thrown.
   */
  private async openAttempt(
    doc: NewPaymentAttempt,
    idempotencyKey: string
  ): Promise<{ opened: IPaymentTransaction } | { raced: IPaymentTransaction }> {
    try {
      return { opened: await PaymentTransactionModel.create(doc) };
    } catch (error: any) {
      const duplicate =
        error?.code === 11000 && Object.keys(error?.keyPattern ?? {}).includes('idempotencyKey');
      if (!duplicate) throw error;

      const winner = await PaymentTransactionModel.findOne({ idempotencyKey });
      if (!winner) throw error;
      console.log(
        `[PaymentOrchestrator] Concurrent initiate for ${idempotencyKey} — answering with ${winner._id}`
      );
      return { raced: winner };
    }
  }

  /** The instructions the customer was last given — the USSD prompt, the hosted-page secret. */
  private lastInstructions(transaction: IPaymentTransaction): any {
    for (let i = transaction.rawGatewayPayloads.length - 1; i >= 0; i--) {
      const instructions = transaction.rawGatewayPayloads[i]?.instructions;
      if (instructions) return instructions;
    }
    return undefined;
  }

  /**
   * May this dead-looking attempt be retried? Clears the way if it may.
   *
   * Returns the transaction when the retry must NOT happen — it is alive, or it settled after
   * all — and `null` when the caller may go ahead, in which case the key has been retired.
   *
   * ── WHY A LOCAL `FAILED` IS NOT ENOUGH ──────────────────────────────────────
   * `FAILED` is written from the catch of the gateway call, and that catch cannot tell a
   * refusal from a timeout. A refusal means no charge exists. A timeout means the request may
   * have arrived, the operator may have prompted the customer, and the money may be moving —
   * we simply stopped listening after 15 seconds. Retrying on the second is how one basket
   * gets paid for twice, and no amount of order-level idempotency downstream gives that money
   * back: `OrderService.handlePaymentSuccess` no-ops on an already-paid order, so the second
   * charge settles silently against nothing.
   *
   * So the gateway is asked, and its answer outranks ours. SUCCEEDED is adopted and fulfilled
   * — that is money we would otherwise have abandoned. FAILED or CANCELLED confirms the local
   * verdict and the retry proceeds.
   *
   * PENDING is the interesting one, because it has two causes that look identical: a charge
   * genuinely awaiting the customer, and a payment record that was opened but never charged
   * (NotchPay initialises in one call and charges in a second — a refusal at the second leaves
   * exactly this). They are told apart by HOW the attempt died: a 4xx is the provider deciding,
   * and a provider that refused the charge never placed it. Anything else — a timeout, a 5xx,
   * an unreachable host — is ignorance, and ignorance about money fails closed.
   */
  private async releaseDeadAttempt(
    transaction: IPaymentTransaction
  ): Promise<IPaymentTransaction | null> {
    // Nothing was ever opened at the gateway, so there is no charge to double.
    if (!transaction.gatewayRef) {
      await this.retireDeadAttempt(transaction);
      return null;
    }

    const gatewayInstance = getPaymentGateway(transaction.gateway);
    let verified: PaymentStatus;
    try {
      const result = await gatewayInstance.verifyPayment({ gatewayRef: transaction.gatewayRef });
      verified = result.status as PaymentStatus;
    } catch (error: any) {
      // We asked and could not find out. That is not permission to charge again.
      console.warn(
        `[PaymentOrchestrator] Cannot verify ${transaction._id} before retry: ${error?.message}`
      );
      return transaction;
    }

    if (verified === 'SUCCEEDED') {
      const previousStatus = transaction.status;
      transaction.status = 'SUCCEEDED';
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'verify',
        detail: 'settled after a failed-looking attempt; retry refused'
      });
      await transaction.save();
      console.warn(
        `[PaymentOrchestrator] ${transaction._id} was recorded ${previousStatus} but the gateway ` +
          'settled it — adopting, and refusing the retry'
      );
      await this.handlePaymentSuccess(transaction);
      return transaction;
    }

    if (verified === 'FAILED' || verified === 'CANCELLED') {
      await this.retireDeadAttempt(transaction);
      return null;
    }

    // PENDING. Safe to retry only if the provider REFUSED, which means it never charged.
    if (this.lastFailureWasRefused(transaction)) {
      await this.retireDeadAttempt(transaction);
      return null;
    }

    transaction.status = 'PENDING';
    await transaction.save();
    return transaction;
  }

  /**
   * Did the provider REFUSE this attempt, as opposed to leaving us not knowing?
   *
   * Reads the status the gateway adapter recorded on the row — `errorPayload` keeps it in
   * `details.status` — and treats 4xx as a decision. A 5xx, a timeout, or an unreachable host
   * records no status at all, which is exactly the case that must NOT count as refused.
   */
  private lastFailureWasRefused(transaction: IPaymentTransaction): boolean {
    for (let i = transaction.rawGatewayPayloads.length - 1; i >= 0; i--) {
      const payload = transaction.rawGatewayPayloads[i];
      if (payload?.type !== 'error') continue;
      const status = payload?.details?.status;
      return typeof status === 'number' && status >= 400 && status < 500;
    }
    return false;
  }

  /**
   * Write a failed attempt down — including the reference the gateway had already issued.
   *
   * NotchPay opens a transaction in one call and charges it in a second, so a failure at the
   * second still leaves a real reference behind. It used to be dropped on the floor with the
   * error, which left the row claiming no charge had ever been opened — the precise input
   * `releaseDeadAttempt` needs to decide whether retrying is safe. The adapter now carries it
   * out on the error, and this is where it lands.
   */
  private async recordFailedAttempt(
    transaction: IPaymentTransaction,
    error: unknown
  ): Promise<void> {
    transaction.status = 'FAILED';
    transaction.rawGatewayPayloads.push(this.errorPayload(error));

    if (!transaction.gatewayRef && error instanceof AppError) {
      const issued = error.details?.gatewayRef;
      if (typeof issued === 'string' && issued) transaction.gatewayRef = issued;
    }

    await transaction.save();
  }

  private async retireDeadAttempt(transaction: IPaymentTransaction): Promise<void> {
    await PaymentTransactionModel.updateOne(
      { _id: transaction._id },
      { $set: { idempotencyKey: `${transaction.idempotencyKey}:retired:${transaction._id}` } }
    );
  }

  /**
   * What to record on the row when the gateway call threw.
   *
   * `error.message` alone is what this used to keep, and from the gateway adapters that is a
   * one-line summary — "NotchPay POST /payments/{ref} answered 422" — with the provider's own
   * explanation sitting in `details.body`. The boundary drops `details` from the CLIENT
   * response for every `external_service` error, correctly and in every environment, so
   * unless it is written HERE the reason a payment was refused exists nowhere at all: not in
   * the response, not in the log, not on the row. `rawGatewayPayloads` is the audit trail
   * and is never served to a customer, which is what makes it the right place for it.
   */
  private errorPayload(error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error);
    return {
      timestamp: new Date(),
      type: 'error',
      error: message,
      ...(error instanceof AppError
        ? { code: error.code, statusCode: error.statusCode, details: error.details ?? null }
        : {}),
    };
  }

  /**
   * Generate idempotency key
   * 
   * hash(orderId + userId + amount)
   */
  private generateIdempotencyKey(orderId: string, userId: string, amount: number): string {
    const data = `${orderId}:${userId}:${amount}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Hash gateway payload for duplicate detection
   */
  private hashPayload(payload: any): string {
    const normalized = JSON.stringify(payload);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  // The per-gateway status tables used to be duplicated here — a second, SMALLER
  // copy of the maps each gateway already owned, read by the webhook path while
  // the verify path read the gateway's. They disagreed: `error` and the
  // single-l `canceled` NotchPay actually sends were absent here and fell
  // through to the default, so one word meant CANCELLED on one path and FAILED
  // on the other for the same transaction. There is now one table per gateway,
  // on the gateway.

  /**
   * Emit payment event (partial or full)
   * 
   * Determines whether payment is partial or full by comparing
   * transaction amount to order/booking total.
   * 
   * @param transaction - Payment transaction
   * @param type - 'order' or 'booking'
   */
  private async emitPaymentEvent(
    transaction: IPaymentTransaction,
    type: 'order' | 'booking'
  ): Promise<void> {
    try {
      let vendorId: string;
      let aggregateId: string;
      let totalAmount: number;
      let aggregateType: 'order' | 'booking';

      // Fetch order or booking to get vendor and total amount
      if (type === 'order' && transaction.orderId) {
        const order = await this.orderRepo.findById(transaction.orderId.toString());
        if (!order) {
          console.error(`[PaymentOrchestrator] Order ${transaction.orderId} not found for event emission`);
          return;
        }
        vendorId = order.vendor_id.toString();
        aggregateId = order._id.toString();
        totalAmount = order.total_amount;
        aggregateType = 'order';
      } else if (type === 'booking' && transaction.bookingId) {
        const booking = await Booking.findById(transaction.bookingId);
        if (!booking) {
          console.error(`[PaymentOrchestrator] Booking ${transaction.bookingId} not found for event emission`);
          return;
        }
        vendorId = booking.vendorId.toString();
        aggregateId = booking._id.toString();
        totalAmount = booking.priceSnapshot;
        aggregateType = 'booking';
      } else {
        console.error('[PaymentOrchestrator] Invalid type or missing IDs for event emission');
        return;
      }

      // Determine if partial or full payment
      const paidAmount = transaction.amountSnapshot;
      const isFullPayment = paidAmount >= totalAmount;
      const eventType = isFullPayment ? 'payment.received.full' : 'payment.received.partial';

      // Emit event
      await eventBus.publish(eventType, {
        eventType,
        aggregateId,
        occurredAt: new Date(),
        payload: {
          vendorId,
          paymentId: transaction._id.toString(),
          orderId: type === 'order' ? aggregateId : undefined,
          bookingId: type === 'booking' ? aggregateId : undefined,
          amount: paidAmount,
          currency: transaction.currencySnapshot,
          totalAmount,
          aggregateType
        }
      });

      console.log(`[PaymentOrchestrator] Emitted ${eventType} event for ${type} ${aggregateId}`);
    } catch (error: any) {
      console.error('[PaymentOrchestrator] Failed to emit payment event:', error);
      // Don't throw - this is a secondary operation
    }
  }

  /**
   * Emit a `payment.received.full` event for every order in a settled checkout
   * group. The single group payment covers each order's full total, so each
   * order is a full payment. Keyed per order/vendor so vendor notifications fire
   * independently. Secondary operation — never throws.
   */
  private async emitCartGroupPaymentEvents(transaction: IPaymentTransaction): Promise<void> {
    try {
      const orders = await OrderModel.find({ _id: { $in: transaction.orderIds } });
      for (const order of orders) {
        await eventBus.publish('payment.received.full', {
          eventType: 'payment.received.full',
          aggregateId: order._id.toString(),
          occurredAt: new Date(),
          payload: {
            vendorId: order.vendor_id.toString(),
            paymentId: transaction._id.toString(),
            orderId: order._id.toString(),
            cartId: transaction.cartId?.toString(),
            amount: order.total_amount,
            currency: transaction.currencySnapshot,
            totalAmount: order.total_amount,
            aggregateType: 'order'
          }
        });
      }
      console.log(`[PaymentOrchestrator] Emitted payment.received.full for ${orders.length} order(s) in cart group ${transaction.cartId}`);
    } catch (error: any) {
      console.error('[PaymentOrchestrator] Failed to emit cart-group payment events:', error);
      // Don't throw - this is a secondary operation
    }
  }
}
