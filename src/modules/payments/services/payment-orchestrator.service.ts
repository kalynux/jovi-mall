import crypto from 'crypto';
import { Types } from 'mongoose';
import {
  PaymentTransactionModel,
  IPaymentTransaction,
  PaymentStatus,
  PaymentGatewayType
} from '../models/payment-transaction.model';
import { PaymentGateway, PaymentChannelInfo } from '../gateways/gateway.interface';
import { NotchPayGateway } from '../gateways/notchpay.gateway';
import { MyCoolPayGateway } from '../gateways/mycoolpay.gateway';
import { StripeGateway } from '../gateways/stripe.gateway';
import { OrderRepository } from '../../orders/order.repository';
import { OrderService } from '../../orders/order.service';
import { OrderModel } from '../../orders/order.model';
import { Booking, IBooking } from '../../booking/models/booking.model';
import { BookingCalendarSyncService } from '../../booking/services/booking-calendar-sync.service';
import { RefundTransactionModel } from '../models/refund-transaction.model';
import { createAppError } from '../../../core/errors';
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
  private gateways: Map<PaymentGatewayType, PaymentGateway>;

  constructor() {
    this.orderRepo = new OrderRepository();
    this.orderService = new OrderService();
    this.calendarSync = new BookingCalendarSyncService();

    // Initialize gateways
    this.gateways = new Map();
    this.gateways.set('NOTCHPAY', new NotchPayGateway());
    this.gateways.set('MYCOOLPAY', new MyCoolPayGateway());
    this.gateways.set('STRIPE', new StripeGateway());
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
        const lastPayload = existingTx.rawGatewayPayloads[existingTx.rawGatewayPayloads.length - 1];

        return {
          transactionId: existingTx._id.toString(),
          status: existingTx.status,
          instructions: lastPayload?.instructions,
          message: 'Payment already initiated. Complete the pending payment.'
        };
      }

      // Failed/cancelled - allow retry with new transaction
      // Fall through to create new transaction
    }

    // 4. CREATE NEW PAYMENT TRANSACTION
    const gatewayInstance = this.gateways.get(gateway);
    if (!gatewayInstance) {
      throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, undefined, { gateway });
    }

    // Determine payment method
    const method = gateway === 'STRIPE' ? 'CARD' : 'MOBILE';

    // Create transaction in INITIATED state
    const transaction = await PaymentTransactionModel.create({
      orderId: new Types.ObjectId(orderId),
      userId: new Types.ObjectId(userId),
      gateway,
      method,
      status: 'INITIATED',
      gatewayRef: '', // Will be updated after gateway call
      amountSnapshot: order.total_amount,
      currencySnapshot: order.currency,
      idempotencyKey,
      rawGatewayPayloads: []
    });

    // 5. CALL GATEWAY
    try {
      const gatewayResult = await gatewayInstance.initiatePayment({
        orderId,
        userId,
        amount: order.total_amount,
        currency: order.currency,
        channel,
        metadata: { idempotencyKey }
      });

      // 6. UPDATE TRANSACTION WITH GATEWAY RESPONSE
      transaction.gatewayRef = gatewayResult.gatewayRef;
      transaction.status = gatewayResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'initiate',
        ...gatewayResult.rawResponse
      });

      // Compute payload hash for webhook deduplication
      transaction.gatewayPayloadHash = this.hashPayload(gatewayResult.rawResponse);

      await transaction.save();

      // 7. UPDATE ORDER STATUS
      if (order.payment_status === 'pending') {
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
      transaction.status = 'FAILED';
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'error',
        error: error.message
      });
      await transaction.save();

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
        const lastPayload = existingTx.rawGatewayPayloads[existingTx.rawGatewayPayloads.length - 1];
        return {
          transactionId: existingTx._id.toString(),
          status: existingTx.status,
          instructions: lastPayload?.instructions,
          message: 'Payment already initiated. Complete the pending payment.'
        };
      }
      // Failed/cancelled → fall through to a fresh transaction
    }

    // 4. CREATE NEW PAYMENT TRANSACTION (group)
    const gatewayInstance = this.gateways.get(gateway);
    if (!gatewayInstance) {
      throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, undefined, { gateway });
    }

    const method = gateway === 'STRIPE' ? 'CARD' : 'MOBILE';

    const transaction = await PaymentTransactionModel.create({
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
      rawGatewayPayloads: []
    });

    // 5. CALL GATEWAY ONCE for the group total (cartId is the external reference)
    try {
      const gatewayResult = await gatewayInstance.initiatePayment({
        orderId: cartId,
        userId,
        amount: groupTotal,
        currency,
        channel,
        metadata: { idempotencyKey, cartId }
      });

      transaction.gatewayRef = gatewayResult.gatewayRef;
      transaction.status = gatewayResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'initiate',
        ...gatewayResult.rawResponse
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
      transaction.status = 'FAILED';
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'error',
        error: error.message
      });
      await transaction.save();

      throw createAppError(ERROR_CODES.PAYMENT_INITIATION_FAILED, 502, undefined, { cause: error.message });
    }
  }

  /**
   * Refund a paid order (full or partial).
   *
   * Eligibility against the vendor's return policy is the CALLER's responsibility
   * (see VendorRefundService); this method enforces the money invariants and
   * orchestrates the gateway call + persistence:
   *
   * 1. Resolve the SUCCEEDED PaymentTransaction for the order.
   * 2. Validate the requested amount against the remaining refundable balance.
   * 3. Create a pending RefundTransaction.
   * 4. Call the gateway's refund API (outside any DB transaction).
   * 5. On success: atomically finalize the refund, bump totalRefunded /
   *    hasPartialRefund, flip the payment + order status to refunded when fully
   *    refunded. On failure: mark the refund failed and throw.
   *
   * @returns A summary of the refund outcome.
   */
  async refundPayment(params: {
    orderId: string;
    vendorId: string;
    initiatedBy: string;   // vendor user id
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
    const { orderId, vendorId, initiatedBy, amount, reason } = params;

    // 1. Resolve the successful payment for this order.
    const paymentTx = await PaymentTransactionModel.findOne({
      orderId: new Types.ObjectId(orderId),
      status: 'SUCCEEDED'
    });
    if (!paymentTx) {
      throw createAppError(ERROR_CODES.REFUND_PAYMENT_NOT_FOUND, 404);
    }

    // 2. Validate amount against remaining refundable balance.
    const remaining = paymentTx.amountSnapshot - paymentTx.totalRefunded;
    if (remaining <= 0) {
      throw createAppError(ERROR_CODES.REFUND_ALREADY_FULLY_REFUNDED, 409);
    }
    if (amount <= 0 || amount > remaining) {
      throw createAppError(ERROR_CODES.REFUND_AMOUNT_EXCEEDS_MAX, 400, undefined, {
        requested: amount,
        remaining
      });
    }

    // 3. Resolve the gateway adapter; not all support refunds yet.
    const gatewayInstance = this.gateways.get(paymentTx.gateway);
    if (!gatewayInstance || typeof gatewayInstance.refundPayment !== 'function') {
      throw createAppError(ERROR_CODES.REFUND_GATEWAY_NOT_SUPPORTED, 400, undefined, {
        gateway: paymentTx.gateway
      });
    }

    // 4. Create the refund record in 'pending' state (audit trail before gateway call).
    const refund = await RefundTransactionModel.create({
      paymentTransactionId: paymentTx._id,
      orderId: new Types.ObjectId(orderId),
      vendorId: new Types.ObjectId(vendorId),
      userId: paymentTx.userId,
      refundAmount: amount,
      currency: paymentTx.currencySnapshot,
      reason,
      status: 'pending',
      gateway: paymentTx.gateway,
      initiatedBy: new Types.ObjectId(initiatedBy),
      initiatedByRole: 'vendor'
    });

    // 5. Call the gateway (external; kept outside the DB transaction).
    const gatewayResult = await gatewayInstance.refundPayment({
      gatewayRef: paymentTx.gatewayRef,
      amount,
      reason,
      metadata: { orderId, vendorId, refundId: refund._id.toString() }
    });

    if (!gatewayResult.success) {
      refund.status = 'failed';
      await refund.save();
      throw createAppError(ERROR_CODES.REFUND_GATEWAY_FAILED, 502, undefined, {
        error: gatewayResult.error
      });
    }

    // 6. Finalize atomically: refund record + payment totals + order status.
    const newTotalRefunded = paymentTx.totalRefunded + amount;
    const fullyRefunded = newTotalRefunded >= paymentTx.amountSnapshot;

    await transactionManager.runInTransaction(async (session) => {
      refund.status = 'completed';
      refund.completedAt = new Date();
      refund.gatewayRefundRef = gatewayResult.refundRef;
      await refund.save({ session });

      paymentTx.totalRefunded = newTotalRefunded;
      paymentTx.hasPartialRefund = !fullyRefunded && newTotalRefunded > 0;
      if (fullyRefunded) {
        paymentTx.status = 'REFUNDED';
      }
      await paymentTx.save({ session });

      // Order payment_status only flips to 'refunded' on a full refund.
      if (fullyRefunded) {
        await OrderModel.updateOne(
          { _id: new Types.ObjectId(orderId) },
          { $set: { payment_status: 'refunded', updated_at: new Date() } },
          { session }
        );
      }
    });

    // On a full refund, reverse this order's still-held earnings out of escrow.
    // Best-effort: a failure must not fail the (already-completed) refund.
    if (fullyRefunded) {
      try {
        await earningsRefundService.onRefund('order', orderId);
      } catch (error) {
        console.error('[PaymentOrchestrator] Failed to reverse earnings on refund:', error);
      }
    }

    // 7. Emit a domain event (fire-and-forget).
    eventBus.publish('payment.refunded', {
      eventType: 'payment.refunded',
      aggregateId: orderId,
      payload: {
        orderId,
        vendorId,
        refundId: refund._id.toString(),
        amount,
        currency: paymentTx.currencySnapshot,
        fullyRefunded
      },
      occurredAt: new Date()
    }).catch(() => { /* non-blocking */ });

    return {
      refundId: refund._id.toString(),
      status: 'completed',
      amount,
      currency: paymentTx.currencySnapshot,
      totalRefunded: newTotalRefunded,
      fullyRefunded
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
        const lastPayload = existingTx.rawGatewayPayloads[existingTx.rawGatewayPayloads.length - 1];

        return {
          transactionId: existingTx._id.toString(),
          status: existingTx.status,
          instructions: lastPayload?.instructions,
          message: 'Payment already initiated. Complete the pending payment.'
        };
      }

      // Failed/cancelled - allow retry with new transaction
      // Fall through to create new transaction
    }

    // 5. CREATE NEW PAYMENT TRANSACTION
    const gatewayInstance = this.gateways.get(gateway);
    if (!gatewayInstance) {
      throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, undefined, { gateway });
    }

    // Determine payment method
    const method = gateway === 'STRIPE' ? 'CARD' : 'MOBILE';

    // Create transaction in INITIATED state
    const transaction = await PaymentTransactionModel.create({
      bookingId: new Types.ObjectId(bookingId),
      userId: new Types.ObjectId(userId),
      gateway,
      method,
      status: 'INITIATED',
      gatewayRef: '', // Will be updated after gateway call
      amountSnapshot: booking.priceSnapshot,
      currencySnapshot: booking.currency,
      idempotencyKey,
      rawGatewayPayloads: []
    });

    // 6. CALL GATEWAY
    try {
      const gatewayResult = await gatewayInstance.initiatePayment({
        orderId: bookingId, // Gateway uses this as reference ID
        userId,
        amount: booking.priceSnapshot,
        currency: booking.currency,
        channel,
        metadata: { idempotencyKey, bookingId }
      });

      // 7. UPDATE TRANSACTION WITH GATEWAY RESPONSE
      transaction.gatewayRef = gatewayResult.gatewayRef;
      transaction.status = gatewayResult.status as PaymentStatus;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'initiate',
        ...gatewayResult.rawResponse
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
      transaction.status = 'FAILED';
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'error',
        error: error.message
      });
      await transaction.save();

      // Update booking payment status
      booking.paymentStatus = 'failed';
      await booking.save();

      throw createAppError(ERROR_CODES.PAYMENT_INITIATION_FAILED, 502, undefined, { cause: error.message });
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
    const gatewayInstance = this.gateways.get(transaction.gateway);
    if (!gatewayInstance) {
      throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, undefined, { gateway: transaction.gateway });
    }

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
  async handleWebhook(
    gateway: PaymentGatewayType,
    payload: any,
    signature?: string
  ): Promise<{ success: boolean; message: string }> {
    try {
      // 1. VERIFY SIGNATURE (gateway-specific)
      // TODO: Implement signature verification for each gateway
      // For now, we skip this in development

      // 2. EXTRACT GATEWAY REFERENCE
      let gatewayRef: string;
      let eventType: string;
      let newStatus: PaymentStatus;

      // Gateway-specific payload parsing
      if (gateway === 'STRIPE') {
        gatewayRef = payload.data?.object?.id || payload.id;
        eventType = payload.type;

        // Map Stripe events to our status
        if (eventType === 'payment_intent.succeeded') {
          newStatus = 'SUCCEEDED';
        } else if (eventType === 'payment_intent.payment_failed') {
          newStatus = 'FAILED';
        } else if (eventType === 'payment_intent.canceled') {
          newStatus = 'CANCELLED';
        } else {
          newStatus = 'PENDING';
        }
      } else if (gateway === 'NOTCHPAY') {
        gatewayRef = payload.transaction?.reference || payload.reference;
        eventType = payload.event || payload.status;
        newStatus = this.mapNotchPayStatus(payload.status);
      } else if (gateway === 'MYCOOLPAY') {
        gatewayRef = payload.payment_id;
        eventType = payload.event;
        newStatus = this.mapMyCoolPayStatus(payload.status);
      } else {
        throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, undefined, { gateway });
      }

      if (!gatewayRef) {
        throw createAppError(ERROR_CODES.PAYMENT_WEBHOOK_INVALID_PAYLOAD, 400);
      }

      // 3. FIND TRANSACTION
      const transaction = await PaymentTransactionModel.findOne({
        gateway,
        gatewayRef
      });

      if (!transaction) {
        console.warn(`[PaymentOrchestrator] Webhook for unknown transaction: ${gatewayRef}`);
        return { success: true, message: 'Transaction not found (may be from different system)' };
      }

      // 4. CHECK PAYLOAD HASH (IDEMPOTENCY)
      const payloadHash = this.hashPayload(payload);

      if (transaction.gatewayPayloadHash === payloadHash) {
        console.log(`[PaymentOrchestrator] Duplicate webhook detected for transaction ${transaction._id}`);
        return { success: true, message: 'Webhook already processed (duplicate)' };
      }

      // 5. UPDATE TRANSACTION
      const previousStatus = transaction.status;
      transaction.status = newStatus;
      transaction.gatewayPayloadHash = payloadHash;
      transaction.rawGatewayPayloads.push({
        timestamp: new Date(),
        type: 'webhook',
        event: eventType,
        ...payload
      });

      await transaction.save();

      // 6. TRIGGER FULFILLMENT IF PAYMENT SUCCEEDED
      if (newStatus === 'SUCCEEDED' && previousStatus !== 'SUCCEEDED') {
        await this.handlePaymentSuccess(transaction);
      }

      console.log(`[PaymentOrchestrator] Webhook processed for transaction ${transaction._id}: ${previousStatus} → ${newStatus}`);

      return { success: true, message: 'Webhook processed successfully' };

    } catch (error: any) {
      console.error('[PaymentOrchestrator] Webhook processing error:', error);
      return { success: false, message: error.message };
    }
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

  /**
   * Map NotchPay status to our status
   */
  private mapNotchPayStatus(status: string): PaymentStatus {
    const map: Record<string, PaymentStatus> = {
      'pending': 'PENDING',
      'complete': 'SUCCEEDED',
      'completed': 'SUCCEEDED',
      'success': 'SUCCEEDED',
      'failed': 'FAILED',
      'cancelled': 'CANCELLED'
    };
    return map[status?.toLowerCase()] || 'FAILED';
  }

  /**
   * Map MyCoolPay status to our status
   */
  private mapMyCoolPayStatus(status: string): PaymentStatus {
    const map: Record<string, PaymentStatus> = {
      'pending': 'PENDING',
      'processing': 'PENDING',
      'success': 'SUCCEEDED',
      'completed': 'SUCCEEDED',
      'failed': 'FAILED',
      'cancelled': 'CANCELLED'
    };
    return map[status?.toLowerCase()] || 'FAILED';
  }

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
