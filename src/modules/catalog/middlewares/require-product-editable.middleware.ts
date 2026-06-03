import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { ProductModel } from '../models/product.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * requireProductEditable
 *
 * Blocks any mutation on a product whose vectorisation pipeline is currently in flight.
 *
 * Why: the vectoriser receives a full snapshot of the product (title, description,
 * variants, options, configs). Allowing edits while a request is still pending would
 * race the upstream pipeline and leave us with inconsistent vector data on the
 * external service at https://the8n.fante.cloud/vectoriser.
 *
 * Resolves the product id from one of:
 *   - req.params.id
 *   - req.params.productId
 *
 * Returns 409 with CATALOG_PRODUCT_VECTORISATION_PENDING when the product's
 * vectorisationStatus is 'pending'.
 *
 * Notes:
 *   - This middleware does NOT enforce ownership — that's still done downstream by
 *     vendor-scoped repository queries. We only check the pending lock here.
 *   - We use a lean projection for speed; no full mapping needed.
 */
export const requireProductEditable = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const productId = (req.params.id ?? req.params.productId) as string | undefined;

  // No productId in the URL — nothing to gate; let downstream handlers respond.
  if (!productId || !Types.ObjectId.isValid(productId)) {
    return next();
  }

  const product = await ProductModel.findOne(
    { _id: productId, deletedAt: null },
    { vectorisationStatus: 1 },
  ).lean();

  // Product not found — let downstream handlers respond with the right 404.
  if (!product) return next();

  if (product.vectorisationStatus === 'pending') {
    return next(
      createAppError(
        ERROR_CODES.CATALOG_PRODUCT_VECTORISATION_PENDING,
        409,
        'This product is currently being vectorised. Please try again once vectorisation is complete.',
        { productId, vectorisationStatus: product.vectorisationStatus },
      ),
    );
  }

  return next();
};
