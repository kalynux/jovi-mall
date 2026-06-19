import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
import { ProductType } from '../../../models/product.model';

/**
 * Image-count caps for product and variant media (`fileIds`).
 *
 * These are enforced in the controller/service layer (not in the Zod schemas)
 * because the cap depends on the product `type`, which is only known once the
 * product is loaded — not from the request body alone.
 */

/** Max images allowed on a single product, keyed by product type. */
export const PRODUCT_IMAGE_LIMITS: Record<ProductType, number> = {
  physical: 7,
  digital: 1,
  service: 7,
};

/**
 * Max images allowed on a single variant, keyed by the *parent product* type.
 * A service product's single variant carries only config + price — its visuals live
 * on the product media, so the variant image limit is 0.
 */
export const VARIANT_IMAGE_LIMITS: Record<ProductType, number> = {
  physical: 3,
  digital: 1,
  service: 0,
};

function pluralImages(limit: number): string {
  return `${limit} image${limit === 1 ? '' : 's'}`;
}

/**
 * Throw `CATALOG_IMAGE_LIMIT_EXCEEDED` if `count` exceeds the cap for a product
 * of the given `type`. No-op when within the limit.
 */
export function assertProductImageLimit(type: ProductType, count: number): void {
  const limit = PRODUCT_IMAGE_LIMITS[type];
  if (count > limit) {
    throw createAppError(
      ERROR_CODES.CATALOG_IMAGE_LIMIT_EXCEEDED,
      400,
      `A ${type} product can have at most ${pluralImages(limit)} (received ${count})`,
      { scope: 'product', type, limit, received: count },
    );
  }
}

/**
 * Throw `CATALOG_IMAGE_LIMIT_EXCEEDED` if `count` exceeds the cap for a variant
 * of a product of the given `type`. No-op when within the limit.
 */
export function assertVariantImageLimit(type: ProductType, count: number): void {
  const limit = VARIANT_IMAGE_LIMITS[type];
  if (count > limit) {
    throw createAppError(
      ERROR_CODES.CATALOG_IMAGE_LIMIT_EXCEEDED,
      400,
      `A ${type} product variant can have at most ${pluralImages(limit)} (received ${count})`,
      { scope: 'variant', type, limit, received: count },
    );
  }
}
