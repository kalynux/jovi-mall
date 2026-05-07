import { Types } from 'mongoose';
import {
  CustomerDigitalEntitlementModel,
  ICustomerDigitalEntitlement,
} from '../models/customer-digital-entitlement.model';
import { GrantEntitlementDto, EntitlementSummary } from '../types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * DigitalEntitlementService - Post-payment entitlement granting
 * 
 * CRITICAL GUARANTEES:
 * - Idempotent entitlement granting via unique index on (orderId, orderItemId)
 * - Webhook retries safe - duplicate key errors are caught and existing entitlement returned
 */
export class DigitalEntitlementService {
  /**
   * Grant digital product entitlement after payment
   * 
   * IDEMPOTENT: Can be called multiple times (webhook retries) - only creates once
   * 
   * @param dto - Entitlement data from order
   * @returns Created or existing entitlement
   */
  async grantEntitlement(
    dto: GrantEntitlementDto
  ): Promise<ICustomerDigitalEntitlement> {
    // Load product to get digitalConfig
    const { ProductModel } = await import('../../catalog/models/product.model');
    const product = await ProductModel.findOne({
      _id: new Types.ObjectId(dto.productId),
      type: 'digital',
      deletedAt: null,
    });

    if (!product || !product.digitalConfig) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_MISSING, 400, 'No active digital product configuration found for this product');
    }

    if (!product.digitalConfig.isActive) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_INACTIVE, 400, 'Digital product configuration is not active');
    }

    const config = product.digitalConfig;

    // Compute expiry
    let expiresAt: Date | null = null;
    if (config.expiresAfterDays !== null) {
      const daysInMs = config.expiresAfterDays * 24 * 60 * 60 * 1000;
      expiresAt = new Date(Date.now() + daysInMs);
    }

    // Try to create entitlement
    try {
      const entitlement = await CustomerDigitalEntitlementModel.create({
        orderId: new Types.ObjectId(dto.orderId),
        orderItemId: new Types.ObjectId(dto.orderItemId),
        productId: new Types.ObjectId(dto.productId),
        assetId: config.assetId,
        customerId: new Types.ObjectId(dto.customerId),
        vendorId: new Types.ObjectId(dto.vendorId),
        downloadsUsed: 0,
        maxDownloads: config.maxDownloads,
        expiresAt,
        revokedAt: null,
      });

      return entitlement;
    } catch (error: any) {
      // Handle duplicate key error (webhook retry)
      if (error.code === 11000) {
        // Already granted, return existing entitlement
        const existing = await CustomerDigitalEntitlementModel.findOne({
          orderId: new Types.ObjectId(dto.orderId),
          orderItemId: new Types.ObjectId(dto.orderItemId),
        });

        if (!existing) {
          throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 500, 'Duplicate entitlement but not found in database');
        }

        return existing;
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Get all entitlements for a customer
   * @param customerId - Customer ID
   * @returns Array of entitlement summaries
   */
  async getCustomerEntitlements(
    customerId: string
  ): Promise<EntitlementSummary[]> {
    const entitlements = await CustomerDigitalEntitlementModel.find({
      customerId: new Types.ObjectId(customerId),
      deletedAt: null,
    })
      .populate('productId', 'title')
      .populate('assetId', 'originalName')
      .sort({ createdAt: -1 });

    const now = new Date();

    return entitlements.map((e: any) => {
      const isExpired = e.expiresAt !== null && e.expiresAt < now;
      const isRevoked = e.revokedAt !== null;
      const hasDownloadsRemaining =
        e.maxDownloads === null || e.downloadsUsed < e.maxDownloads;
      const canDownload = !isExpired && !isRevoked && hasDownloadsRemaining;

      return {
        id: e.id,
        productId: e.productId.id,
        productTitle: e.productId.title,
        assetId: e.assetId.id,
        originalName: e.assetId.originalName,
        downloadsUsed: e.downloadsUsed,
        maxDownloads: e.maxDownloads,
        expiresAt: e.expiresAt,
        revokedAt: e.revokedAt,
        isExpired,
        isRevoked,
        canDownload,
      };
    });
  }

  /**
   * Check if a customer can download an entitlement
   * @param entitlementId - Entitlement ID
   * @param customerId - Customer ID (ownership check)
   * @returns true if download is allowed
   */
  async checkEntitlement(
    entitlementId: string,
    customerId: string
  ): Promise<boolean> {
    if (!Types.ObjectId.isValid(entitlementId)) {
      return false;
    }

    const entitlement = await CustomerDigitalEntitlementModel.findOne({
      _id: entitlementId,
      customerId: new Types.ObjectId(customerId),
      deletedAt: null,
    });

    if (!entitlement) {
      return false;
    }

    // Check not revoked
    if (entitlement.revokedAt !== null) {
      return false;
    }

    // Check not expired
    if (entitlement.expiresAt !== null && entitlement.expiresAt < new Date()) {
      return false;
    }

    // Check downloads available
    if (
      entitlement.maxDownloads !== null &&
      entitlement.downloadsUsed >= entitlement.maxDownloads
    ) {
      return false;
    }

    return true;
  }

  /**
   * Revoke an entitlement (admin/vendor action)
   * @param entitlementId - Entitlement ID
   * @param reason - Reason for revocation (audit trail)
   */
  async revokeEntitlement(
    entitlementId: string,
    reason: string
  ): Promise<void> {
    if (!Types.ObjectId.isValid(entitlementId)) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 400, 'Invalid entitlement ID');
    }

    const result = await CustomerDigitalEntitlementModel.updateOne(
      { _id: entitlementId, deletedAt: null },
      {
        $set: {
          revokedAt: new Date(),
          // TODO: Add audit log entry with reason
        },
      }
    );

    if (result.modifiedCount === 0) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404, 'Entitlement not found or already revoked');
    }
  }

  /**
   * Get entitlement by ID (internal use)
   * @param entitlementId - Entitlement ID
   * @returns Entitlement or null
   */
  async getEntitlementById(
    entitlementId: string
  ): Promise<ICustomerDigitalEntitlement | null> {
    if (!Types.ObjectId.isValid(entitlementId)) {
      return null;
    }

    return await CustomerDigitalEntitlementModel.findOne({
      _id: entitlementId,
      deletedAt: null,
    });
  }
}
