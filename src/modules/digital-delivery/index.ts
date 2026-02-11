/**
 * Digital Delivery Module
 * 
 * Secure, Shopify-grade digital product fulfillment system.
 * 
 * CORE GUARANTEES:
 * - Idempotent entitlement granting (webhook-safe via unique index)
 * - Atomic single-use tokens (Redis GETDEL)
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
export * from './routes/vendor.routes';

// Types
export * from './types';
