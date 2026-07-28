import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';
import { FileReferenceService } from './media/FileReferenceService';
import { assertProductImageLimit } from './media/image-limits';

export interface CreateProductInput {
  vendorId: string;
  type: 'physical' | 'digital' | 'service';
  title: string;
  description?: string;
  category: string;
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  fileIds?: string[];
}

/**
 * ProductDraftService: Create new products in DRAFT state
 */
export class ProductDraftService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly slugService: SlugService,
    private readonly fileReferenceService: FileReferenceService
  ) { }

  async execute(input: CreateProductInput): Promise<Product> {
    const trimmedTitle = input.title.trim();

    if (!trimmedTitle) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE, 422, 'Product title cannot be empty');
    }

    if (trimmedTitle.length < 3) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_TITLE, 422, 'Product title must be at least 3 characters long');
    }

    const slug = await this.slugService.generate(trimmedTitle, input.vendorId);

    const fileIds = input.fileIds ?? [];
    assertProductImageLimit(input.type, fileIds.length);

    const productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> = {
      vendorId: input.vendorId,
      type: input.type,
      status: 'draft',
      title: trimmedTitle,
      description: input.description ?? '',
      slug,
      category: input.category,
      tags: input.tags ?? [],
      seo: {
        title: input.seoTitle ?? '',
        description: input.seoDescription ?? '',
      },
      hasVariants: false,
      deletedAt: null,
      // Media is attached after the product exists, but only once the files are
      // authorized — never persist an unauthorized reference.
      fileIds: [],
      // Vectorisation defaults — never enabled on a fresh draft
      vectorisationEnabled: false,
      vectorisationStatus: 'not_started',
      vectorisedDataId: null,
    };

    const product = await this.productRepository.create(productData);

    if (fileIds.length === 0) return product;

    // Authorize + count the media (throws before the array is persisted if a
    // file is not vendor-owned), then attach it to the product.
    await this.fileReferenceService.reconcile({
      previousFileIds: [],
      nextFileIds: fileIds,
      actor: { type: 'vendor', id: input.vendorId },
      entityType: 'product',
      entityId: product.id,
    });

    const withFiles = await this.productRepository.update(product.id, input.vendorId, { fileIds });
    return withFiles ?? product;
  }
}
