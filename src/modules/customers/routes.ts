import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { CustomerProfileController } from './controllers/customer-profile.controller';
import { CustomerCatalogController } from './controllers/customer-catalog.controller';
import { DeviceTokenController } from '../notifications/controllers/device-token.controller';

const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

/** GET /api/customer/profile */
router.get('/profile', CustomerProfileController.getProfile);

/** PATCH /api/customer/profile */
router.patch('/profile', CustomerProfileController.updateProfile);

/** GET /api/customer/profile/completion-status */
router.get('/profile/completion-status', CustomerProfileController.getCompletionStatus);

/** POST /api/customer/addresses */
router.post('/addresses', CustomerProfileController.addAddress);

/** DELETE /api/customer/addresses/:id */
router.delete('/addresses/:id', CustomerProfileController.removeAddress);

/**
 * PATCH /api/customer/addresses/:id/default
 *
 * ⚠️ Declared BEFORE `/addresses/:id`. Express matches in declaration order and these two
 * share a prefix; reversed, `PATCH /addresses/abc/default` would never be reached because
 * the shorter pattern does not match it — but the reverse hazard is real for any future
 * literal added under `/addresses/:id/`, so the ordering is kept explicit.
 */
router.patch('/addresses/:id/default', CustomerProfileController.setDefaultAddress);

/**
 * PATCH /api/customer/addresses/:id — edit a saved address in place.
 *
 * Before this, editing meant delete + re-add, which mints a **new** `_id` while past orders
 * still reference the old one through `deliveryAddressId`. Editing in place is what keeps
 * that reference meaningful.
 */
router.patch('/addresses/:id', CustomerProfileController.updateAddress);

/**
 * Push-notification device registration.
 *
 * `DeviceTokenController` is role-agnostic — it keys on `req.auth.user._id`, not on any role
 * entity — and is already mounted identically for vendor, agency and agent. The customer
 * mount was simply missing, which meant the customer notification catalog's promise of push
 * "to every device the customer has registered" was a promise to nobody: `FcmPushService`
 * resolved tokens by user and always found none.
 *
 * Not to be confused with `/api/agent/device` (singular) — that is an agent's device
 * *capabilities* and location permission, a different concept on an adjacent path.
 */
router.post('/devices', DeviceTokenController.register);
router.delete('/devices', DeviceTokenController.unregister);

/** POST /api/customer/payment-methods */
router.post('/payment-methods', CustomerProfileController.addPaymentMethod);

/** DELETE /api/customer/payment-methods/:id */
router.delete('/payment-methods/:id', CustomerProfileController.removePaymentMethod);

/**
 * ── The customer's own view of the catalogue (Phase 6 · 6.E.1 / 6.E.2) ───────
 *
 * Saved products and recently-viewed products. Both are owner-scoped by construction:
 * every handler reads `req.auth.role_entity._id` and there is no path segment or body
 * field naming a customer, so there is nothing an ownership check could be forgotten on.
 *
 * ⚠ **`/wishlist/saved-among` is declared BEFORE `/wishlist/:productId`.** Express matches
 * in declaration order, and they are both two-segment paths under `/wishlist` — reversed,
 * the literal would be swallowed by the parameter and every call would 400 on the id
 * regex. The same hazard the `/addresses/:id/default` comment above describes; here it is
 * live rather than hypothetical, which is why the ordering is not left to chance.
 *
 * (`saved-among` is a POST and `:productId` a DELETE, so today they could not actually
 * collide — but a GET added on either later would make them, silently, and route order is
 * exactly the kind of thing that looks right and is not.)
 */
router.get('/wishlist', CustomerCatalogController.listWishlist);
router.post('/wishlist', CustomerCatalogController.addWishlistItem);
router.post('/wishlist/saved-among', CustomerCatalogController.savedAmong);
router.delete('/wishlist/:productId', CustomerCatalogController.removeWishlistItem);

router.get('/recently-viewed', CustomerCatalogController.listRecentlyViewed);
router.post('/recently-viewed', CustomerCatalogController.recordView);
router.delete('/recently-viewed', CustomerCatalogController.clearRecentlyViewed);

export default router;
