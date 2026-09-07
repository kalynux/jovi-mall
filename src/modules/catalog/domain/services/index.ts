/**
 * Domain Services - Pure business logic layer
 * 
 * These services contain all product lifecycle business rules and orchestrate
 * repositories and transactions. They are:
 * - Framework-agnostic (no HTTP, no Express/Fastify)
 * - Infrastructure-agnostic (no Mongoose, no MongoDB)
 * - Testable and deterministic
 * - Dependency-injected
 */

export { SlugService } from './SlugService';
export { ProductDraftService, CreateProductInput } from './ProductDraftService';
export { ProductUpdateService, UpdateProductCommand } from './ProductUpdateService';
export { ProductArchiveService } from './ProductArchiveService';
export { ProductDeleteService } from './ProductDeleteService';

/*
 * WHAT WAS HERE: `ProductPublishService` and `ProductRestoreService`, exported from this
 * barrel and instantiated by nothing — verified by census, zero `new` sites anywhere.
 *
 * They were deleted with the plan-quota work (2026-09-06) because both wrote
 * `Product.status` with **no activation gate and no plan-limit check**, which is the one
 * combination this module now has to keep impossible: every live path that takes a catalog
 * slot asks `assertCanAddProduct(s)` first, and a dead service sitting in the barrel is a
 * ready-made way for the next author to add one that does not. `ProductRestoreService`
 * restored a soft-deleted product straight back into the counted set; `ProductPublishService`
 * wrote `active` after checking only the title.
 *
 * Same reasoning, and the same outcome, as `VariantPricingService` (deleted 2026-08-19):
 * a dead service documenting the invariant it would break is a loaded gun, and the warning
 * in its header does not survive a copy-paste.
 *
 * One consequence worth knowing: `ProductPublishService` was the ONLY writer of
 * `pending_review` anywhere, so that status is now unreachable by construction rather than
 * merely by accident. It stays in `ProductStatus`, in the schema enum and in
 * `VENDOR_STATUS_TRANSITIONS` (mapped to `[]`) because those describe what a row MAY hold,
 * and legacy rows may hold it.
 */
