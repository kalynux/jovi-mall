import { Types } from 'mongoose';
import { ProductModel, IProduct } from '../../../models/product.model';
import { ProductVariantModel, IProductVariant } from '../../../models/product-variant.model';
import { DigitalAssetModel, IDigitalAsset } from '../../../../digital-delivery/models/digital-asset.model';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

/**
 * VariantDigitalService — per-variant digital-asset lifecycle.
 *
 * Invariant: a digital variant has `status: 'active'` iff `digitalConfig.assetId` is set.
 *   - attachAssetToVariant: status -> 'active' (asset just set)
 *   - clearVariantAsset:    status -> 'archived' (no asset, can't sell)
 *   - replaceVariantAsset:  status preserved (asset stays set)
 */
export class VariantDigitalService {
  private async loadDigitalProduct(productId: string, vendorId: string): Promise<IProduct> {
    if (!Types.ObjectId.isValid(productId)) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 400, 'Invalid product ID');
    }
    const product = await ProductModel.findOne({
      _id: productId,
      vendorId: new Types.ObjectId(vendorId),
      deletedAt: null,
    });
    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 404, 'Product not found or access denied');
    }
    if (product.type !== 'digital') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Product is not a digital product');
    }
    return product;
  }

  private async loadVariant(productId: string, variantId: string): Promise<IProductVariant> {
    if (!Types.ObjectId.isValid(variantId)) {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 400, 'Invalid variant ID');
    }
    const variant = await ProductVariantModel.findOne({
      _id: variantId,
      productId: new Types.ObjectId(productId),
      deletedAt: null,
    });
    if (!variant) {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404, 'Variant not found for this product');
    }
    return variant;
  }

  /**
   * Verify a vendor owns the given DigitalAsset.
   */
  async validateAssetOwnership(assetId: string, vendorId: string): Promise<IDigitalAsset> {
    if (!Types.ObjectId.isValid(assetId)) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND, 400, 'Invalid asset ID');
    }
    const asset = await DigitalAssetModel.findOne({ _id: assetId, deletedAt: null });
    if (!asset) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND, 404, 'Digital asset not found');
    }
    if (asset.vendorId.toString() !== vendorId) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_ACCESS_DENIED, 403, 'Unauthorized: Asset does not belong to this vendor');
    }
    return asset;
  }

  /**
   * Attach a freshly uploaded digital asset to a variant. Rejects if the variant
   * already has an asset (caller should use `replaceVariantAsset` instead).
   * Transitions variant.status -> 'active'.
   */
  async attachAssetToVariant(
    productId: string,
    variantId: string,
    vendorId: string,
    asset: IDigitalAsset,
  ): Promise<void> {
    await this.loadDigitalProduct(productId, vendorId);
    const variant = await this.loadVariant(productId, variantId);

    if (variant.digitalConfig?.assetId) {
      throw createAppError(
        ERROR_CODES.CATALOG_DIGITAL_ASSET_ALREADY_EXISTS,
        409,
        'Variant already has a digital asset. Use PUT to replace it.',
      );
    }

    variant.digitalConfig = {
      assetId: asset._id as Types.ObjectId,
      maxDownloads: variant.digitalConfig?.maxDownloads ?? null,
      expiresAfterDays: variant.digitalConfig?.expiresAfterDays ?? null,
    };
    variant.status = 'active';
    await variant.save();
  }

  /**
   * Swap the digital asset on a variant. Returns the previous assetId so the
   * controller can delete the old File + DigitalAsset records.
   * Variant.status is preserved (it stays 'active' since the asset stays set).
   */
  async replaceVariantAsset(
    productId: string,
    variantId: string,
    vendorId: string,
    newAsset: IDigitalAsset,
  ): Promise<{ oldAssetId: string }> {
    await this.loadDigitalProduct(productId, vendorId);
    const variant = await this.loadVariant(productId, variantId);

    if (!variant.digitalConfig?.assetId) {
      throw createAppError(
        ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING,
        404,
        'Variant has no digital asset to replace. Use POST to upload.',
      );
    }

    const oldAssetId = variant.digitalConfig.assetId.toString();
    variant.digitalConfig.assetId = newAsset._id as Types.ObjectId;
    // Asset is still set; keep status as-is (should remain 'active').
    await variant.save();

    return { oldAssetId };
  }

  /**
   * Remove the digital asset from a variant. Returns the cleared assetId so the
   * controller can delete the underlying File + DigitalAsset records.
   * Transitions variant.status -> 'archived' (no asset == cannot be sold).
   */
  async clearVariantAsset(
    productId: string,
    variantId: string,
    vendorId: string,
  ): Promise<{ assetId: string }> {
    await this.loadDigitalProduct(productId, vendorId);
    const variant = await this.loadVariant(productId, variantId);

    if (!variant.digitalConfig?.assetId) {
      throw createAppError(
        ERROR_CODES.CATALOG_DIGITAL_ASSET_MISSING,
        404,
        'Variant has no digital asset to remove',
      );
    }

    const assetId = variant.digitalConfig.assetId.toString();
    variant.digitalConfig.assetId = undefined;
    variant.status = 'archived';
    await variant.save();

    return { assetId };
  }

  /**
   * Update download limits on a variant. Does not touch `assetId`.
   * Status is unaffected — the asset's presence (or absence) drives it.
   */
  async updateVariantDigitalConfig(
    productId: string,
    variantId: string,
    vendorId: string,
    config: { maxDownloads?: number | null; expiresAfterDays?: number | null },
  ): Promise<void> {
    await this.loadDigitalProduct(productId, vendorId);
    const variant = await this.loadVariant(productId, variantId);

    if (!variant.digitalConfig) {
      variant.digitalConfig = {
        maxDownloads: config.maxDownloads ?? null,
        expiresAfterDays: config.expiresAfterDays ?? null,
      };
    } else {
      if ('maxDownloads' in config) variant.digitalConfig.maxDownloads = config.maxDownloads ?? null;
      if ('expiresAfterDays' in config) variant.digitalConfig.expiresAfterDays = config.expiresAfterDays ?? null;
    }
    await variant.save();
  }
}
