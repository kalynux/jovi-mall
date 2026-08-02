import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { Product } from '../../../repositories/mappers/product.mapper';

/**
 * Guards the simple-mode invariant: exactly ONE variant, ZERO options.
 *
 * Called from the advanced endpoints that would break it. Extracted rather than
 * inlined at each site so the error code, the `details` payload and the shape of
 * the message stay identical everywhere — the frontend renders one "switch to
 * the advanced editor" affordance off any of these 409s, and it can only do that
 * if `details.convertEndpoint` is always present.
 *
 * `operation` completes the sentence "…so {operation} is not available", e.g.
 * 'adding another variant'.
 */
export function assertNotSimpleMode(product: Product, operation: string): void {
    // 'advanced' and legacy documents (no `mode` key, coerced to 'advanced' by
    // the mapper) both pass — this only ever fires on an explicit 'simple'.
    if (product.mode !== 'simple') return;

    throw createAppError(
        ERROR_CODES.CATALOG_PRODUCT_SIMPLE_MODE_LOCKED,
        409,
        `This product uses the simple editor, so ${operation} is not available. Convert it to the advanced editor first.`,
        {
            mode: 'simple',
            convertEndpoint: `POST /api/vendor/products/${product.id}/convert-to-advanced`,
        },
    );
}

/**
 * The mirror image: the simple endpoints refuse an advanced product.
 *
 * Strict on purpose. `PATCH /:id/simple` writes "the default variant", which on
 * a product with twelve variants is a silently destructive operation — better a
 * 409 pointing at the granular endpoints than a surprise price change.
 */
export function assertSimpleMode(product: Product): void {
    if (product.mode === 'simple') return;

    throw createAppError(
        ERROR_CODES.CATALOG_PRODUCT_NOT_SIMPLE_MODE,
        409,
        'This product uses the advanced editor. Use PATCH /api/vendor/products/:id and the variant endpoints to edit it.',
        { mode: product.mode },
    );
}
