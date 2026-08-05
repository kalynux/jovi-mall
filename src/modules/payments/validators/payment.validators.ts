import { z } from 'zod';
import { OptionalEmailAddressSchema } from '../../../core/validation/email';
import { OptionalPhoneNumberSchema } from '../../../core/validation/phone';

/**
 * Payment API validators.
 *
 * `PaymentChannelSchema` is the ONE definition of the `channel` object every
 * payment entry point accepts — order/cart checkout, booking payment, and the
 * billing module's credit top-up and plan purchase. It lived only in
 * `billing.validators.ts` before; the other two entry points hand-checked a few
 * keys inline and passed the rest of `req.body` straight to a gateway, so a
 * mobile-money number reached NotchPay/MyCoolPay unvalidated and a
 * `customerEmail` reached Stripe's `receipt_email` unvalidated.
 *
 * It mirrors `PaymentChannelInfo` (gateways/gateway.interface.ts) exactly.
 * Every field stays optional, as it was: which of them is *required* depends on
 * the gateway, and that rule belongs to the endpoint, not to the shape. Whether
 * the `channel` OBJECT itself may be omitted is likewise the endpoint's call —
 * billing defaults it to `{}`, the two payment routes require it, exactly as
 * each did before.
 */
export const PaymentChannelSchema = z.object({
  // Mobile money (NotchPay, MyCoolPay) — the account being debited.
  phoneNumber: OptionalPhoneNumberSchema,
  phoneOperator: z.enum(['MTN', 'ORANGE', 'MOOV']).optional(),
  // Card (Stripe).
  cardToken: z.string().trim().optional(),
  // Common — Stripe puts this on `receipt_email`, so a typo is a receipt
  // nobody receives.
  customerEmail: OptionalEmailAddressSchema,
  customerName: z.string().trim().optional(),
});

export type PaymentChannelInput = z.infer<typeof PaymentChannelSchema>;

export const PAYMENT_GATEWAYS = ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'] as const;

const PaymentGatewaySchema = z.enum(PAYMENT_GATEWAYS, {
  errorMap: () => ({ message: `Invalid gateway. Must be one of: ${PAYMENT_GATEWAYS.join(', ')}` }),
});

/**
 * POST /payments/initiate — one payment for a cart, or for a single order.
 *
 * The `cartId` XOR `orderId` rule and the "mobile money needs a number" rule
 * were both already enforced by hand in the route; they are here so the whole
 * body is checked in one place and reported in the platform's standard
 * validation-error shape.
 */
export const InitiatePaymentSchema = z
  .object({
    cartId: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
    gateway: PaymentGatewaySchema,
    channel: PaymentChannelSchema,
  })
  .refine((body) => Boolean(body.cartId || body.orderId), {
    message: 'Either cartId or orderId is required',
    path: ['cartId'],
  })
  .refine((body) => body.gateway === 'STRIPE' || Boolean(body.channel.phoneNumber), {
    message: 'phoneNumber is required for mobile money payments',
    path: ['channel', 'phoneNumber'],
  });

export type InitiatePaymentInput = z.infer<typeof InitiatePaymentSchema>;

/** POST /api/bookings/:id/pay — same channel, booking resolved from the URL. */
export const InitiateBookingPaymentSchema = z
  .object({
    gateway: PaymentGatewaySchema,
    channel: PaymentChannelSchema,
  })
  .refine((body) => body.gateway === 'STRIPE' || Boolean(body.channel.phoneNumber), {
    message: 'phoneNumber is required for mobile money payments',
    path: ['channel', 'phoneNumber'],
  });

export type InitiateBookingPaymentInput = z.infer<typeof InitiateBookingPaymentSchema>;

/** POST /payments/verify */
export const VerifyPaymentSchema = z.object({
  transactionId: z.string().trim().min(1, 'transactionId is required'),
});

export type VerifyPaymentInput = z.infer<typeof VerifyPaymentSchema>;
