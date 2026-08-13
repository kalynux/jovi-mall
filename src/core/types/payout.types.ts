import { Schema } from 'mongoose';
import { z } from 'zod';
import { PhoneNumberSchema } from '../validation/phone';
import { clearable } from '../validation/zod.helpers';

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
 * The card networks a payout destination may name. Lowercase and closed:
 * `describePayoutMethod` and every dashboard badge key off it, and free text
 * would produce "Visa"/"VISA"/"visa " as three different brands.
 */
export const CARD_BRANDS = [
    'visa',
    'mastercard',
    'amex',
    'discover',
    'unionpay',
    'jcb',
    'diners',
    'verve',
    'other',
] as const;

export type CardBrand = (typeof CARD_BRANDS)[number];

/**
 * Card payout sub-schema (Visa / Mastercard / … "push to card").
 *
 * SECURITY — this is the one payout branch that deliberately does NOT hold the
 * full destination number, and the asymmetry with `bank` is the design. A card's
 * account number IS the PAN: storing it puts this whole database in PCI-DSS
 * scope, and `UserPaymentMethod` already committed the codebase to the opposite
 * rule ("Full card numbers (PAN) and CVV are NEVER stored here"). A payout
 * destination is not worth reversing that for.
 *
 * So a card is *identified* by brand + last4 + holder + expiry — enough for the
 * owner to recognise it and for an admin to confirm they are paying the right
 * place — and the money moves through `gateway_token`, the reference the payment
 * gateway issues when the client tokenizes the card. A CVV is never accepted in
 * any field, on any path.
 */
const CardSubSchema = new Schema(
    {
        brand: { type: String, enum: CARD_BRANDS, required: true },
        /** Last 4 PAN digits. Display only — never the routing value. */
        last4: { type: String, required: true, trim: true },
        card_holder_name: { type: String, required: true, trim: true },
        expiry_month: { type: Number, required: true, min: 1, max: 12 },
        expiry_year: { type: Number, required: true },
        issuing_bank: { type: String, default: null, trim: true },
        country: { type: String, required: true, trim: true },
        /**
         * Gateway handle for the transfer, when one exists. Null until a
         * card-payout gateway is wired — an untokenized card is still a valid
         * *destination* (the admin settles it out of band and records the
         * external reference, exactly as they do for bank today), it is just not
         * yet an automatable one.
         */
        gateway_provider: { type: String, default: null, trim: true },
        gateway_token: { type: String, default: null, trim: true },
    },
    { _id: false }
);

/**
 * Single payout method sub-schema (mobile money OR bank OR card).
 *
 * Used by: Vendor, DeliveryAgency, DeliveryAgent, PayoutRequest (as a snapshot)
 *
 * SECURITY:
 * - Mobile-money and bank account numbers are stored in plaintext for display
 *   (masked in API response DTOs)
 * - A card is the exception: no PAN, no CVV — see CardSubSchema above
 * - Only the method owner (vendor/agency/agent) can write; admin can read
 */
export const PayoutMethodSchema = new Schema(
    {
        method: {
            type: String,
            enum: ['mobile_money', 'bank', 'card'],
            required: true,
        },
        mobile_money: { type: MobileMoneySubSchema, default: null },
        bank: { type: BankSubSchema, default: null },
        card: { type: CardSubSchema, default: null },
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

export interface ICardPayout {
    brand: CardBrand;
    /** Last 4 PAN digits — the only part of the number that exists here. */
    last4: string;
    card_holder_name: string;
    expiry_month: number;
    expiry_year: number;
    issuing_bank: string | null;
    country: string;
    gateway_provider: string | null;
    gateway_token: string | null;
}

/** Which destination an entry names. Exactly one sub-object is non-null. */
export type PayoutMethodKind = 'mobile_money' | 'bank' | 'card';

/** Every kind the SHAPE supports, enabled or not. Mirrors the Mongoose enum. */
export const ALL_PAYOUT_METHODS: readonly PayoutMethodKind[] = ['mobile_money', 'bank', 'card'];

/**
 * ─── THE SWITCH ─────────────────────────────────────────────────────────────
 *
 * Payout kinds open for NEW configuration right now. Bank and card are built,
 * validated, masked and documented — they are switched off at the **write path
 * only**. To turn one back on, add its string here. That is the whole change.
 *
 * Deliberately a write-path gate and not a schema deletion, because three things
 * must keep working while a kind is off:
 *
 *  - **Stored entries still read back.** An owner who configured a bank last
 *    month still sees it, and `maskPayoutMethods` still renders it.
 *  - **Payouts to them still resolve.** `PayoutRequestService` snapshots index 0
 *    whatever its kind, and `describePayoutMethod` still names it. Switching a
 *    kind off must not strand money already destined for one.
 *  - **The rules don't rot.** `PayoutMethodShapeZodSchema` below still validates
 *    all three, and the tests still exercise them, so a kind that comes back on
 *    comes back correct.
 *
 * The one consequence worth knowing: writes are a FULL REPLACE, so an owner
 * whose stored list contains a disabled kind cannot re-send that list unchanged
 * — they must replace the disabled entry. Only callers that actually send
 * `payout_details` are affected; omitting the field leaves the stored list alone.
 */
export const ENABLED_PAYOUT_METHODS: readonly PayoutMethodKind[] = ['mobile_money'];

const PAYOUT_METHOD_LABELS: Record<PayoutMethodKind, string> = {
    mobile_money: 'Mobile money',
    bank: 'Bank transfer',
    card: 'Card',
};

export function isPayoutMethodEnabled(method: string): boolean {
    return (ENABLED_PAYOUT_METHODS as readonly string[]).includes(method);
}

/** The refusal an owner sees when they pick a switched-off kind. */
export function payoutMethodUnavailableMessage(method: PayoutMethodKind): string {
    const enabled = ENABLED_PAYOUT_METHODS.map((m) => PAYOUT_METHOD_LABELS[m].toLowerCase());
    return `${PAYOUT_METHOD_LABELS[method]} payouts are not available right now. Currently accepted: ${enabled.join(', ')}.`;
}

/**
 * A single payout method entry (one of mobile_money, bank or card).
 */
export interface IPayoutMethod {
    method: PayoutMethodKind;
    mobile_money: IMobileMoneyPayout | null;
    bank: IBankPayout | null;
    card: ICardPayout | null;
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
    method: PayoutMethodKind;
    /** The first entry of the ordered list is the one payouts actually use. */
    is_preferred: boolean;
    mobile_money: { provider: string; phone_number_masked: string; account_name: string } | null;
    bank: {
        bank_name: string;
        account_number_masked: string;
        account_name: string;
        country: string;
    } | null;
    /**
     * Nothing is redacted here that was not already absent: only `last4` was ever
     * stored, and `number_masked` is rendered FROM it purely so a client can
     * print all three method kinds through one code path.
     */
    card: {
        brand: CardBrand;
        last4: string;
        number_masked: string;
        card_holder_name: string;
        expiry_month: number;
        expiry_year: number;
        issuing_bank: string | null;
        country: string;
    } | null;
}

/** Keep the last 4 digits; everything before becomes bullets. */
function maskTail(value: string): string {
    if (value.length <= 4) return '••••';
    return '•'.repeat(value.length - 4) + value.slice(-4);
}

/** A 16-digit-looking rendering of a card we only hold 4 digits of. */
export function formatMaskedCardNumber(last4: string): string {
    return `•••• •••• •••• ${last4}`;
}

/**
 * True once the card's expiry month has fully passed. A card is valid THROUGH
 * the last day of its expiry month, so equality on both parts is not expired.
 * `now` is injectable so the rule stays testable without freezing the clock.
 */
export function isCardExpired(
    expiryMonth: number,
    expiryYear: number,
    now: Date = new Date()
): boolean {
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth() + 1;
    if (expiryYear !== currentYear) return expiryYear < currentYear;
    return expiryMonth < currentMonth;
}

/**
 * Mask ONE payout destination.
 *
 * Split out of `maskPayoutMethods` because not every destination lives in an
 * ordered list: `PayoutRequest.payout_method_snapshot` is a single embedded
 * method, and wrapping it in an array only to unwrap the result made the one
 * place that most needs masking read like a workaround.
 *
 * `isPreferred` is a parameter rather than derived, for the same reason — it is
 * a fact about a position in a list, and a snapshot has no position. A snapshot
 * passes `true`: it *was* the preferred method at the moment it was frozen.
 */
export function maskPayoutMethod(
    method: IPayoutMethod,
    isPreferred: boolean
): PayoutMethodMasked {
    return {
        method: method.method,
        is_preferred: isPreferred,
        mobile_money: method.mobile_money
            ? {
                provider: method.mobile_money.provider,
                phone_number_masked: maskTail(method.mobile_money.phone_number),
                account_name: method.mobile_money.account_name,
            }
            : null,
        bank: method.bank
            ? {
                bank_name: method.bank.bank_name,
                account_number_masked: maskTail(method.bank.account_number),
                account_name: method.bank.account_name,
                country: method.bank.country,
            }
            : null,
        card: method.card
            ? {
                brand: method.card.brand,
                last4: method.card.last4,
                number_masked: formatMaskedCardNumber(method.card.last4),
                card_holder_name: method.card.card_holder_name,
                expiry_month: method.card.expiry_month,
                expiry_year: method.card.expiry_year,
                issuing_bank: method.card.issuing_bank ?? null,
                country: method.card.country,
            }
            : null,
    };
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
    return methods.map((m, index) => maskPayoutMethod(m, index === 0));
}

// ─── Zod Validators ─────────────────────────────────────────────────────────

/**
 * `.trim()` BEFORE `.min(1)`, everywhere in this file. Zod applies checks in
 * chain order, so `z.string().min(1).trim()` measures the untrimmed value and
 * accepts `"   "` — storing a blank bank name that passed validation. On a
 * payout destination that is not a cosmetic difference: a blank account name is
 * a transfer somebody has to chase.
 */
const requiredText = (message: string) => z.string().trim().min(1, message);

const MobileMoneyZodSchema = z.object({
    provider: requiredText('Provider is required'),
    // Full E.164. This is where the platform sends money: a national number
    // here is not merely untidy, it is a payout instruction nobody can execute.
    phone_number: PhoneNumberSchema,
    account_name: requiredText('Account name is required'),
});

const BankZodSchema = z.object({
    bank_name: requiredText('Bank name is required'),
    account_number: requiredText('Account number is required'),
    account_name: requiredText('Account name is required'),
    country: requiredText('Country is required'),
});

/**
 * Fields whose presence means the client tried to send us a real card number or
 * security code. They are REFUSED rather than stripped: Zod would silently drop
 * an unknown key, and a client reading a 200 back would reasonably conclude the
 * PAN it sent is now on file — the worst possible outcome for a value we never
 * wanted and do not store.
 */
const FORBIDDEN_CARD_FIELDS = [
    'number',
    'card_number',
    'pan',
    'account_number',
    'cvv',
    'cvc',
    'cvn',
    'security_code',
] as const;

export const CARD_PAN_REJECTED_MESSAGE =
    'Card numbers and security codes are never accepted or stored. Send only brand, last4, holder, expiry and country (plus a gateway token if you have one).';

const CardZodSchema = z
    .object({
        brand: z.preprocess(
            (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
            z.enum(CARD_BRANDS)
        ),
        last4: z
            .string()
            .trim()
            .regex(/^\d{4}$/, 'last4 must be exactly 4 digits'),
        card_holder_name: requiredText('Card holder name is required'),
        expiry_month: z.number().int().min(1).max(12),
        expiry_year: z.number().int().min(2000).max(2100),
        issuing_bank: clearable(z.string().trim().max(100)),
        country: requiredText('Country is required'),
        gateway_provider: clearable(z.string().trim().max(50)),
        gateway_token: clearable(z.string().trim().max(255)),
    })
    // Passthrough so the forbidden-field check below can SEE what was sent.
    // The union's transform strips everything back to the known keys.
    .passthrough();

/**
 * The SHAPE of a payout method entry — what one *is*, independent of whether it
 * may be configured today. Ensures the correct sub-object is provided for the
 * chosen method, and knows all three kinds regardless of `ENABLED_PAYOUT_METHODS`.
 *
 * **Do not validate requests with this.** Use `PayoutMethodZodSchema`, which is
 * this plus the switch. This one is exported so the disabled kinds' rules stay
 * under test while they are off — a rule nothing exercises is a rule that rots.
 */
export const PayoutMethodShapeZodSchema = z
    .discriminatedUnion('method', [
        z.object({
            method: z.literal('mobile_money'),
            mobile_money: MobileMoneyZodSchema,
            bank: z.null().optional(),
            card: z.null().optional(),
        }),
        z.object({
            method: z.literal('bank'),
            mobile_money: z.null().optional(),
            bank: BankZodSchema,
            card: z.null().optional(),
        }),
        z.object({
            method: z.literal('card'),
            mobile_money: z.null().optional(),
            bank: z.null().optional(),
            card: CardZodSchema,
        }),
    ])
    .superRefine((data, ctx) => {
        if (data.method !== 'card') return;
        for (const field of FORBIDDEN_CARD_FIELDS) {
            if (field in data.card) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['card', field],
                    message: CARD_PAN_REJECTED_MESSAGE,
                });
            }
        }
        // An expired card is a payout that will bounce. Refusing it at write
        // time is the only moment anybody is looking; by payout time the owner
        // is not in the room.
        if (isCardExpired(data.card.expiry_month, data.card.expiry_year)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['card', 'expiry_year'],
                message: 'Card has expired',
            });
        }
    })
    .transform((data) => {
        // Normalize: exactly one branch survives, the other two are null.
        if (data.method === 'mobile_money') {
            return { ...data, bank: null, card: null };
        }
        if (data.method === 'bank') {
            return { ...data, mobile_money: null, card: null };
        }
        const card = data.card;
        return {
            method: 'card' as const,
            mobile_money: null,
            bank: null,
            // Rebuilt key-by-key rather than spread: `card` is a passthrough
            // object, and spreading it would carry any extra field the client
            // sent straight into Mongo.
            card: {
                brand: card.brand,
                last4: card.last4,
                card_holder_name: card.card_holder_name,
                expiry_month: card.expiry_month,
                expiry_year: card.expiry_year,
                issuing_bank: card.issuing_bank ?? null,
                country: card.country,
                gateway_provider: card.gateway_provider ?? null,
                gateway_token: card.gateway_token ?? null,
            },
        };
    });

/**
 * Validates a single payout method entry for a REQUEST: the switch, then the
 * shape. This is what every write path parses with.
 *
 * The gate runs FIRST, as a separate piped stage, so a client still rendering a
 * switched-off form is told "bank payouts are not available right now" rather
 * than being walked through the field errors of a form it may not submit at all.
 * Inside one `superRefine` the sub-object would be validated first and a partial
 * body would never reach the gate.
 */
export const PayoutMethodZodSchema = z
    .unknown()
    .superRefine((value, ctx) => {
        const method = (value as { method?: unknown } | null)?.method;
        if (typeof method !== 'string') return; // not our error — the shape reports it
        // An unrecognised kind falls through to the discriminator error below;
        // only a real-but-disabled kind gets the explanatory message.
        if (!ALL_PAYOUT_METHODS.includes(method as PayoutMethodKind)) return;
        if (isPayoutMethodEnabled(method)) return;
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['method'],
            message: payoutMethodUnavailableMessage(method as PayoutMethodKind),
        });
    })
    .pipe(PayoutMethodShapeZodSchema);

/**
 * Validates an ordered array of payout methods.
 * - Minimum 1 entry required, maximum 3.
 * - The FIRST entry is treated as the preferred/default payout method.
 * - Any mix of the currently ENABLED kinds is allowed, duplicates included.
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
