import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';
import { FileReferenceService } from './media/FileReferenceService';
import { assertProductImageLimit } from './media/image-limits';

// Per-variant asset/limits live on ProductVariant.digitalConfig now.
// Only the product-wide `isActive` kill switch is updatable here.
export interface UpdateDigitalConfigDto {
  isActive?: boolean;
}

export interface UpdateDeliveryConfigDto {
  agencyId?: string | null;
  freeDelivery?: boolean;
}

export interface UpdateProductCommand {
  title?: string;
  description?: string;
  fileIds?: string[];            // Full array replacement for product media
  category?: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  digitalConfig?: UpdateDigitalConfigDto;
  delivery?: UpdateDeliveryConfigDto;
  regenerateSlug?: boolean;
}

/**
 * ProductUpdateService: Update existing products with state and ownership validation
 */
export class ProductUpdateService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly slugService: SlugService,
    private readonly fileReferenceService: FileReferenceService
  ) { }

  async execute(
    productId: string,
    vendorId: string,
    command: UpdateProductCommand
  ): Promise<Product> {
    const product = await this.productRepository.findById(productId, vendorId);

    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    if (product.vendorId !== vendorId) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
    }

    if (product.status !== 'draft' && product.status !== 'active') {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });
    }

    const updates: Partial<Product> = {};

    if (command.title !== undefined) {
      updates.title = command.title.trim();
      if (command.regenerateSlug) {
        updates.slug = await this.slugService.generate(updates.title, vendorId);
      }
    }

    if (command.description !== undefined) updates.description = command.description;
    if (command.category !== undefined) updates.category = command.category;
    if (command.tags !== undefined) updates.tags = command.tags;

    // Full array replacement — frontend must send the complete desired array
    if (command.fileIds !== undefined) {
      assertProductImageLimit(product.type, command.fileIds.length);
      updates.fileIds = command.fileIds;
    }

    if (command.seoTitle !== undefined || command.seoDescription !== undefined) {
      updates.seo = {
        ...product.seo,
        ...(command.seoTitle !== undefined && { title: command.seoTitle }),
        ...(command.seoDescription !== undefined && { description: command.seoDescription }),
      };
    }

    if (command.digitalConfig !== undefined && product.type === 'digital') {
      updates.digitalConfig = { ...product.digitalConfig, ...command.digitalConfig } as any;
    }

    if (command.delivery !== undefined) {
      if (product.type !== 'physical') {
        throw createAppError(
          ERROR_CODES.CATALOG_PRODUCT_INVALID_TYPE,
          400,
          'Delivery configuration only applies to physical products',
        );
      }
      // Each sub-field is independently optional, so merge against the existing
      // persisted value instead of replacing — otherwise setting one field would
      // silently wipe the other. Persistence uses snake_case — see product.model.ts schema.
      const existingDelivery = product.delivery;
      (updates as any).delivery = {
        agency_id: command.delivery.agencyId !== undefined
          ? command.delivery.agencyId
          : (existingDelivery?.agencyId ?? null),
        free_delivery: command.delivery.freeDelivery !== undefined
          ? command.delivery.freeDelivery
          : (existingDelivery?.freeDelivery ?? false),
      };
    }

    // Keep file references in sync with the replaced media array. Runs before the
    // product write so an unauthorized file reference is rejected before it is
    // ever persisted.
    if (command.fileIds !== undefined) {
      await this.fileReferenceService.reconcile({
        previousFileIds: product.fileIds ?? [],
        nextFileIds: command.fileIds,
        vendorId,
        entityType: 'product',
        entityId: productId,
      });
    }

    const updatedProduct = await this.productRepository.update(productId, vendorId, updates);

    if (!updatedProduct) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    return updatedProduct;
  }
}
