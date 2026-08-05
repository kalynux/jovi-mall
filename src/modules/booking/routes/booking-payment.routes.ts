import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { InitiateBookingPaymentSchema } from '../../payments/validators/payment.validators';
import { Booking } from '../models/booking.model';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { Types } from 'mongoose';

const router = Router();
const paymentOrchestrator = new PaymentOrchestratorService();

/**
 * POST /api/bookings/:id/pay
 *
 * Initiate payment for a booking (customer-facing).
 * Customer must own the booking.
 *
 * Request body:
 * - gateway: 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE'
 * - channel: { phoneNumber?, phoneOperator?, customerEmail?, customerName? }
 */
router.post('/:id/pay', requireAuth, requireRole(['customer']), asyncHandler(async (req: Request, res: Response) => {
  const { id: bookingId } = req.params;
  // Same shared channel schema as /payments/initiate — a booking payment goes to
  // the same gateways, so the mobile-money number and receipt email are held to
  // the same rules rather than being forwarded as typed.
  const { gateway, channel } = InitiateBookingPaymentSchema.parse(req.body);

  const booking = await Booking.findById(bookingId);
  if (!booking)
    throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');

  // Verify the customer owns this booking
  if (booking.userId.toString() !== req.auth!.user._id.toString())
    throw createAppError(ERROR_CODES.BOOKING_UNAUTHORIZED, 403, 'Forbidden: You can only pay for your own bookings');

  const result = await paymentOrchestrator.initiateBookingPayment(bookingId, gateway, channel);
  res.status(200).json({ success: true, data: result });
}));

/**
 * GET /api/bookings/:id/payment-status
 *
 * Get payment status for a booking.
 * Accessible by the customer who owns the booking, or a vendor who owns the booking.
 */
router.get('/:id/payment-status', requireAuth, requireRole(['customer', 'vendor']), asyncHandler(async (req: Request, res: Response) => {
  const { id: bookingId } = req.params;
  const { role, role_entity, user } = req.auth!;

  const booking = await Booking.findById(bookingId);
  if (!booking)
    throw createAppError(ERROR_CODES.BOOKING_NOT_FOUND, 404, 'Booking not found');

  // Verify ownership: customer checks userId, vendor checks vendorId
  const isCustomer = role === 'customer' && booking.userId.toString() === user._id.toString();
  const isVendor = role === 'vendor' && booking.vendorId.toString() === role_entity._id.toString();

  if (!isCustomer && !isVendor)
    throw createAppError(ERROR_CODES.BOOKING_UNAUTHORIZED, 403, 'Forbidden: You do not have access to this booking');

  let transaction = null;
  if (booking.paymentTransactionId) {
    transaction = await PaymentTransactionModel.findById(booking.paymentTransactionId);
  }

  res.status(200).json({
    success: true,
    data: {
      bookingId: booking._id,
      paymentStatus: booking.paymentStatus,
      paymentMethod: booking.paymentMethod,
      priceSnapshot: booking.priceSnapshot,
      currency: booking.currency,
      requiresPayment: booking.requiresPayment,
      transaction: transaction ? { id: transaction._id, status: transaction.status, gateway: transaction.gateway, gatewayRef: transaction.gatewayRef } : null,
    },
  });
}));

export const bookingPaymentRouter = router;
