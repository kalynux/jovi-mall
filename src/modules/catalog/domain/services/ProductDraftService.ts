import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';

export interface CreateProductInput {
  vendorId: string;
  type: 'physical' | 'digital' | 'service';
  title: string;
  category: string;
  tags?: string[];
}

/**
 * ProductDraftService: Create new products in DRAFT state
 */
export class ProductDraftService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly slugService: SlugService
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

    const productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> = {
      vendorId: input.vendorId,
      type: input.type,
      status: 'draft',
      title: trimmedTitle,
      description: '',
      slug,
      category: input.category,
      tags: input.tags ?? [],
      seo: {},
      hasVariants: false,
      deletedAt: null,
      fileIds: [],
    };

    return this.productRepository.create(productData);
  }
}
