import { Router } from 'express';

/**
 * DEPRECATED — superseded by per-variant digital-asset endpoints under
 * /api/vendor/products/:productId/variants/:variantId/digital/*
 * (see vendor-products.routes.ts and vendor-digital-asset.controller.ts).
 *
 * This file is no longer mounted. Kept as a placeholder so historical imports
 * do not silently fail; remove when no external references remain.
 */
const router = Router();

export default router;
