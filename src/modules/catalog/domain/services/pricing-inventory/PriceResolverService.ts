import { createAppError } from '../../../../../core/errors';
import { ERROR_CODES } from '../../../../../core/error-codes';
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
 */
export class PriceResolverService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly variantRepository: IVariantRepository
  ) { }

  async execute(command: ResolvePriceCommand): Promise<ResolvedPrice> {
    const product = await this.productRepository.findById(command.productId, command.vendorId);

    if (!product) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    if (product.vendorId !== command.vendorId) throw createAppError(ERROR_CODES.CATALOG_PRODUCT_ACCESS_DENIED, 403);
    if (product.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_PRODUCT_INVALID_STATE, 422, undefined, { status: product.status });

    const variant = await this.variantRepository.findById(command.variantId);

    if (!variant) throw createAppError(ERROR_CODES.CATALOG_VARIANT_NOT_FOUND, 404);
    if (variant.productId !== command.productId) throw createAppError(ERROR_CODES.CATALOG_VARIANT_ACCESS_DENIED, 403);
    if (variant.status !== 'active') throw createAppError(ERROR_CODES.CATALOG_VARIANT_ARCHIVED, 422);

    if (command.quantity < 1) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY, 400, 'Quantity must be at least 1');

    if (product.type === 'service' && command.quantity !== 1) {
      throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_QUANTITY, 400, 'Service products must have quantity of 1');
    }

    const unitPrice = variant.price;

    if (unitPrice < 0) throw createAppError(ERROR_CODES.CATALOG_VARIANT_INVALID_PRICE, 400, 'Price cannot be negative');

    const total = unitPrice * command.quantity;

    let discount: number | undefined;
    if (variant.compareAtPrice && variant.compareAtPrice > unitPrice) {
      discount = variant.compareAtPrice - unitPrice;
    }

    return { unitPrice, compareAtPrice: variant.compareAtPrice, total, discount };
  }
}
