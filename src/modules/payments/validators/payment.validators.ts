import { z } from 'zod';
import { OptionalEmailAddressSchema } from '../../../core/validation/email';
import { OptionalPhoneNumberSchema } from '../../../core/validation/phone';
import { PAYMENT_PROVIDERS } from '../domain/payment-provider';
import { PAYMENT_GATEWAY_NAMES } from '../gateways/gateway.interface';

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

/** Alias of `PAYMENT_GATEWAY_NAMES`, the one list (ADR-A08). Not the adapter Map of the same name in `registry.ts`. */
export const PAYMENT_GATEWAYS = PAYMENT_GATEWAY_NAMES;

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

// ── Provider-based requests (ADR-A08) ────────────────────────────────────────
//
// The customer names what they HOLD (`provider`: MTN, ORANGE, CARD); the server picks who it
// calls (the aggregator), from the payment settings, at the moment the charge opens. See
// `api-doc/payments/routing.md`.
//
// ⚠ Neither rule the old schemas enforce survives here, on purpose:
//   - `gateway` is accepted and IGNORED (owner decision 4). Any string, so an app built against
//     an aggregator that has since been removed still gets through to routing rather than dying
//     on a 400 for a field nobody reads. It is counted, not used.
//   - "phoneNumber unless STRIPE" is gone. Which fields a charge needs is a property of the
//     ROUTE (the active aggregator's capability for that provider), so it can only be judged
//     once the route is known — by the routing service, before anything is written.
//
// `provider` is optional while apps that predate it are in use; a missing one is derived
// (`deriveProvider`) and an underivable one is `400 PAYMENT_PROVIDER_REQUIRED`.

const PaymentProviderSchema = z.enum(PAYMENT_PROVIDERS, {
  errorMap: () => ({ message: `Invalid provider. Must be one of: ${PAYMENT_PROVIDERS.join(', ')}` }),
});

/** The deprecated aggregator field — accepted, never validated against a list, never used. */
const DeprecatedGatewaySchema = z.string().trim().optional();

/** POST /payments/initiate, provider-based. Replaces `InitiatePaymentSchema` (removed in C1). */
export const InitiatePaymentRequestSchema = z
  .object({
    cartId: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
    provider: PaymentProviderSchema.optional(),
    gateway: DeprecatedGatewaySchema,
    channel: PaymentChannelSchema.default({}),
  })
  .refine((body) => Boolean(body.cartId || body.orderId), {
    message: 'Either cartId or orderId is required',
    path: ['cartId'],
  });

export type InitiatePaymentRequest = z.infer<typeof InitiatePaymentRequestSchema>;

/**
 * POST /api/bookings/:id/pay and /api/customer/bookings/:id/pay-balance, provider-based.
 * Replaces `InitiateBookingPaymentSchema` (removed in C1).
 */
export const InitiateBookingPaymentRequestSchema = z.object({
  provider: PaymentProviderSchema.optional(),
  gateway: DeprecatedGatewaySchema,
  channel: PaymentChannelSchema.default({}),
});

export type InitiateBookingPaymentRequest = z.infer<typeof InitiateBookingPaymentRequestSchema>;

/** POST /payments/verify */
export const VerifyPaymentSchema = z.object({
  transactionId: z.string().trim().min(1, 'transactionId is required'),
});

export type VerifyPaymentInput = z.infer<typeof VerifyPaymentSchema>;

/**
 * POST /payments/:transactionId/authorize
 *
 * The one-time code for a mobile-money charge that reported
 * `instructions.requiresOtp` — My-CoolPay's Orange Money flow, which answers
 * `REQUIRE_OTP` and takes no money until the code is relayed back.
 *
 * Digits only, 4–8 of them: the operators send a numeric code, and accepting
 * arbitrary text here would forward whatever was typed to the gateway as a
 * guess. The attempt counter lives on the transaction (`otpAttempts`), not
 * here — a schema cannot count.
 */
export const AuthorizePaymentSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, 'code must be the 4-8 digit confirmation code sent to your phone'),
});

export type AuthorizePaymentInput = z.infer<typeof AuthorizePaymentSchema>;
