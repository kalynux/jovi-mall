import { Router, Request, Response } from 'express';
import { PaymentOrchestratorService } from '../services/payment-orchestrator.service';
import { PaymentGatewayType } from '../models/payment-transaction.model';
import { ValidationError } from '../../../core/errors';

const router = Router();
const paymentOrchestrator = new PaymentOrchestratorService();

/**
 * POST /payments/initiate
 * 
 * Initiate payment for an order
 * 
 * IDEMPOTENT: Multiple calls return existing transaction
 * 
 * REQUEST:
 * {
 *   orderId: string,
 *   gateway: 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE',
 *   channel: {
 *     phoneNumber?: string,
 *     phoneOperator?: 'MTN' | 'ORANGE' | 'MOOV',
 *     cardToken?: string,
 *     customerEmail?: string,
 *     customerName?: string
 *   }
 * }
 * 
 * RESPONSE:
 * {
 *   success: boolean,
 *   transactionId: string,
 *   status: string,
 *   instructions?: {
 *     ussdCode?: string,
 *     clientSecret?: string,
 *     message?: string
 *   },
 *   message: string
 * }
 */
router.post('/initiate', async (req: Request, res: Response) => {
  try {
    const { orderId, gateway, channel } = req.body;

    // Validation
    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: 'orderId is required'
      });
    }

    if (!gateway) {
      return res.status(400).json({
        success: false,
        error: 'gateway is required'
      });
    }

    if (!['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'].includes(gateway)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid gateway. Must be NOTCHPAY, MYCOOLPAY, or STRIPE'
      });
    }

    if (!channel) {
      return res.status(400).json({
        success: false,
        error: 'channel is required'
      });
    }

    // Mobile money validation
    if (gateway !== 'STRIPE' && !channel.phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber is required for mobile money payments'
      });
    }

    // Initiate payment
    const result = await paymentOrchestrator.initiatePayment(
      orderId,
      gateway as PaymentGatewayType,
      channel
    );

    res.status(200).json({
      success: result.status !== 'FAILED',
      ...result
    });

  } catch (error: any) {
    console.error('[PaymentRoutes] Initiate payment error:', error);
    
    if (error instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * POST /payments/verify
 * 
 * Verify payment status
 * 
 * IDEMPOTENT: Can be called multiple times
 * 
 * REQUEST:
 * {
 *   transactionId: string
 * }
 * 
 * RESPONSE:
 * {
 *   success: boolean,
 *   transactionId: string,
 *   status: string,
 *   message: string
 * }
 */
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.body;

    // Validation
    if (!transactionId) {
      return res.status(400).json({
        success: false,
        error: 'transactionId is required'
      });
    }

    // Verify payment
    const result = await paymentOrchestrator.verifyPayment(transactionId);

    res.status(200).json({
      success: result.status === 'SUCCEEDED',
      ...result
    });

  } catch (error: any) {
    console.error('[PaymentRoutes] Verify payment error:', error);
    
    if (error instanceof ValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

/**
 * GET /payments/:transactionId
 * 
 * Get payment transaction details
 * 
 * RESPONSE:
 * {
 *   success: boolean,
 *   transaction: { ... }
 * }
 */
router.get('/:transactionId', async (req: Request, res: Response) => {
  try {
    const { transactionId } = req.params;

    const { PaymentTransactionModel } = await import('../models/payment-transaction.model');
    const transaction = await PaymentTransactionModel.findById(transactionId)
      .select('-rawGatewayPayloads') // Exclude sensitive gateway data
      .lean();

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found'
      });
    }

    res.status(200).json({
      success: true,
      transaction
    });

  } catch (error: any) {
    console.error('[PaymentRoutes] Get transaction error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

export const paymentRouter = router;
