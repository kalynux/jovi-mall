/**
 * "Which product are we talking about?" — the one question every tool on this surface has
 * to answer before it can do anything.
 *
 * ── WHY THIS IS A RULE AND NOT A ZOD `.refine()` ────────────────────────────────
 *
 * The caller is a language model. It addresses a product by whatever it happens to be
 * holding: an id it read from a hand-off, a variant id from a previous turn, a SKU the
 * customer typed, or a slug out of a storefront link the customer pasted. All four are
 * optional and **at least one** is required — a rule Zod can express, but only as a
 * `ZodError`, which the global handler turns into `VALIDATION_ERROR` with a message about
 * fields rather than about products.
 *
 * That distinction is worth a code of its own here precisely because of who reads it.
 * `NEGOTIATION_TOOL_SUBJECT_REQUIRED` tells a model the actionable thing — *you did not say
 * which product* — where a field-shaped validation error invites it to retry the same call
 * with the same empty body. The two search tools raise it for the same reason with a wider
 * definition of "subject": a substitute search needs either a product to substitute FOR or
 * a phrase to search BY, and neither is individually required.
 *
 * Raised at **400** at every site, never 422. It is a malformed request, not a business
 * rule about a product that exists — and `test:errors` § 3 fails a code that yields two
 * categories, so the single status is load-bearing rather than tidy.
 */

import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/** The four ways a caller may name one product. All optional; at least one required. */
export interface ProductSubjectInput {
    productId?: string;
    variantId?: string;
    sku?: string;
    slug?: string;
}

/**
 * The same set, narrowed to the ones actually supplied and trimmed.
 *
 * `undefined` for a key the caller omitted OR sent as whitespace — a model that emits
 * `{"sku": ""}` when it has no SKU is common enough that treating an empty string as a
 * value would turn "I don't know" into a lookup that always misses.
 */
export interface ResolvedProductSubject {
    productId?: string;
    variantId?: string;
    sku?: string;
    slug?: string;
}

/**
 * Require that a product was named, and hand back the trimmed identifiers.
 *
 * @param tool the tool name, echoed into `details` so an operator reading a log line knows
 *             which of the five refused without correlating by path.
 */
export function requireProductSubject(
    input: ProductSubjectInput,
    tool: string,
): ResolvedProductSubject {
    const resolved: ResolvedProductSubject = {
        productId: clean(input.productId),
        variantId: clean(input.variantId),
        sku: clean(input.sku),
        slug: clean(input.slug),
    };

    const named = Object.values(resolved).some((value) => value !== undefined);
    if (!named) {
        throw createAppError(ERROR_CODES.NEGOTIATION_TOOL_SUBJECT_REQUIRED, 400, undefined, {
            tool,
            accepts: ['productId', 'variantId', 'sku', 'slug'],
        });
    }

    return resolved;
}

/**
 * The search tools' looser form: a product to search *from*, or a phrase to search *by*.
 *
 * Deliberately NOT `requireProductSubject` with an extra optional field. A substitute
 * search with only a phrase is a complete, valid request — the customer said "something
 * cheaper, maybe a smaller one" and there is no id in the conversation — while a search
 * with neither is a call the tool can do nothing with at all.
 */
export function requireSearchSubject(
    input: ProductSubjectInput & { query?: string },
    tool: string,
): ResolvedProductSubject & { query?: string } {
    const query = clean(input.query);
    const resolved: ResolvedProductSubject = {
        productId: clean(input.productId),
        variantId: clean(input.variantId),
        sku: clean(input.sku),
        slug: clean(input.slug),
    };

    const named = query !== undefined || Object.values(resolved).some((value) => value !== undefined);
    if (!named) {
        throw createAppError(ERROR_CODES.NEGOTIATION_TOOL_SUBJECT_REQUIRED, 400, undefined, {
            tool,
            accepts: ['productId', 'variantId', 'sku', 'slug', 'query'],
        });
    }

    return { ...resolved, ...(query !== undefined ? { query } : {}) };
}

function clean(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
