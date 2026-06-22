import { z } from 'zod';

/**
 * Payment methods are gateway-managed. We accept only tokenized references and
 * non-sensitive display metadata. Raw card numbers / CVV must never be sent here;
 * the frontend tokenizes the card via the gateway SDK first.
 */
export const AddPaymentMethodSchema = z.object({
    provider: z.string().min(1).max(50).trim(),
    gateway_customer_id: z.string().min(1).trim(),
    gateway_instrument_id: z.string().min(1).trim(),
    method_type: z.enum(['card', 'mobile_money', 'bank_transfer']),
    display_label: z.string().min(1).max(100).trim(),
    brand: z.string().max(50).trim().nullable().optional(),
    last4: z.string().regex(/^\d{4}$/, 'last4 must be exactly 4 digits').nullable().optional(),
    exp_month: z.number().int().min(1).max(12).nullable().optional(),
    exp_year: z.number().int().min(2000).max(2100).nullable().optional(),
    holder_name: z.string().max(100).trim().nullable().optional(),
    is_default: z.boolean().default(false),
});

export type AddPaymentMethodInput = z.infer<typeof AddPaymentMethodSchema>;
