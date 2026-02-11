import { NotFoundError, ForbiddenError, ValidationError } from '../../../../../core/errors';
import { IProductRepository } from '../../../repositories/interfaces/product.repository.interface';
import { IVariantRepository } from '../../../repositories/interfaces/variant.repository.interface';

export interface ResolvePriceCommand {
  productId: string;
  variantId: string;
  vendorId: string;
  quantity: number;
}

export interface ResolvedPrice {
  unitPrice: number;
  compareAtPrice?: number;
  total: number;
  discount?: number;
}

/**
 * PriceResolverService: Compute final payable price with deterministic logic
 * 
 * Business Rules:
 * - Product must be ACTIVE
 * - Variant must be ACTIVE
 * - Quantity >= 1
 * - For service products: quantity must = 1
 * - unitPrice from variant.price
 * - If compareAtPrice > price → calculate discount
 * - total = unitPrice × quantity
 * - Never return negative prices
 * - EXPLICIT vendor ownership check via product
 */
export class PriceResolverService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository
  ) {}

  async execute(command: ResolvePriceCommand): Promise<ResolvedPrice> {
    // 1. VENDOR OWNERSHIP CHECK: Load product and validate vendor
    const product = await this.productRepository.findById(command.productId, command.vendorId);
    
    if (!product) {
      throw new NotFoundError('Product not found');
    }

    if (product.vendorId !== command.vendorId) {
      throw new ForbiddenError('You do not have permission to access this product');
    }

    // 2. Validate product status
    if (product.status !== 'active') {
      throw new ForbiddenError(`Cannot resolve price for ${product.status.toUpperCase()} product`);
    }

    // 3. Load and validate variant
    const variant = await this.variantRepository.findById(command.variantId);
    
    if (!variant) {
      throw new NotFoundError('Variant not found');
    }

    if (variant.productId !== command.productId) {
      throw new ForbiddenError('Variant does not belong to this product');
    }

    if (variant.status !== 'active') {
      throw new ForbiddenError('Cannot resolve price for archived variant');
    }

    // 4. Validate quantity
    if (command.quantity < 1) {
      throw new ValidationError('Quantity must be at least 1');
    }

    // For service products, quantity must be 1
    if (product.type === 'service' && command.quantity !== 1) {
      throw new ValidationError('Service products must have quantity of 1');
    }

    // 5. Calculate price
    const unitPrice = variant.price;
    
    if (unitPrice < 0) {
      throw new ValidationError('Price cannot be negative');
    }

    const total = unitPrice * command.quantity;

    // 6. Calculate discount if compare-at price exists
    let discount: number | undefined;
    if (variant.compareAtPrice && variant.compareAtPrice > unitPrice) {
      discount = variant.compareAtPrice - unitPrice;
    }

    return {
      unitPrice,
      compareAtPrice: variant.compareAtPrice,
      total,
      discount,
    };
  }
}
