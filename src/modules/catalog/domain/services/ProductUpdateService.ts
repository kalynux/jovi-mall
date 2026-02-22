import { NotFoundError, ForbiddenError } from '../../../../core/errors';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../repositories/interfaces/variant.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';

// DTO-compatible types (accept strings from HTTP requests)
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
  images?: string[]; // Full array replacement

  // Categorization
  category?: string;
  tags?: string[];

  // SEO
  seoTitle?: string;
  seoDescription?: string;

  // Type-specific configs (use DTO types, not Mongoose types)
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

  /**
   * Update an existing product
   * @param productId - Product ID
   * @param vendorId - Vendor ID for ownership check
   * @param command - Update command with allowed fields only
   * @returns Updated product domain entity
   */
  async execute(
    productId: string,
    vendorId: string,
    command: UpdateProductCommand
  ): Promise<Product> {
    // Load product
    const product = await this.productRepository.findById(productId, vendorId);

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Vendor ownership check
    if (product.vendorId !== vendorId) {
      throw new ForbiddenError('You do not have permission to update this product');
    }

    // State validation: only DRAFT or ACTIVE can be updated
    if (product.status !== 'draft' && product.status !== 'active') {
      throw new ForbiddenError(
        `Cannot update product in ${product.status.toUpperCase()} state. Only DRAFT or ACTIVE products can be updated.`
      );
    }

    // Build updates
    const updates: Partial<Product> = {};

    if (command.title !== undefined) {
      updates.title = command.title.trim();

      // Regenerate slug if requested
      if (command.regenerateSlug) {
        updates.slug = await this.slugService.generate(updates.title, vendorId);
      }
    }

    if (command.description !== undefined) {
      updates.description = command.description;
    }

    if (command.category !== undefined) {
      updates.category = command.category;
    }

    if (command.tags !== undefined) {
      updates.tags = command.tags;
    }

    // NOTE: Images are managed through ProductMedia model separately;
    // not handled here to maintain proper relational structure.

    // SEO fields
    if (command.seoTitle !== undefined || command.seoDescription !== undefined) {
      updates.seo = {
        ...product.seo,
        ...(command.seoTitle !== undefined && { title: command.seoTitle }),
        ...(command.seoDescription !== undefined && { description: command.seoDescription }),
      };
    }

    // Digital config updates (merge with existing)
    if (command.digitalConfig !== undefined && product.type === 'digital') {
      updates.digitalConfig = {
        ...product.digitalConfig,
        ...command.digitalConfig,
      } as any;

      // AUTO-CREATE DEFAULT VARIANT FOR DIGITAL PRODUCTS
      // IDEMPOTENT: Only create if product is draft, no variants exist, and no defaultVariantId
      if (
        product.status === 'draft' &&
        !product.hasVariants &&
        !product.defaultVariantId
      ) {
        const defaultVariant = await this.variantRepository.create({
          productId: productId,
          sku: `${product.slug}-default`,
          name: 'Default', // Default variant name for digital products
          status: 'active',
          optionSignature: '',
          price: 0, // Must be set before publishing
          stock: 0,
          isInfiniteStock: true, // Digital products have infinite stock
          lowStockThreshold: null,
          allowOversell: false,
          optionValueIds: [],
          fileIds: [],
          deletedAt: null,
          purgeAt: null,
        });

        // Mark product as having variants
        updates.hasVariants = true;
        updates.defaultVariantId = defaultVariant.id;
      }
    }

    // Service config updates (merge with existing)
    if (command.serviceConfig !== undefined && product.type === 'service') {
      updates.serviceConfig = {
        ...product.serviceConfig,
        ...command.serviceConfig,
      } as any;

      // AUTO-CREATE DEFAULT VARIANT FOR SERVICE PRODUCTS
      // IDEMPOTENT: Only create if product is draft, no variants exist, and no defaultVariantId
      if (
        product.status === 'draft' &&
        !product.hasVariants &&
        !product.defaultVariantId
      ) {
        const defaultVariant = await this.variantRepository.create({
          productId: productId,
          sku: `${product.slug}-default`,
          name: 'Standard Service', // Default variant name for service products
          status: 'active',
          optionSignature: '',
          price: 0, // Must be set before publishing
          stock: 0,
          isInfiniteStock: true, // Services have infinite stock
          lowStockThreshold: null,
          allowOversell: false,
          optionValueIds: [],
          fileIds: [],
          deletedAt: null,
          purgeAt: null,
        });

        // Mark product as having variants
        updates.hasVariants = true;
        updates.defaultVariantId = defaultVariant.id;
      }
    }

    // Apply updates
    const updatedProduct = await this.productRepository.update(productId, vendorId, updates);

    if (!updatedProduct) {
      throw new NotFoundError('Product not found after update');
    }

    return updatedProduct;
  }
}
