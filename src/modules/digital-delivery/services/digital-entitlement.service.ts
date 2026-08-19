import { Types } from 'mongoose';
import {
  CustomerDigitalEntitlementModel,
  ICustomerDigitalEntitlement,
} from '../models/customer-digital-entitlement.model';
import { GrantEntitlementDto, EntitlementSummary } from '../types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { OrderTimelineRepository } from '../../orders/order-timeline.repository';
import { TimelineActorType } from '../../orders/order-timeline.model';

/**
 * DigitalEntitlementService - Post-payment entitlement granting
 *
 * CRITICAL GUARANTEES:
 * - Idempotent entitlement granting via unique index on (orderId, orderItemId)
 * - Webhook retries safe - duplicate key errors are caught and existing entitlement returned
 */
export class DigitalEntitlementService {
  /**
   * The order timeline is this module's audit trail — append-only, and the same one
   * `VendorOrderService` writes entitlement events to. Constructed here rather than injected
   * to match the surrounding style; it holds no state.
   */
  private readonly timelineRepo = new OrderTimelineRepository();

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
    // Product-wide kill switch — vendor can disable all downloads via this flag.
    const { ProductModel } = await import('../../catalog/models/product.model');
    const productActive = await ProductModel.exists({
      _id: new Types.ObjectId(dto.productId),
      type: 'digital',
      'digitalConfig.isActive': true,
      deletedAt: null,
    });

    if (!productActive) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_CONFIG_INACTIVE, 400, 'Digital product is not active');
    }

    // Compute expiry from the snapshotted variant config in dto.
    let expiresAt: Date | null = null;
    if (dto.expiresAfterDays !== null) {
      const daysInMs = dto.expiresAfterDays * 24 * 60 * 60 * 1000;
      expiresAt = new Date(Date.now() + daysInMs);
    }

    // Try to create entitlement
    try {
      const entitlement = await CustomerDigitalEntitlementModel.create({
        orderId: new Types.ObjectId(dto.orderId),
        orderItemId: new Types.ObjectId(dto.orderItemId),
        productId: new Types.ObjectId(dto.productId),
        variantId: new Types.ObjectId(dto.variantId),
        assetId: new Types.ObjectId(dto.assetId),
        customerId: new Types.ObjectId(dto.customerId),
        vendorId: new Types.ObjectId(dto.vendorId),
        downloadsUsed: 0,
        maxDownloads: dto.maxDownloads,
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
      .populate('variantId', 'name sku')
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
        productId: e.productId?.id ?? e.productId?.toString(),
        productTitle: e.productId?.title,
        variantId: e.variantId?.id ?? e.variantId?.toString(),
        variantName: e.variantId?.name ?? e.variantId?.sku,
        assetId: e.assetId?.id ?? e.assetId?.toString(),
        originalName: e.assetId?.originalName,
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
   * Revoke an entitlement — take back something a customer paid for.
   *
   * ── The reason is now RECORDED, not just accepted ────────────────────────────
   * This used to `$set: { revokedAt }` with a debt marker where the record should be — "add
   * audit log entry with reason" — so the `reason` parameter was collected from the caller
   * and discarded. Revocation removes purchased access; "when" without "why" or "who" cannot
   * answer the only question anybody asks afterwards.
   *
   * It writes the module's EXISTING audit convention — an append-only `entitlement.revoked`
   * entry on the order's timeline — rather than a second one. `VendorOrderService`'s twin
   * (`/api/vendor/entitlements/:id/revoke`, the live door) already writes that exact event
   * with that exact metadata shape; two doors onto one act must produce one kind of record,
   * or a timeline read answers differently depending on which was used.
   *
   * ⚠ **The vendor service's method is the one that currently runs.** This one has no route
   * of its own. Keep the two in step: a change to the shape here needs the same change there.
   *
   * Three ordering properties are load-bearing:
   *
   * - **The revoke is a compare-and-set on `revokedAt: null`.** Two administrators holding
   *   the screen open would otherwise both "succeed", stamping the second one's moment over
   *   the first's and writing two timeline entries for one revocation.
   * - **The audit is appended only AFTER the CAS reports it took.** Auditing first, or
   *   unconditionally, records a revocation that a lost race means never happened.
   * - **404 and 422 stay distinct.** "No such entitlement" and "already revoked" have
   *   different remedies, and the old `modifiedCount === 0` check collapsed them into a 404
   *   that told the second administrator their colleague's entitlement did not exist.
   *
   * @param entitlementId - Entitlement ID
   * @param reason - Why. Recorded on the order timeline; required, never optional.
   * @param actor - Who. `actorId` is null for `system`, which is why it is nullable.
   */
  async revokeEntitlement(
    entitlementId: string,
    reason: string,
    actor: { type: TimelineActorType; id?: string | null }
  ): Promise<void> {
    if (!Types.ObjectId.isValid(entitlementId)) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 400, 'Invalid entitlement ID');
    }

    // Read first: the timeline entry belongs to the entitlement's ORDER, so the document is
    // needed either way — which is also what lets 404 and 422 be told apart below.
    const entitlement = await CustomerDigitalEntitlementModel.findOne({
      _id: entitlementId,
      deletedAt: null,
    });

    if (!entitlement) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_NOT_FOUND, 404, 'Entitlement not found');
    }

    if (entitlement.revokedAt !== null) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_ALREADY_REVOKED, 422, 'Entitlement is already revoked');
    }

    const revokedAt = new Date();
    const result = await CustomerDigitalEntitlementModel.updateOne(
      { _id: entitlementId, deletedAt: null, revokedAt: null },
      { $set: { revokedAt } }
    );

    // A miss here is the race the read above cannot close: somebody revoked it in between.
    // Theirs is the revocation of record, and nothing is appended for ours.
    if (result.modifiedCount === 0) {
      throw createAppError(ERROR_CODES.DIGITAL_ENTITLEMENT_ALREADY_REVOKED, 422, 'Entitlement is already revoked');
    }

    await this.timelineRepo.appendEvent({
      orderId: entitlement.orderId.toString(),
      eventType: 'entitlement.revoked',
      description: `Digital entitlement revoked: ${reason}`,
      metadata: {
        entitlementId,
        productId: entitlement.productId.toString(),
        customerId: entitlement.customerId.toString(),
        revokedAt,
        reason,
      },
      actorType: actor.type,
      actorId: actor.id ?? null,
    });
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
