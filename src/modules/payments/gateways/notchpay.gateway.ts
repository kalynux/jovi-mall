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

/**
 * NotchPayGateway - Mobile Money Payment Gateway
 * 
 * Primary mobile money gateway for MTN, Orange, Moov.
 * 
 * ADAPTER PATTERN:
 * - No business logic
 * - Pure gateway API wrapper
 * - Normalizes NotchPay responses to standard interface
 * 
 * API DOCS: https://developers.notchpay.co
 */
export class NotchPayGateway implements PaymentGateway {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.NOTCHPAY_API_KEY || '';
    this.baseUrl = process.env.NOTCHPAY_BASE_URL || 'https://api.notchpay.co';

    if (!this.apiKey) {
      console.warn('[NotchPayGateway] NOTCHPAY_API_KEY not configured');
    }
  }

  /**
   * Initiate mobile money payment
   */
  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      // NotchPay API call - THIS IS A PLACEHOLDER
      // Replace with actual NotchPay API integration
      const response = await this.callNotchPayAPI('/payments', {
        amount: payload.amount,
        currency: payload.currency,
        phone: payload.channel.phoneNumber,
        email: payload.channel.customerEmail,
        description: `Order #${payload.orderId}`,
        reference: payload.metadata?.idempotencyKey,
      });

      // Normalize NotchPay response
      if (response.status === 'pending') {
        return {
          success: true,
          gatewayRef: response.transaction.reference,
          status: 'PENDING' as PaymentGatewayStatus,
          instructions: {
            ussdCode: response.ussd_code,
            message: response.message || 'Please dial the USSD code to complete payment',
            expiresAt: response.expires_at ? new Date(response.expires_at) : undefined
          },
          rawResponse: response
        };
      }

      if (response.status === 'complete') {
        return {
          success: true,
          gatewayRef: response.transaction.reference,
          status: 'SUCCEEDED' as PaymentGatewayStatus,
          rawResponse: response
        };
      }

      // Failed initiation
      return {
        success: false,
        gatewayRef: response.transaction?.reference || '',
        status: 'FAILED' as PaymentGatewayStatus,
        error: response.message || 'Payment initiation failed',
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[NotchPayGateway] Initiate payment error:', error);
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
   * Verify payment status
   */
  async verifyPayment(payload: PaymentVerifyPayload): Promise<PaymentVerifyResult> {
    try {
      // NotchPay verification API call
      const response = await this.callNotchPayAPI(`/payments/${payload.gatewayRef}`, null, 'GET');

      const status = this.normalizeNotchPayStatus(response.status);

      return {
        success: status === 'SUCCEEDED',
        status,
        transactionDetails: response.transaction,
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[NotchPayGateway] Verify payment error:', error);
      return {
        success: false,
        status: 'FAILED' as PaymentGatewayStatus,
        error: error.message || 'Verification failed',
        rawResponse: { error: error.message }
      };
    }
  }

  /**
   * Refund payment (NotchPay may not support this immediately)
   */
  async refundPayment(payload: RefundPayload): Promise<RefundResult> {
    try {
      // NotchPay refund API call - PLACEHOLDER
      const response = await this.callNotchPayAPI('/refunds', {
        transaction_reference: payload.gatewayRef,
        amount: payload.amount,
        reason: payload.reason
      });

      return {
        success: response.status === 'success',
        refundRef: response.refund?.reference,
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[NotchPayGateway] Refund error:', error);
      return {
        success: false,
        error: error.message || 'Refund failed',
        rawResponse: { error: error.message }
      };
    }
  }

  /**
   * Normalize NotchPay status to standard status
   */
  private normalizeNotchPayStatus(notchPayStatus: string): PaymentGatewayStatus {
    const statusMap: Record<string, PaymentGatewayStatus> = {
      'pending': 'PENDING',
      'complete': 'SUCCEEDED',
      'completed': 'SUCCEEDED',
      'success': 'SUCCEEDED',
      'failed': 'FAILED',
      'error': 'FAILED',
      'cancelled': 'CANCELLED',
      'canceled': 'CANCELLED',
    };

    return statusMap[notchPayStatus.toLowerCase()] || 'FAILED';
  }

  /**
   * Call NotchPay API
   * PLACEHOLDER - Replace with actual HTTP client implementation
   */
  private async callNotchPayAPI(
    endpoint: string, 
    data: any = null, 
    method: 'GET' | 'POST' = 'POST'
  ): Promise<any> {
    // PLACEHOLDER IMPLEMENTATION
    // In production, use axios or fetch with proper error handling
    
    console.log(`[NotchPayGateway] ${method} ${this.baseUrl}${endpoint}`, data);
    
    // If API key is not configured, return mock response
    if (!this.apiKey) {
      return {
        status: 'pending',
        transaction: { reference: `NOTCH-${Date.now()}` },
        ussd_code: '*126#',
        message: 'Dial USSD code to complete payment'
      };
    }

    // TODO: Implement actual HTTP call
    // const response = await fetch(`${this.baseUrl}${endpoint}`, {
    //   method,
    //   headers: {
    //     'Authorization': `Bearer ${this.apiKey}`,
    //     'Content-Type': 'application/json'
    //   },
    //   body: data ? JSON.stringify(data) : undefined
    // });
    // return await response.json();

    throw new Error('NotchPay API integration not implemented. Add API credentials to .env');
  }
}
