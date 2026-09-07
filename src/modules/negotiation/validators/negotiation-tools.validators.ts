/**
 * Request schemas for the bargaining sub-agent's five read tools.
 *
 * ── THE CALLER IS A MODEL, AND THAT CHANGES WHAT A SCHEMA IS FOR ────────────────
 *
 * Everything here is `.optional()` and nothing is `.strict()`, which for a human-facing
 * endpoint would be sloppy and here is deliberate. An LLM tool call is assembled from a
 * schema description the model paraphrases; it routinely emits a key it was told about but
 * has no value for, and it routinely emits an extra one. Refusing on either turns a
 * recoverable "you didn't say which product" into a `VALIDATION_ERROR` about field shapes
 * that the model will retry verbatim.
 *
 * So Zod does the part a schema is genuinely good at — types, bounds, non-negativity — and
 * the one rule that actually matters is enforced in `domain/negotiation-tool-subject.ts`,
 * where it can raise `NEGOTIATION_TOOL_SUBJECT_REQUIRED` and say the actionable thing.
 * That split is the same one `bargain-price.rule.ts` makes and for a related reason: the
 * rule is about the request as a whole, not about a field.
 *
 * ⚠ **`maxPrice` is a BUDGET and bounds the floor**, not the shelf price. See
 * `withinBudget`. The name is the model-facing one — a model has a budget, not a floor —
 * and the translation happens once, in the domain.
 */
import { z } from 'zod';

/** A money amount as this platform stores them: whole minor-unit-free XAF, never negative. */
const money = z.number().int().nonnegative();

/**
 * The four ways to name one product. All optional; `requireProductSubject` enforces that at
 * least one arrived, because "at least one of these" is not a statement about a field.
 */
const productSubject = {
    productId: z.string().trim().optional(),
    variantId: z.string().trim().optional(),
    sku: z.string().trim().optional(),
    slug: z.string().trim().optional(),
};

export const ProductDetailsSchema = z.object({ ...productSubject });

export const FindAlternativesSchema = z.object({
    ...productSubject,
    /** Free text, as the customer phrased it. Searched through `$text`, never a regex. */
    query: z.string().trim().max(200).optional(),
    /** The customer's budget. Bounds the FLOOR — see the header. */
    maxPrice: money.optional(),
    category: z.string().trim().max(120).optional(),
    type: z.enum(['physical', 'digital', 'service']).optional(),
    inStockOnly: z.boolean().optional(),
    limit: z.number().int().optional(),
});

export const FindComplementsSchema = z.object({
    ...productSubject,
    maxPrice: money.optional(),
    inStockOnly: z.boolean().optional(),
    limit: z.number().int().optional(),
});

export const QuoteDeliverySchema = z.object({
    ...productSubject,
    /**
     * The region the customer named, if they named one. A region KEY or its spelling out of
     * a chat message — `resolveCoverage` compares case-insensitively for that reason.
     */
    region: z.string().trim().max(120).optional(),
});

export const CheckPromotionSchema = z.object({
    /**
     * A code the customer offered. Accepted so the tool can refuse it *precisely* — see
     * `NegotiationToolsService.checkPromotion` for why answering `{ available: false }` to a
     * named code is the wrong answer rather than a softer one.
     */
    code: z.string().trim().max(64).optional(),
    productId: z.string().trim().optional(),
});
