import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { VendorCategoryController } from '../controllers/category.controller';

/**
 * `/api/vendor/categories` — picking categories for a product.
 *
 * There is deliberately no create route: a vendor creates a category by naming it on
 * a product write, which is the only place the duplicate check can ask its question
 * in context. A bare "create category" button would let a vendor seed the shared
 * list with names no product uses.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole(['vendor']));

router.get('/', VendorCategoryController.list);
router.post('/check', VendorCategoryController.check);

export default router;
