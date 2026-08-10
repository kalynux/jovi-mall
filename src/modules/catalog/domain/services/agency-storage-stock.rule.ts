import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { PickupLocationSource } from '../../models/product.model';

/**
 * The one rule: **a product warehoused by an agency cannot have unlimited stock.**
 *
 * `agency_storage` means an agency has physically taken this stock in. It bills
 * per SKU against a quantity, reconciles a shelf against a number, and (since the
 * two-sided adjustment flow) both parties sign off on changes to that number.
 * `isInfiniteStock` is the absence of a number, so the two cannot coexist.
 *
 * Enforced in three places, all through this file so they cannot drift:
 *   1. the activation gate (`ProductStatusValidationService.collectActivationBlockers`)
 *      — reports EVERY offending variant, like every other blocker there;
 *   2. `ProductUpdateService`, when a product's pickup source becomes
 *      `agency_storage` — throws rather than letting `revalidateActiveStatus`
 *      silently demote a live product to `draft`;
 *   3. the stock-adjustment request flow, which refuses to even create a request
 *      asking to go infinite on a stored product — so no approvable request can
 *      leave the product in a state its own activation gate rejects.
 *
 * Pure and dependency-free, so it is testable without Mongo.
 */

/** The subset of a variant this rule reads. */
export interface CountableStockVariant {
    status: 'active' | 'archived';
    isInfiniteStock: boolean;
    name?: string;
    sku: string;
}

/**
 * Labels of the ACTIVE variants that violate the rule, in input order. Empty when
 * the product is compliant. Archived variants are ignored: they are not on sale,
 * so they hold nothing an agency has to shelve.
 *
 * Returns labels rather than variants because that is all any caller needs — the
 * `{ variant }` detail on the error is what a vendor is shown.
 */
export function infiniteStockVariantLabels(
    variants: ReadonlyArray<CountableStockVariant>,
): string[] {
    return variants
        .filter(v => v.status === 'active' && v.isInfiniteStock)
        .map(v => v.name || v.sku);
}

/** True when this pickup source subjects the product to the rule. */
export function requiresCountableStock(
    source: PickupLocationSource | null | undefined,
): boolean {
    return source === 'agency_storage';
}

/**
 * Throw on the first offender. For the two *write* paths, where the caller is
 * proposing a change that would create the violation and the right answer is to
 * refuse the write, not to accept it and quietly unpublish the product.
 */
export function assertCountableStockForAgencyStorage(
    source: PickupLocationSource | null | undefined,
    variants: ReadonlyArray<CountableStockVariant>,
): void {
    if (!requiresCountableStock(source)) return;

    const offenders = infiniteStockVariantLabels(variants);
    if (offenders.length === 0) return;

    throw createAppError(
        ERROR_CODES.CATALOG_PRODUCT_AGENCY_STORAGE_INFINITE_STOCK,
        422,
        undefined,
        { variant: offenders[0], variants: offenders },
    );
}
