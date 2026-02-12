import { ValidationError } from '../../../../core/errors';
import { IProductRepository } from '../../repositories/interfaces/product.repository.interface';
import { Product } from '../../repositories/mappers/product.mapper';
import { SlugService } from './SlugService';

export interface CreateProductInput {
  vendorId: string;
  type: 'physical' | 'digital' | 'service';
  title: string;
}

/**
 * ProductDraftService: Create new products in DRAFT state
 */
export class ProductDraftService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly slugService: SlugService
  ) { }

  /**
   * Create a new product in DRAFT state
   * @param input - Product creation input
   * @returns Created product domain entity
   */
  async execute(input: CreateProductInput): Promise<Product> {
    // Input validation
    const trimmedTitle = input.title.trim();

    if (!trimmedTitle) {
      throw new ValidationError('Product title cannot be empty');
    }

    if (trimmedTitle.length < 3) {
      throw new ValidationError('Product title must be at least 3 characters long');
    }

    // Generate unique slug
    const slug = await this.slugService.generate(trimmedTitle, input.vendorId);

    // Create product in DRAFT state
    const productData: Omit<Product, 'id' | 'createdAt' | 'updatedAt'> = {
      vendorId: input.vendorId,
      type: input.type,
      status: 'draft',
      title: trimmedTitle,
      description: '',
      slug,
      seo: {},
      hasVariants: false,
      deletedAt: null,
      fileIds: [],
    };

    return this.productRepository.create(productData);
  }
}
