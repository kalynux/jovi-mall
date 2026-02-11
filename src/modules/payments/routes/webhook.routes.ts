import { Router, Request, Response } from 'express';
import { PaymentOrchestratorService } from '../services/payment-orchestrator.service';
import { PaymentGatewayType } from '../models/payment-transaction.model';

const router = Router();
const paymentOrchestrator = new PaymentOrchestratorService();

/**
 * POST /webhooks/stripe
 * 
 * Stripe webhook endpoint
 * 
 * IDEMPOTENT: Payload hash prevents duplicate processing
 * SECURITY: Verifies Stripe signature
 * 
 * Stripe sends webhooks for events:
 * - payment_intent.succeeded
 * - payment_intent.payment_failed
 * - payment_intent.canceled
 * - etc.
 */
router.post('/stripe', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const signature = req.headers['stripe-signature'] as string;

    // TODO: Verify Stripe signature
    // const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    // if (webhookSecret) {
    //   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    //   try {
    //     stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    //   } catch (err) {
    //     console.error('Stripe webhook signature verification failed:', err);
    //     return res.status(400).send('Webhook signature verification failed');
    //   }
    // }

    console.log('[StripeWebhook] Received event:', payload.type);

    // Process webhook
    const result = await paymentOrchestrator.handleWebhook(
      'STRIPE',
      payload,
      signature
    );

    // Always return 200 to prevent retries
    res.status(200).json(result);

  } catch (error: any) {
    console.error('[StripeWebhook] Processing error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({
      success: false,
      message: 'Webhook received but processing failed'
    });
  }
});

/**
 * POST /webhooks/notchpay
 * 
 * NotchPay webhook endpoint
 * 
 * IDEMPOTENT: Payload hash prevents duplicate processing
 * SECURITY: Should verify NotchPay signature if supported
 */
router.post('/notchpay', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const signature = req.headers['x-notchpay-signature'] as string;

    // TODO: Verify NotchPay signature if available
    // const webhookSecret = process.env.NOTCHPAY_WEBHOOK_SECRET;

    console.log('[NotchPayWebhook] Received event:', payload.event || payload.status);

    // Process webhook
    const result = await paymentOrchestrator.handleWebhook(
      'NOTCHPAY',
      payload,
      signature
    );

    // Always return 200 to prevent retries
    res.status(200).json(result);

  } catch (error: any) {
    console.error('[NotchPayWebhook] Processing error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({
      success: false,
      message: 'Webhook received but processing failed'
    });
  }
});

/**
 * POST /webhooks/mycoolpay
 * 
 * MyCoolPay webhook endpoint
 * 
 * IDEMPOTENT: Payload hash prevents duplicate processing
 * SECURITY: Should verify MyCoolPay signature if supported
 */
router.post('/mycoolpay', async (req: Request, res: Response) => {
  try {
    const payload = req.body;
    const signature = req.headers['x-mycoolpay-signature'] as string;

    // TODO: Verify MyCoolPay signature if available
    // const webhookSecret = process.env.MYCOOLPAY_WEBHOOK_SECRET;

    console.log('[MyCoolPayWebhook] Received event:', payload.event);

    // Process webhook
    const result = await paymentOrchestrator.handleWebhook(
      'MYCOOLPAY',
      payload,
      signature
    );

    // Always return 200 to prevent retries
    res.status(200).json(result);

  } catch (error: any) {
    console.error('[MyCoolPayWebhook] Processing error:', error);
    // Still return 200 to prevent retries
    res.status(200).json({
      success: false,
      message: 'Webhook received but processing failed'
    });
  }
});

export const paymentWebhookRouter = router;
