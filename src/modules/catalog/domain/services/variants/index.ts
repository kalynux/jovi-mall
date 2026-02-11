/**
 * Variant Matrix Engine - Domain Services
 * 
 * The SKU brain of the product system with Shopify-grade variant generation:
 * - Deterministic variant generation from option matrix
 * - Cartesian explosion protection (MAX_VARIANTS_PER_PRODUCT)
 * - Safe reconciliation (archive, never delete)
 * - Vendor ownership enforced
 * - Transaction-safe operations
 */

// Constants
export { MAX_VARIANTS_PER_PRODUCT, MAX_OPTIONS_PER_PRODUCT, DEFAULT_VARIANT_SIGNATURE } from './constants';

// Utilities
export { generateOptionSignature, generateSKU, cartesianProduct, calculateCartesianProductCount } from './utils';

// Services
export { OptionService, CreateOptionCommand, AddOptionValuesCommand, DeleteOptionCommand } from './OptionService';

export { VariantGeneratorService, GenerateVariantsCommand } from './VariantGeneratorService';

export { 
  VariantRegenerationService, 
  RegenerateVariantsCommand,
  RegenerationResult 
} from './VariantRegenerationService';

export { 
  VariantPricingService, 
  SetVariantPriceCommand,
  BulkSetPricesCommand 
} from './VariantPricingService';

export { 
  VariantStockService, 
  SetStockCommand,
  AdjustStockCommand 
} from './VariantStockService';

export { DefaultVariantService, EnsureDefaultVariantCommand } from './DefaultVariantService';
