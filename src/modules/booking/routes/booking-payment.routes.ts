import { Router, Request, Response } from 'express';
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
 * Initiate payment for a booking
 * 
 * SECURITY: Should verify user owns booking (add auth middleware in production)
 * IDEMPOTENT: Multiple calls return same transaction
 * 
 * Request body:
 * - gateway: 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE'
 * - channel: { phoneNumber?, phoneOperator?, customerEmail?, customerName? }
 */
router.post('/:id/pay', async (req: Request, res: Response) => {
  try {
    const { id: bookingId } = req.params;
    const { gateway, channel } = req.body;

    // Validate inputs
    if (!gateway || !channel) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: gateway and channel'
      });
    }

    // Validate gateway
    const validGateways: PaymentGatewayType[] = ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'];
    if (!validGateways.includes(gateway)) {
      return res.status(400).json({
        success: false,
        message: `Invalid gateway. Must be one of: ${validGateways.join(', ')}`
      });
    }

    // Load booking to verify ownership
    const booking = await Booking.findById(bookingId);
    
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // TODO: Add authentication middleware and verify ownership
    // if (booking.userId.toString() !== req.user.id) {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Unauthorized: You can only pay for your own bookings'
    //   });
    // }

    // Initiate payment
    const result = await paymentOrchestrator.initiateBookingPayment(
      bookingId,
      gateway,
      channel
    );

    res.status(200).json({
      success: true,
      data: result
    });

  } catch (error: any) {
    console.error('[BookingPaymentRoutes] Payment initiation error:', error);
    
    if (error instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * GET /api/bookings/:id/payment-status
 * 
 * Get payment status for a booking
 * 
 * Returns booking payment status and transaction details
 */
router.get('/:id/payment-status', async (req: Request, res: Response) => {
  try {
    const { id: bookingId } = req.params;

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Get payment transaction if exists
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
        transaction: transaction ? {
          id: transaction._id,
          status: transaction.status,
          gateway: transaction.gateway,
          gatewayRef: transaction.gatewayRef,
        } : null
      }
    });

  } catch (error: any) {
    console.error('[BookingPaymentRoutes] Get payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

/**
 * POST /api/vendor/bookings/:id/mark-paid
 * 
 * Vendor-only endpoint to mark cash booking as paid
 * 
 * SECURITY: In production, add vendor auth middleware
 * CREATES: Manual PaymentTransaction with method CASH
 * 
 * Request body:
 * - paymentMethod: 'cash' (required, must be 'cash')
 */
router.post('/vendor/:id/mark-paid', async (req: Request, res: Response) => {
  try {
    const { id: bookingId } = req.params;
    const { paymentMethod } = req.body;

    // Validate payment method
    if (paymentMethod !== 'cash') {
      return res.status(400).json({
        success: false,
        message: 'Only cash payments can be marked as paid manually'
      });
    }

    const booking = await Booking.findById(bookingId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // TODO: Add vendor authentication and verify ownership
    // if (booking.vendorId.toString() !== req.user.vendorId) {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Unauthorized: You can only mark your own bookings as paid'
    //   });
    // }

    // Check if already paid
    if (booking.paymentStatus === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Booking is already marked as paid'
      });
    }

    // Check if requires payment
    if (!booking.requiresPayment) {
      return res.status(400).json({
        success: false,
        message: 'This booking does not require payment'
      });
    }

    // Create manual payment transaction
    const transaction = await PaymentTransactionModel.create({
      bookingId: new Types.ObjectId(bookingId),
      userId: booking.userId,
      gateway: 'NOTCHPAY', // Placeholder, not used for cash
      method: 'CASH',
      status: 'SUCCEEDED',
      gatewayRef: `CASH-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      amountSnapshot: booking.priceSnapshot,
      currencySnapshot: booking.currency,
      idempotencyKey: `cash-${bookingId}-${Date.now()}`,
      rawGatewayPayloads: [{
        timestamp: new Date(),
        type: 'manual',
        source: 'vendor',
        note: 'Cash payment marked by vendor'
      }]
    });

    // Update booking
    booking.paymentStatus = 'paid';
    booking.paymentMethod = 'cash';
    booking.paymentTransactionId = transaction._id as Types.ObjectId;
    await booking.save();

    // Sync calendar
    const { BookingCalendarSyncService } = await import('../services/booking-calendar-sync.service');
    const calendarSync = new BookingCalendarSyncService();
    await calendarSync.syncBookingPaymentStatus(booking);

    res.status(200).json({
      success: true,
      message: 'Booking marked as paid',
      data: {
        bookingId: booking._id,
        paymentStatus: booking.paymentStatus,
        transactionId: transaction._id
      }
    });

  } catch (error: any) {
    console.error('[BookingPaymentRoutes] Mark paid error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

export const bookingPaymentRouter = router;
