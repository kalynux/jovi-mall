import { z } from 'zod';
import { PhoneNumberSchema } from '../../../core/validation/phone';
import type { MobileMoneyProvider } from '../../payments/domain/payment-provider';

/**
 * The providers a saved method may name: the three mobile-money wallets, in the canonical
 * vocabulary of `PAYMENT_PROVIDERS` (ADR-A08 D-1).
 *
 * ⚠ **`CARD` is refused, and that is owner decision 1 (2026-09-30), not an omission.** Card
 * payments do not exist yet, so a saved card is a way to pay that cannot pay. It becomes a value
 * here in the same change that makes cards chargeable.
 */
export const SAVABLE_WALLET_PROVIDERS = ['MTN', 'ORANGE', 'MOOV'] as const satisfies readonly MobileMoneyProvider[];

/**
 * `POST /api/me/payment-methods` (and its alias `POST /api/customer/payment-methods`).
 *
 * ── A SAVED METHOD NAMES NO AGGREGATOR ──────────────────────────────────────
 * The body is what the customer holds — a provider and the wallet's number — and nothing about
 * who charges it. The aggregator is chosen at checkout by the payment settings.
 *
 * ⚠ **`.strict()`, and the old shape is REPLACED, not shimmed** (owner decision 2). A body still
 * carrying `gateway_customer_id`, `gateway_instrument_id`, `method_type`, `display_label`,
 * `brand`, `last4`, `exp_month`, `exp_year`, `holder_name` or `is_default` is a
 * `400 VALIDATION_ERROR`, never a silently stripped field — an old app build must find out that
 * saving changed, rather than store something it did not mean.
 *
 * The number must be on the provider's network, but that check needs the prefix table and is
 * the service's (`422 PAYMENT_PROVIDER_PHONE_MISMATCH`), so the bot door gets it too.
 */
export const AddPaymentMethodSchema = z
    .object({
        provider: z.enum(SAVABLE_WALLET_PROVIDERS, {
            errorMap: () => ({
                message: 'provider must be MTN, ORANGE or MOOV — saving a card is not available yet',
            }),
        }),
        phoneNumber: PhoneNumberSchema,
        /** What the customer calls it. Composed from the provider and the number when absent. */
        label: z.string().trim().min(1).max(100).optional(),
        isDefault: z.boolean().optional(),
    })
    .strict();

export type AddPaymentMethodInput = z.infer<typeof AddPaymentMethodSchema>;
