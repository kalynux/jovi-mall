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

// No variant PRICING service here, deliberately. The live price writers are
// `vendor-variant.controller.ts` and the two SimpleProduct services, and every one of them
// resolves the bargain window through `resolveBargainWrite` (`../bargain-price.rule`).
// A dead `VariantPricingService` used to be exported here; it wrote `price` with no
// `bargain.minPrice` sync and was deleted 2026-08-19 (Phase 4, ADR-A05) rather than left as a
// copy-paste source that silently breaks that invariant. Write pricing against
// `resolveBargainWrite` from the start.

export { 
  VariantStockService, 
  SetStockCommand,
  AdjustStockCommand 
} from './VariantStockService';

export { DefaultVariantService, EnsureDefaultVariantCommand } from './DefaultVariantService';
