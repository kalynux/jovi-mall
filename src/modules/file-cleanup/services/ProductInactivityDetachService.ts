import { Types } from 'mongoose';
import { ProductModel } from '../../catalog/models/product.model';
import { ProductVariantModel } from '../../catalog/models/product-variant.model';
import { IFileReferenceRepository } from '../../catalog/repositories/interfaces/file-reference.repository.interface';
import { FileReferenceEntityType } from '../../catalog/models/file-reference.model';
import { FileCleanupConfig, daysAgo } from '../../../config/file-cleanup.config';
import { DigitalEntitlementGuard } from './DigitalEntitlementGuard';
import { CleanupAuditRepository } from '../repositories/cleanup-audit.repository';

export interface DetachStageResult {
  productsProcessed: number;
  referencesDetached: number;
  skippedProtected: number;
}

/**
 * ProductInactivityDetachService — Stage A (products).
 *
 * Detaches product/variant MEDIA files from products that have had no paid order
 * for `productInactivityDays`. Inactivity is `lastOrderedAt ?? createdAt < cutoff`,
 * so a product that never sold uses its creation date as the clock.
 *
 * Scope is deliberately product/variant media only — digital product assets are
 * out of scope here (they are the sellable goods, governed by entitlements). The
 * entitlement guard is still applied as defense-in-depth in case a media file is
 * somehow shared with a digital asset.
 *
 * Each reference is detached individually (not via a bulk cascade) so the guard
 * can spare protected files. Removing the reference flips File.orphanedAt via the
 * file-reference layer, starting the lonely clock for Stage B.
 */
export class ProductInactivityDetachService {
  constructor(
    private readonly fileReferenceRepository: IFileReferenceRepository,
    private readonly guard: DigitalEntitlementGuard,
    private readonly audit: CleanupAuditRepository,
    private readonly config: FileCleanupConfig,
  ) {}

  async run(sweepId: string, now: Date = new Date()): Promise<DetachStageResult> {
    const cutoff = daysAgo(this.config.productInactivityDays, now);
    const result: DetachStageResult = {
      productsProcessed: 0,
      referencesDetached: 0,
      skippedProtected: 0,
    };

    const inactiveProducts = await ProductModel.find({
      deletedAt: null,
      $or: [
        { lastOrderedAt: { $ne: null, $lt: cutoff } },
        { lastOrderedAt: null, createdAt: { $lt: cutoff } },
      ],
    })
      .select('_id vendorId')
      .limit(this.config.batchSize)
      .lean();

    for (const product of inactiveProducts) {
      result.productsProcessed += 1;
      const productId = product._id.toString();
      const vendorId = product.vendorId?.toString();

      // The product itself, plus all its variants, are inactive together.
      const entities: Array<{ type: FileReferenceEntityType; id: string }> = [
        { type: 'product', id: productId },
      ];

      const variants = await ProductVariantModel.find({
        productId: product._id,
        deletedAt: null,
      })
        .select('_id')
        .lean();
      for (const variant of variants) {
        entities.push({ type: 'variant', id: variant._id.toString() });
      }

      for (const entity of entities) {
        const refs = await this.fileReferenceRepository.findByEntity(entity.type, entity.id);
        for (const ref of refs) {
          const detached = await this.detachReference(sweepId, vendorId, ref.fileId, entity, ref.field);
          if (detached === 'detached') result.referencesDetached += 1;
          else if (detached === 'skipped') result.skippedProtected += 1;
        }
      }
    }

    return result;
  }

  private async detachReference(
    sweepId: string,
    vendorId: string | undefined,
    fileId: string,
    entity: { type: FileReferenceEntityType; id: string },
    field: string,
  ): Promise<'detached' | 'skipped'> {
    if (this.config.protectDigitalEntitlements && (await this.guard.isProtected(fileId))) {
      await this.audit.record({
        sweepId,
        stage: 'product_detach',
        action: 'skip',
        dryRun: this.config.dryRun,
        fileId,
        entityType: entity.type,
        entityId: entity.id,
        vendorId,
        reason: 'protected: live customer download entitlement',
      });
      return 'skipped';
    }

    if (!this.config.dryRun) {
      await this.fileReferenceRepository.remove(fileId, entity.type, entity.id, field);
      await this.pullFileId(entity, fileId);
    }

    await this.audit.record({
      sweepId,
      stage: 'product_detach',
      action: 'detach',
      dryRun: this.config.dryRun,
      fileId,
      entityType: entity.type,
      entityId: entity.id,
      vendorId,
      reason: `product inactive ≥ ${this.config.productInactivityDays}d`,
    });
    return 'detached';
  }

  /** Keep the denormalized fileIds array in sync with the removed reference. */
  private async pullFileId(entity: { type: FileReferenceEntityType; id: string }, fileId: string): Promise<void> {
    if (!Types.ObjectId.isValid(fileId)) return;
    const fileObjectId = new Types.ObjectId(fileId);
    if (entity.type === 'product') {
      await ProductModel.updateOne({ _id: entity.id }, { $pull: { fileIds: fileObjectId } });
    } else if (entity.type === 'variant') {
      await ProductVariantModel.updateOne({ _id: entity.id }, { $pull: { fileIds: fileObjectId } });
    }
  }
}
