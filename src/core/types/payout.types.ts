import { Schema } from 'mongoose';
import { z } from 'zod';

// ─── Mongoose Sub-Schemas ────────────────────────────────────────────────────

/**
 * Mobile Money payout sub-schema.
 */
const MobileMoneySubSchema = new Schema(
    {
        provider: { type: String, required: true, trim: true },  // e.g. "MTN", "Orange"
        phone_number: { type: String, required: true, trim: true },
        account_name: { type: String, required: true, trim: true },
    },
    { _id: false }
);

/**
 * Bank account payout sub-schema.
 */
const BankSubSchema = new Schema(
    {
        bank_name: { type: String, required: true, trim: true },
        account_number: { type: String, required: true, trim: true },
        account_name: { type: String, required: true, trim: true },
        country: { type: String, required: true, trim: true },
    },
    { _id: false }
);

/**
 * Single payout method sub-schema (mobile money OR bank).
 *
 * Used by: Vendor, DeliveryAgency
 *
 * SECURITY:
 * - Account numbers are stored in plaintext for display (masked in API response DTOs)
 * - No payment tokens are stored here; the payment gateway handles tokenization
 * - Only the method owner (vendor/agency) can write; admin can read
 */
export const PayoutMethodSchema = new Schema(
    {
        method: {
            type: String,
            enum: ['mobile_money', 'bank'],
            required: true,
        },
        mobile_money: { type: MobileMoneySubSchema, default: null },
        bank: { type: BankSubSchema, default: null },
    },
    { _id: false }
);

/**
 * @deprecated Use PayoutMethodSchema for new code.
 * Alias kept for backward compatibility with Vendor model.
 */
export const PayoutDetailsSchema = PayoutMethodSchema;

// ─── TypeScript Interfaces ───────────────────────────────────────────────────

export interface IMobileMoneyPayout {
    provider: string;
    phone_number: string;
    account_name: string;
}

export interface IBankPayout {
    bank_name: string;
    account_number: string;
    account_name: string;
    country: string;
}

/**
 * A single payout method entry (one of mobile_money or bank).
 */
export interface IPayoutMethod {
    method: 'mobile_money' | 'bank';
    mobile_money: IMobileMoneyPayout | null;
    bank: IBankPayout | null;
}

/**
 * The full payout_details field on a DeliveryAgency document.
 * An ordered array of IPayoutMethod entries — the FIRST item is the preferred method.
 * Must contain at least 1 entry when onboarding is complete.
 *
 * @deprecated (single object form) Use IPayoutMethod for new code.
 */
export type IPayoutDetails = IPayoutMethod[];

/**
 * @deprecated Alias for backward compatibility with Vendor model.
 */
export type IPayoutDetailsSingle = IPayoutMethod;

// ─── Read-side masking ───────────────────────────────────────────────────────

/**
 * A payout method as it is safe to READ BACK: enough to recognise the
 * destination, never enough to reconstruct the account.
 *
 * Payout details are write-mostly by design — the owner types them in and the
 * admin paying out resolves the real values server-side. Echoing a full account
 * number to any client that can read a profile would turn a session hijack into
 * a banking-detail leak for no product benefit.
 */
export interface PayoutMethodMasked {
    method: 'mobile_money' | 'bank';
    /** The first entry of the ordered list is the one payouts actually use. */
    is_preferred: boolean;
    mobile_money: { provider: string; phone_number_masked: string; account_name: string } | null;
    bank: {
        bank_name: string;
        account_number_masked: string;
        account_name: string;
        country: string;
    } | null;
}

/** Keep the last 4 digits; everything before becomes bullets. */
function maskTail(value: string): string {
    if (value.length <= 4) return '••••';
    return '•'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * Mask an ordered payout list for reading back. Position is meaningful — index 0
 * is the preferred method — so order is preserved.
 *
 * Vendor and agency each grew their own copy of this before it lived here; they
 * are left alone deliberately (their response shapes are already public API).
 * New callers should use this one.
 */
export function maskPayoutMethods(
    methods: IPayoutMethod[] | null | undefined
): PayoutMethodMasked[] {
    if (!methods) return []; // legacy documents predating the array form
    return methods.map((m, index) => ({
        method: m.method,
        is_preferred: index === 0,
        mobile_money: m.mobile_money
            ? {
                provider: m.mobile_money.provider,
                phone_number_masked: maskTail(m.mobile_money.phone_number),
                account_name: m.mobile_money.account_name,
            }
            : null,
        bank: m.bank
            ? {
                bank_name: m.bank.bank_name,
                account_number_masked: maskTail(m.bank.account_number),
                account_name: m.bank.account_name,
                country: m.bank.country,
            }
            : null,
    }));
}

// ─── Zod Validators ─────────────────────────────────────────────────────────

const MobileMoneyZodSchema = z.object({
    provider: z.string().min(1, 'Provider is required').trim(),
    phone_number: z.string().min(6).max(20).trim(),
    account_name: z.string().min(1, 'Account name is required').trim(),
});

const BankZodSchema = z.object({
    bank_name: z.string().min(1, 'Bank name is required').trim(),
    account_number: z.string().min(1, 'Account number is required').trim(),
    account_name: z.string().min(1, 'Account name is required').trim(),
    country: z.string().min(1, 'Country is required').trim(),
});

/**
 * Validates a single payout method entry.
 * Ensures the correct sub-object is provided for the chosen method.
 */
export const PayoutMethodZodSchema = z
    .discriminatedUnion('method', [
        z.object({
            method: z.literal('mobile_money'),
            mobile_money: MobileMoneyZodSchema,
            bank: z.null().optional(),
        }),
        z.object({
            method: z.literal('bank'),
            mobile_money: z.null().optional(),
            bank: BankZodSchema,
        }),
    ])
    .transform((data) => {
        // Normalize: ensure the unused branch is null
        if (data.method === 'mobile_money') {
            return { ...data, bank: null };
        }
        return { ...data, mobile_money: null };
    });

/**
 * Validates an ordered array of payout methods.
 * - Minimum 1 entry required, maximum 3.
 * - The FIRST entry is treated as the preferred/default payout method.
 * - Multiple mobile_money and/or bank entries are allowed.
 */
export const PayoutDetailsZodSchema = z
    .array(PayoutMethodZodSchema)
    .min(1, 'At least one payout method is required')
    .max(3, 'You may add at most 3 payout methods');

/**
 * @deprecated Use PayoutMethodZodSchema for single-method validation.
 * Alias kept for backward compatibility.
 */
export const PayoutDetailsZodSchemaSingle = PayoutMethodZodSchema;

export type PayoutMethodInput = z.input<typeof PayoutMethodZodSchema>;
export type PayoutMethodOutput = z.output<typeof PayoutMethodZodSchema>;
export type PayoutDetailsInput = z.input<typeof PayoutDetailsZodSchema>;
export type PayoutDetailsOutput = z.output<typeof PayoutDetailsZodSchema>;
