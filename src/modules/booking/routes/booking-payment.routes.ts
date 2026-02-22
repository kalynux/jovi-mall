import { Router, Request, Response } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { PaymentOrchestratorService } from '../../payments/services/payment-orchestrator.service';
import { PaymentGatewayType } from '../../payments/models/payment-transaction.model';
import { Booking } from '../models/booking.model';
import { PaymentTransactionModel } from '../../payments/models/payment-transaction.model';
import { ValidationError } from '../../../core/errors';
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
router.post('/:id/pay', requireAuth, requireRole(['customer']), async (req: Request, res: Response) => {
  try {
    const { id: bookingId } = req.params;
    const { gateway, channel } = req.body;
    const customerId = req.auth!.role_entity._id.toString();

    if (!gateway || !channel) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: gateway and channel',
      });
    }

    const validGateways: PaymentGatewayType[] = ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'];
    if (!validGateways.includes(gateway)) {
      return res.status(400).json({
        success: false,
        message: `Invalid gateway. Must be one of: ${validGateways.join(', ')}`,
      });
    }

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    // Verify the customer owns this booking
    if (booking.userId.toString() !== req.auth!.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You can only pay for your own bookings',
      });
    }

    const result = await paymentOrchestrator.initiateBookingPayment(bookingId, gateway, channel);

    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    console.error('[BookingPaymentRoutes] Payment initiation error:', error);

    if (error instanceof ValidationError) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /api/bookings/:id/payment-status
 *
 * Get payment status for a booking.
 * Accessible by the customer who owns the booking, or a vendor who owns the booking.
 */
router.get('/:id/payment-status', requireAuth, requireRole(['customer', 'vendor']), async (req: Request, res: Response) => {
  try {
    const { id: bookingId } = req.params;
    const { role, role_entity, user } = req.auth!;

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    // Verify ownership: customer checks userId, vendor checks vendorId
    const isCustomer = role === 'customer' && booking.userId.toString() === user._id.toString();
    const isVendor = role === 'vendor' && booking.vendorId.toString() === role_entity._id.toString();

    if (!isCustomer && !isVendor) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You do not have access to this booking',
      });
    }

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
        transaction: transaction
          ? {
            id: transaction._id,
            status: transaction.status,
            gateway: transaction.gateway,
            gatewayRef: transaction.gatewayRef,
          }
          : null,
      },
    });
  } catch (error: any) {
    console.error('[BookingPaymentRoutes] Get payment status error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export const bookingPaymentRouter = router;
