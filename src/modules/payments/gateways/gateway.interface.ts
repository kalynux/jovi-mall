/**
 * Payment Gateway Interface
 * 
 * Gateway-agnostic abstraction for payment processing.
 * All gateways (NotchPay, MyCoolPay, Stripe) implement this interface.
 * 
 * DESIGN PRINCIPLES:
 * - Pure adapter pattern (no business logic in implementations)
 * - Normalized responses (orchestrator handles all differences)
 * - Stateless (all state in PaymentTransaction model)
 */

export interface PaymentInitPayload {
  orderId: string;
  userId: string;
  amount: number;
  currency: string;
  channel: PaymentChannelInfo;
  metadata?: Record<string, any>;
}

export interface PaymentChannelInfo {
  // For mobile money (NotchPay, MyCoolPay)
  phoneNumber?: string;
  phoneOperator?: 'MTN' | 'ORANGE' | 'MOOV';
  
  // For card (Stripe)
  cardToken?: string;
  
  // Common
  customerEmail?: string;
  customerName?: string;
}

export interface PaymentInitResult {
  success: boolean;
  gatewayRef: string;           // Gateway's transaction reference
  status: PaymentGatewayStatus; // Normalized status
  instructions?: PaymentInstructions;
  error?: string;
  rawResponse: any;             // Original gateway response
}

export interface PaymentInstructions {
  // For mobile money
  ussdCode?: string;            // e.g., "*126#"
  message?: string;             // User instructions
  
  // For card (Stripe)
  clientSecret?: string;        // For frontend confirmation
  
  // Common
  expiresAt?: Date;             // Payment session expiry
}

export interface PaymentVerifyPayload {
  gatewayRef: string;
  metadata?: Record<string, any>;
}

export interface PaymentVerifyResult {
  success: boolean;
  status: PaymentGatewayStatus;
  transactionDetails?: any;
  error?: string;
  rawResponse: any;
}

export interface RefundPayload {
  gatewayRef: string;
  amount: number;
  reason?: string;
  metadata?: Record<string, any>;
}

export interface RefundResult {
  success: boolean;
  refundRef?: string;
  error?: string;
  rawResponse: any;
}

/**
 * Gateway-normalized status
 * Maps to PaymentTransaction.status
 */
export type PaymentGatewayStatus = 
  | 'INITIATED'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

/**
 * PaymentGateway Interface
 * 
 * All payment gateways must implement this interface.
 */
export interface PaymentGateway {
  /**
   * Initiate a new payment
   * @param payload - Payment initiation data
   * @returns Normalized payment initiation result
   */
  initiatePayment(payload: PaymentInitPayload): Promise<PaymentInitResult>;
  
  /**
   * Verify payment status
   * @param payload - Verification data
   * @returns Normalized payment verification result
   */
  verifyPayment(payload: PaymentVerifyPayload): Promise<PaymentVerifyResult>;
  
  /**
   * Refund a payment (optional - not all gateways support this immediately)
   * @param payload - Refund data
   * @returns Refund result
   */
  refundPayment?(payload: RefundPayload): Promise<RefundResult>;
}
