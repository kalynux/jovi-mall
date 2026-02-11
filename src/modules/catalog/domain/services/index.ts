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
export { ProductPublishService, VendorContext } from './ProductPublishService';
export { ProductArchiveService } from './ProductArchiveService';
export { ProductDeleteService } from './ProductDeleteService';
export { ProductRestoreService } from './ProductRestoreService';
