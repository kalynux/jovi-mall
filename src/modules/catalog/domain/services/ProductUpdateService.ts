import { NotFoundError, ForbiddenError } from '../../../../core/errors';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
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

    // NOTE: Images are managed through ProductMedia model separately
    // Not handled here to maintain proper relational structure

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
    }

    // Service config updates (merge with existing)
    if (command.serviceConfig !== undefined && product.type === 'service') {
      updates.serviceConfig = {
        ...product.serviceConfig,
        ...command.serviceConfig,
      } as any;
    }

    // Apply updates
    const updatedProduct = await this.productRepository.update(productId, vendorId, updates);

    if (!updatedProduct) {
      throw new NotFoundError('Product not found after update');
    }

    return updatedProduct;
  }
}
