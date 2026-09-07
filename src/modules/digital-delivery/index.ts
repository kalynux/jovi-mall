/**
 * Digital Delivery Module
 * 
 * Secure, Shopify-grade digital product fulfillment system.
 * 
 * CORE GUARANTEES:
 * - Idempotent entitlement granting (webhook-safe via unique index)
 * - Atomic single-use tokens (Lua read-and-delete; see DownloadTokenHelper)
 * - Mathematically impossible to exceed download limits (conditional atomic updates)
 * - No public file access (all downloads through backend validation)
 */

// Models
export * from './models/digital-asset.model';
// export * from './models/digital-product-config.model';
export * from './models/customer-digital-entitlement.model';
export * from './models/download-token.model';

// Services
export * from './services/digital-asset.service';
export * from './services/digital-entitlement.service';
export * from './services/download-link.service';
export * from './services/download-execution.service';

// Routes
export * from './routes/customer.routes';
// Vendor digital-asset management is NOT here — it is per-variant in the catalog module, at
// /api/vendor/products/:productId/variants/:variantId/digital/* (vendor-digital-asset.controller.ts).
// The old `vendor.routes.ts` factory that used to sit beside this line was deleted 2026-08-19.

// Types
export * from './types';
