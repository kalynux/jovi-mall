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
 * MyCoolPayGateway - Mobile Money Payment Gateway (Fallback)
 * 
 * Fallback mobile money gateway for MTN, Orange, Moov.
 * 
 * ADAPTER PATTERN:
 * - No business logic
 * - Pure gateway API wrapper
 * - Normalizes MyCoolPay responses to standard interface
 */
export class MyCoolPayGateway implements PaymentGateway {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env.MYCOOLPAY_API_KEY || '';
    this.baseUrl = process.env.MYCOOLPAY_BASE_URL || 'https://api.mycoolpay.com';

    if (!this.apiKey) {
      console.warn('[MyCoolPayGateway] MYCOOLPAY_API_KEY not configured');
    }
  }

  /**
   * Initiate mobile money payment
   */
  async initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult> {
    try {
      // MyCoolPay API call - THIS IS A PLACEHOLDER
      // Replace with actual MyCoolPay API integration
      const response = await this.callMyCoolPayAPI('/payments/init', {
        amount: payload.amount,
        currency: payload.currency,
        phone: payload.channel.phoneNumber,
        email: payload.channel.customerEmail,
        order_id: payload.orderId,
        reference: payload.metadata?.idempotencyKey,
      });

      // Normalize MyCoolPay response
      if (response.status === 'pending') {
        return {
          success: true,
          gatewayRef: response.payment_id,
          status: 'PENDING' as PaymentGatewayStatus,
          instructions: {
            ussdCode: response.ussd_code,
            message: response.instructions || 'Please complete payment on your phone',
            expiresAt: response.expires_at ? new Date(response.expires_at) : undefined
          },
          rawResponse: response
        };
      }

      if (response.status === 'success') {
        return {
          success: true,
          gatewayRef: response.payment_id,
          status: 'SUCCEEDED' as PaymentGatewayStatus,
          rawResponse: response
        };
      }

      // Failed initiation
      return {
        success: false,
        gatewayRef: response.payment_id || '',
        status: 'FAILED' as PaymentGatewayStatus,
        error: response.error_message || 'Payment initiation failed',
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[MyCoolPayGateway] Initiate payment error:', error);
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
      // MyCoolPay verification API call
      const response = await this.callMyCoolPayAPI(`/payments/${payload.gatewayRef}`, null, 'GET');

      const status = this.normalizeMyCoolPayStatus(response.status);

      return {
        success: status === 'SUCCEEDED',
        status,
        transactionDetails: response.payment_data,
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[MyCoolPayGateway] Verify payment error:', error);
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
      // MyCoolPay refund API call - PLACEHOLDER
      const response = await this.callMyCoolPayAPI('/payments/refund', {
        payment_id: payload.gatewayRef,
        amount: payload.amount,
        reason: payload.reason
      });

      return {
        success: response.status === 'success',
        refundRef: response.refund_id,
        rawResponse: response
      };

    } catch (error: any) {
      console.error('[MyCoolPayGateway] Refund error:', error);
      return {
        success: false,
        error: error.message || 'Refund failed',
        rawResponse: { error: error.message }
      };
    }
  }

  /**
   * Normalize MyCoolPay status to standard status
   */
  private normalizeMyCoolPayStatus(myCoolPayStatus: string): PaymentGatewayStatus {
    const statusMap: Record<string, PaymentGatewayStatus> = {
      'pending': 'PENDING',
      'processing': 'PENDING',
      'success': 'SUCCEEDED',
      'completed': 'SUCCEEDED',
      'failed': 'FAILED',
      'error': 'FAILED',
      'cancelled': 'CANCELLED',
    };

    return statusMap[myCoolPayStatus.toLowerCase()] || 'FAILED';
  }

  /**
   * Call MyCoolPay API
   * PLACEHOLDER - Replace with actual HTTP client implementation
   */
  private async callMyCoolPayAPI(
    endpoint: string, 
    data: any = null, 
    method: 'GET' | 'POST' = 'POST'
  ): Promise<any> {
    // PLACEHOLDER IMPLEMENTATION
    // In production, use axios or fetch with proper error handling
    
    console.log(`[MyCoolPayGateway] ${method} ${this.baseUrl}${endpoint}`, data);
    
    // If API key is not configured, return mock response
    if (!this.apiKey) {
      return {
        status: 'pending',
        payment_id: `MCOOL-${Date.now()}`,
        ussd_code: '*155#',
        instructions: 'Complete payment on your mobile phone'
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

    // eslint-disable-next-line no-restricted-syntax
    throw new Error('MyCoolPay API integration not implemented. Add API credentials to .env');
  }
}
