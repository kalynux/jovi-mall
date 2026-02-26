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
        country: { type: String, required: true, trim: true, uppercase: true }, // ISO-2
    },
    { _id: false }
);

/**
 * Shared payout details sub-schema.
 *
 * Used by: Vendor, DeliveryAgency
 *
 * SECURITY:
 * - Account numbers are stored in plaintext for display (masked in API response DTOs)
 * - No payment tokens are stored here; the payment gateway handles tokenization
 * - Only the method owner (vendor/agency) can write; admin can read
 */
export const PayoutDetailsSchema = new Schema(
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

export interface IPayoutDetails {
    method: 'mobile_money' | 'bank';
    mobile_money: IMobileMoneyPayout | null;
    bank: IBankPayout | null;
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
    country: z
        .string()
        .length(2, 'Country must be a valid ISO-2 code')
        .toUpperCase(),
});

/**
 * Validates payout details input from API requests.
 *
 * Ensures the correct sub-object is provided for the chosen method.
 */
export const PayoutDetailsZodSchema = z
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

export type PayoutDetailsInput = z.input<typeof PayoutDetailsZodSchema>;
export type PayoutDetailsOutput = z.output<typeof PayoutDetailsZodSchema>;
