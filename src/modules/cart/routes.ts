import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { CartController } from './controllers/cart.controller';

/**
 * Customer Cart Routes
 *
 * Path: /api/customer/cart
 */
const router = Router();

router.use(requireAuth);
router.use(requireRole(['customer']));

router.get('/', CartController.getCart);

/** Add a variant, or INCREMENT it if already present. */
router.post('/items', CartController.addItem);

/**
 * Hand an anonymous (localStorage) cart over, once, at sign-in.
 *
 * Declared before the `/items/...` routes only for readability — the paths do not overlap.
 * Note this router is `requireRole(['customer'])`, so the *anonymous* half of the handover
 * necessarily happens on the client: the visitor signs in first, then posts what they had.
 */
router.post('/merge', CartController.mergeCart);

/**
 * What this cart will cost. A POST rather than a GET because it takes a body
 * (`deliveryAddressId`) and because a quote is a computation, not a resource — caching it
 * would be actively wrong.
 */
router.post('/quote', CartController.quoteCart);

/** Set a line's quantity to an absolute value — the stepper. */
router.patch('/items/:variantId', CartController.setItemQuantity);

/**
 * ⚠️ Two deletes, two different keys, two different paths — on purpose.
 *
 * `/items/variant/:variantId` removes ONE line. `/items/:productId` removes EVERY variant
 * of a product, which is what it has always done and what its documented contract says.
 *
 * The variant form is nested under a literal segment rather than sharing `/items/:id`
 * because a single path taking either kind of id cannot tell them apart: a client sending
 * a productId where a variantId was meant would silently wipe every size of a T-shirt
 * instead of getting an error. The literal also has to be declared FIRST, or
 * `/items/:productId` matches `/items/variant` and treats the word "variant" as an id.
 */
router.delete('/items/variant/:variantId', CartController.removeVariant);
router.delete('/items/:productId', CartController.removeItem);

router.delete('/', CartController.clearCart);

export default router;
