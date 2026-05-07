import { Types } from 'mongoose';
import { ProductModel, IProduct } from '../../../models/product.model';
import { DigitalAssetModel } from '../../../../digital-delivery/models/digital-asset.model';
import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';

/**
 * ProductDigitalService - Digital product business logic
 * 
 * Handles validation, configuration, and lifecycle of digital products.
 * Ensures digital products are properly configured with assets before activation.
 */

export interface DigitalConfigDto {
  assetId: string;
  maxDownloads: number | null;
  expiresAfterDays: number | null;
}

export class ProductDigitalService {
  /**
   * Validate that a product is digital type
   * @param product - Product to validate
   * @throws Error if not digital or missing config
   */
  validateDigitalProduct(product: IProduct): void {
    if (product.type !== 'digital') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Product is not a digital product');
    }

    if (!product.digitalConfig) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING, 400, 'Digital product must have digitalConfig defined');
    }

    if (!product.digitalConfig.assetId) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING, 400, 'Digital product must have assetId configured');
    }
  }

  /**
   * Assert that a product is digital (throws if not)
   * @param productId - Product ID
   * @throws Error if product not found or not digital
   */
  async assertIsDigital(productId: string): Promise<IProduct> {
    if (!Types.ObjectId.isValid(productId)) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 400, 'Invalid product ID');
    }

    const product = await ProductModel.findById(productId);

    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
    }

    if (product.type !== 'digital') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Product is not a digital product');
    }

    return product;
  }

  /**
   * Validate that vendor owns the specified asset
   * @param assetId - Asset ID
   * @param vendorId - Vendor ID
   * @throws Error if asset not found or ownership mismatch
   */
  async validateAssetOwnership(assetId: string, vendorId: string): Promise<void> {
    if (!Types.ObjectId.isValid(assetId)) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND, 400, 'Invalid asset ID');
    }

    const asset = await DigitalAssetModel.findOne({
      _id: assetId,
      deletedAt: null,
    });

    if (!asset) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_NOT_FOUND, 404, 'Digital asset not found');
    }

    if (asset.vendorId.toString() !== vendorId) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_ASSET_ACCESS_DENIED, 403, 'Unauthorized: Asset does not belong to this vendor');
    }
  }

  /**
   * Create or update digital configuration for a product
   * 
   * Updates the Product model's embedded digitalConfig only.
   * No need for separate DigitalProductConfig model - entitlement stores the snapshot.
   * 
   * @param productId - Product to configure
   * @param vendorId - Vendor making the change (ownership check)
   * @param config - Digital configuration
   */
  async createOrUpdateDigitalConfig(
    productId: string,
    vendorId: string,
    config: DigitalConfigDto
  ): Promise<void> {
    if (!Types.ObjectId.isValid(productId)) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 400, 'Invalid product ID');
    }

    // Load product with ownership check
    const product = await ProductModel.findOne({
      _id: productId,
      vendorId: new Types.ObjectId(vendorId),
      deletedAt: null,
    });

    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 404, 'Product not found or access denied');
    }

    // Verify product is digital
    if (product.type !== 'digital') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Can only configure digital products');
    }

    // Validate asset ownership
    await this.validateAssetOwnership(config.assetId, vendorId);

    // Update product's embedded digitalConfig
    product.digitalConfig = {
      assetId: new Types.ObjectId(config.assetId),
      maxDownloads: config.maxDownloads,
      expiresAfterDays: config.expiresAfterDays,
      isActive: true,
    };

    await product.save();

    // No need to sync to DigitalProductConfig - entitlement reads from Product directly
  }

  /**
   * Get digital configuration for a product
   * @param productId - Product ID
   * @returns Digital configuration
   * @throws Error if product not found or not digital
   */
  async getDigitalConfig(productId: string): Promise<any> {
    if (!Types.ObjectId.isValid(productId)) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 400, 'Invalid product ID');
    }

    const product = await ProductModel.findOne({
      _id: productId,
      deletedAt: null,
    });

    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404, 'Product not found');
    }

    if (product.type !== 'digital') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE, 400, 'Product is not a digital product');
    }

    if (!product.digitalConfig) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING, 400, 'Digital product has no configuration');
    }

    return product.digitalConfig;
  }

  /**
   * Deactivate digital configuration (soft delete)
   * @param productId - Product ID
   * @param vendorId - Vendor ID (ownership check)
   */
  async deactivateDigitalConfig(productId: string, vendorId: string): Promise<void> {
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

    if (product.type !== 'digital' || !product.digitalConfig) {
      throw createAppError(ERROR_CODES.CATALOG_DIGITAL_CONFIG_MISSING, 400, 'Product has no digital configuration');
    }

    // Deactivate in product
    product.digitalConfig.isActive = false;
    await product.save();
  }
}
