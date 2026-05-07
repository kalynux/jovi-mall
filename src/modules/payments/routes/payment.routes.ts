import { Router, Request, Response, NextFunction } from 'express';
import { PaymentOrchestratorService } from '../services/payment-orchestrator.service';
import { PaymentGatewayType } from '../models/payment-transaction.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { asyncHandler } from '../../../api/middlewares/async-handler';

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
router.post('/initiate', asyncHandler(async (req: Request, res: Response) => {
  const { orderId, gateway, channel } = req.body;

  if (!orderId) throw createAppError(ERROR_CODES.PAYMENT_ORDER_NOT_FOUND, 400, 'orderId is required');
  if (!gateway) throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, 'gateway is required');
  if (!['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'].includes(gateway)) {
    throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, 'Invalid gateway. Must be NOTCHPAY, MYCOOLPAY, or STRIPE');
  }
  if (!channel) throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, 'channel is required');
  if (gateway !== 'STRIPE' && !channel.phoneNumber) {
    throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_SUPPORTED, 400, 'phoneNumber is required for mobile money payments');
  }

  const result = await paymentOrchestrator.initiatePayment(
    orderId,
    gateway as PaymentGatewayType,
    channel
  );

  res.status(200).json({ success: result.status !== 'FAILED', ...result });
}));

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
router.post('/verify', asyncHandler(async (req: Request, res: Response) => {
  const { transactionId } = req.body;

  if (!transactionId) throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 400, 'transactionId is required');

  const result = await paymentOrchestrator.verifyPayment(transactionId);

  res.status(200).json({ success: result.status === 'SUCCEEDED', ...result });
}));

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
router.get('/:transactionId', asyncHandler(async (req: Request, res: Response) => {
  const { transactionId } = req.params;

  const { PaymentTransactionModel } = await import('../models/payment-transaction.model');
  const transaction = await PaymentTransactionModel.findById(transactionId)
    .select('-rawGatewayPayloads')
    .lean();

  if (!transaction) {
    throw createAppError(ERROR_CODES.PAYMENT_TRANSACTION_NOT_FOUND, 404, 'Transaction not found');
  }

  res.status(200).json({ success: true, transaction });
}));

export const paymentRouter = router;
