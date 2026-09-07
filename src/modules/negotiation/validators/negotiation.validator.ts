import { z } from 'zod';

/**
 * Request shapes for the two gate endpoints, and the guard on model-authored data.
 *
 * ── The traits guard is a security boundary, not tidiness ────────────────────
 *
 * `NegotiationProfile.traits` is the one column in this codebase a language model
 * writes to directly. The Mongoose path is a `Map` of `Mixed`, so **this schema is
 * the only shape check that exists** — the same position `article-body.validator.ts`
 * holds for the blog, and for the same reason.
 *
 * What it bounds, and why each bound is here rather than trusted to the model:
 *
 *   - **Scalars only.** No nested objects, no arrays. The playbook's state vector is
 *     flat, so accepting more buys nothing and gives a confused or manipulated model
 *     somewhere to put a payload.
 *   - **A key count and a key pattern.** An unbounded map is an unbounded document,
 *     read on every bargaining turn.
 *   - **A string length.** A trait is a label (`"skeptical"`), never prose. Without
 *     this, "communication_style" could carry the whole conversation.
 *
 * It is deliberately an **open** vocabulary — the model may invent a trait name the
 * playbook does not list — because the playbook is edited from a dashboard without a
 * deploy (see the playbook store) and a closed enum here would make every new trait a
 * backend release. The bounds above are what make that safe.
 */
const TRAIT_KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const NegotiationTraitsSchema = z
    .record(
        z.string().regex(TRAIT_KEY, 'trait keys are lower_snake_case, max 40 characters'),
        z.union([z.string().max(120), z.number().finite(), z.boolean()]),
    )
    .refine((traits) => Object.keys(traits).length <= 40, {
        message: 'at most 40 traits',
    });

/** Money on the wire. Both rails settle in whole XAF, so no fractional prices. */
const Price = z.number().int('prices are whole numbers').nonnegative();

/**
 * The messaging identity, exactly as the bot surface's envelope carries it.
 *
 * ⚠ **There is deliberately no `customerId` and no `userId` here, and adding one
 * would be account takeover on a surface reachable with a service token.** The caller
 * passes an identity it OBSERVED on a webhook; the backend resolves who that is. Same
 * rule as `/api/internal/bot/*`, enforced the same way — `.strict()`, so an id sent
 * anyway is a 400 rather than a silently ignored field.
 */
export const NegotiationIdentitySchema = z
    .object({
        channel: z.enum(['whatsapp', 'telegram']),
        externalId: z.string().min(1).max(128),
    })
    .strict();

/**
 * `POST /context` — open or resume the session for a line, and read everything the
 * model needs to take its turn.
 */
export const NegotiationContextSchema = z
    .object({
        identity: NegotiationIdentitySchema,
        variantId: z.string().min(1),
        quantity: z.number().int().positive().max(999).default(1),
        /** What the customer just offered, if they named a number. Recorded, never judged. */
        customerOffer: Price.optional(),
    })
    .strict();

/**
 * `POST /record` — the gate. The structured payload of plan D-9.
 *
 * ⚠ `agentProposedPrice` is REQUIRED. A turn with no price is a turn the gate has
 * nothing to judge, and the playbook routes those (greetings, product questions)
 * around this endpoint entirely rather than through it with a null.
 */
export const NegotiationRecordSchema = z
    .object({
        identity: NegotiationIdentitySchema,
        sessionId: z.string().min(1),
        /** The sentence the customer will read. Stored verbatim for the dispute record. */
        reply: z.string().min(1).max(4096),
        agentProposedPrice: Price,
        /** The model's own call. The backend never infers a close from the wording. */
        lock: z.boolean().default(false),
        customerOffer: Price.optional(),
        traits: NegotiationTraitsSchema.optional(),
    })
    .strict();

export type NegotiationContextInput = z.infer<typeof NegotiationContextSchema>;
export type NegotiationRecordInput = z.infer<typeof NegotiationRecordSchema>;
