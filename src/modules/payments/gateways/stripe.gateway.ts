import {
  PaymentGateway,
  PaymentInitPayload,
  PaymentInitResult,
  PaymentVerifyPayload,
  PaymentVerifyResult,
  RefundPayload,
  RefundResult,
  PaymentGatewayStatus
} from './gateway.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';


/**
 * StripeGateway - Card Payment Gateway
 * 
 * Stripe Payment Intents API for card payments.
 * 
 * ADAPTER PATTERN:
 * - No business logic
 * - Pure Stripe API wrapper
 * - Normalizes Stripe responses to standard interface
 * 
 * FLOW:
 * 1. Create PaymentIntent (returns client_secret)
 * 2. Frontend confirms payment with Stripe.js
 * 3. Webhook notifies backend of status change
 * 4. Backend verifies payment status
 * 
 * API DOCS: https://stripe.com/docs/payments/payment-intents
 */
export class StripeGateway implements PaymentGateway {
  private secretKey: string;
  private apiVersion: string = '2023-10-16';

  constructor() {
    this.secretKey = process.env.STRIPE_SECRET_KEY || '';

    if (!this.secretKey) {
      console.warn('[StripeGateway] STRIPE_SECRET_KEY not configured');
    }
  }

  /**
   * Initiate card payment (create PaymentIntent)
   */
  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      // Create Stripe PaymentIntent
      const response = await this.callStripeAPI('/payment_intents', {
        amount: Math.round(payload.amount * 100), // Stripe uses smallest currency unit (cents)
        currency: payload.currency.toLowerCase(),
        metadata: {
          orderId: payload.orderId,
          userId: payload.userId,
          ...payload.metadata
        },
        description: `Order #${payload.orderId}`,
        receipt_email: payload.channel.customerEmail,
        // Automatic payment methods (card, etc.)
        automatic_payment_methods: {
          enabled: true
        }
      });

      // Successful PaymentIntent creation
      if (response.id) {
        const status = this.normalizeStripeStatus(response.status);

        return {
          success: true,
          gatewayRef: response.id,
          status,
          instructions: {
            clientSecret: response.client_secret,
            message: 'Complete payment with card on frontend',
          },
          rawResponse: response
        };
      }

      // Failed creation
      return {
        success: false,
        gatewayRef: '',
        status: 'FAILED' as PaymentGatewayStatus,
        error: response.error?.message || 'Payment intent creation failed',
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[StripeGateway] Initiate payment error:', error);
      return {
        success: false,
        gatewayRef: '',
        status: 'FAILED' as PaymentGatewayStatus,
        error: error.message || 'Gateway communication error',
        rawResponse: { error: error.message }
      };
    }
  }

  /**
   * Verify payment status (retrieve PaymentIntent)
   */
  async verifyPayment(payload: PaymentVerifyPayload): Promise<PaymentVerifyResult> {
    try {
      // Retrieve PaymentIntent from Stripe
      const response = await this.callStripeAPI(`/payment_intents/${payload.gatewayRef}`, null, 'GET');

      const status = this.normalizeStripeStatus(response.status);

      return {
        success: status === 'SUCCEEDED',
        status,
        transactionDetails: {
          paymentIntentId: response.id,
          amount: response.amount / 100, // Convert back from cents
          currency: response.currency,
          charges: response.charges?.data || []
        },
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[StripeGateway] Verify payment error:', error);
      return {
        success: false,
        status: 'FAILED' as PaymentGatewayStatus,
        error: error.message || 'Verification failed',
        rawResponse: { error: error.message }
      };
    }
  }

  /**
   * Refund payment
   */
  async refundPayment(payload: RefundPayload): Promise<RefundResult> {
    try {
      // Create refund
      const response = await this.callStripeAPI('/refunds', {
        payment_intent: payload.gatewayRef,
        amount: Math.round(payload.amount * 100), // Convert to cents
        reason: payload.reason,
        metadata: payload.metadata
      });

      return {
        success: response.status === 'succeeded',
        refundRef: response.id,
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[StripeGateway] Refund error:', error);
      return {
        success: false,
        error: error.message || 'Refund failed',
        rawResponse: { error: error.message }
      };
    }
  }

  /**
   * Normalize Stripe PaymentIntent status to standard status
   */
  private normalizeStripeStatus(stripeStatus: string): PaymentGatewayStatus {
    const statusMap: Record<string, PaymentGatewayStatus> = {
      'requires_payment_method': 'INITIATED',
      'requires_confirmation': 'INITIATED',
      'requires_action': 'PENDING',
      'processing': 'PENDING',
      'succeeded': 'SUCCEEDED',
      'canceled': 'CANCELLED',
      'requires_capture': 'PENDING', // For manual capture
    };

    return statusMap[stripeStatus] || 'FAILED';
  }

  /**
   * Call Stripe API
   * PLACEHOLDER - Replace with actual Stripe SDK or HTTP client
   */
  private async callStripeAPI(
    endpoint: string,
    data: any = null,
    method: 'GET' | 'POST' = 'POST'
  ): Promise<any> {
    // PLACEHOLDER IMPLEMENTATION
    // In production, use Stripe Node SDK or fetch with proper error handling

    console.log(`[StripeGateway] ${method} https://api.stripe.com/v1${endpoint}`, data);

    // If API key is not configured, return mock response
    if (!this.secretKey) {
      if (method === 'POST' && endpoint === '/payment_intents') {
        return {
          id: `pi_${Date.now()}`,
          status: 'requires_payment_method',
          client_secret: `pi_${Date.now()}_secret_${Math.random().toString(36).slice(2)}`,
          amount: data.amount,
          currency: data.currency
        };
      }

      return {
        id: `pi_${Date.now()}`,
        status: 'succeeded',
        amount: 100000,
        currency: 'xaf'
      };
    }

    // TODO: Implement actual Stripe SDK call
    // import Stripe from 'stripe';
    // const stripe = new Stripe(this.secretKey, { apiVersion: this.apiVersion });
    // 
    // if (endpoint === '/payment_intents' && method === 'POST') {
    //   return await stripe.paymentIntents.create(data);
    // }
    // if (endpoint.startsWith('/payment_intents/') && method === 'GET') {
    //   const id = endpoint.split('/')[2];
    //   return await stripe.paymentIntents.retrieve(id);
    // }
    // if (endpoint === '/refunds' && method === 'POST') {
    //   return await stripe.refunds.create(data);
    // }

    throw createAppError(ERROR_CODES.PAYMENT_GATEWAY_NOT_IMPLEMENTED, 501, 'Stripe integration not yet implemented. Add STRIPE_SECRET_KEY to .env');
  }
}
