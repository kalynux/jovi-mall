import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';

export interface UpdateDigitalConfigDto {
  assetId?: string;
  maxDownloads?: number | null;
  expiresAfterDays?: number | null;
  isActive?: boolean;
}

export interface UpdateServiceConfigDto {
  durationMinutes?: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  bookingMode?: 'calendar' | 'manual' | 'capacity';
}

export interface UpdateProductCommand {
  title?: string;
  description?: string;
  images?: string[];
  category?: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  digitalConfig?: UpdateDigitalConfigDto;
  serviceConfig?: UpdateServiceConfigDto;
  regenerateSlug?: boolean;
}

/**
 * ProductUpdateService: Update existing products with state and ownership validation
 */
export class ProductUpdateService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository,
    private readonly slugService: SlugService
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

    if (command.seoTitle !== undefined || command.seoDescription !== undefined) {
      updates.seo = {
        ...product.seo,
        ...(command.seoTitle !== undefined && { title: command.seoTitle }),
        ...(command.seoDescription !== undefined && { description: command.seoDescription }),
      };
    }

    if (command.digitalConfig !== undefined && product.type === 'digital') {
      updates.digitalConfig = { ...product.digitalConfig, ...command.digitalConfig } as any;

      if (product.status === 'draft' && !product.hasVariants && !product.defaultVariantId) {
        const defaultVariant = await this.variantRepository.create({
          productId,
          sku: `${product.slug}-default`,
          name: 'Default',
          status: 'active',
          optionSignature: '',
          price: 0,
          stock: 0,
          isInfiniteStock: true,
          lowStockThreshold: null,
          allowOversell: false,
          optionValueIds: [],
          fileIds: [],
          deletedAt: null,
          purgeAt: null,
        });
        updates.hasVariants = true;
        updates.defaultVariantId = defaultVariant.id;
      }
    }

    if (command.serviceConfig !== undefined && product.type === 'service') {
      updates.serviceConfig = { ...product.serviceConfig, ...command.serviceConfig } as any;

      if (product.status === 'draft' && !product.hasVariants && !product.defaultVariantId) {
        const defaultVariant = await this.variantRepository.create({
          productId,
          sku: `${product.slug}-default`,
          name: 'Standard Service',
          status: 'active',
          optionSignature: '',
          price: 0,
          stock: 0,
          isInfiniteStock: true,
          lowStockThreshold: null,
          allowOversell: false,
          optionValueIds: [],
          fileIds: [],
          deletedAt: null,
          purgeAt: null,
        });
        updates.hasVariants = true;
        updates.defaultVariantId = defaultVariant.id;
      }
    }

    const updatedProduct = await this.productRepository.update(productId, vendorId, updates);

    if (!updatedProduct) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    return updatedProduct;
  }
}
