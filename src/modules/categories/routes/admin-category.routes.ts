import { RequestHandler, Router } from 'express';
import { AdminCategoryController } from '../controllers/category.controller';

/**
 * Category administration — the write surface wi-admin delegates to
 * (`/api/internal/admin/categories`). Mounted ONCE, internal only, like every admin
 * router since the Phase 5 cutover: do not add a public `/api/admin/*` mount.
 */
function attachRoutes(router: Router): Router {
    router.patch('/:id', AdminCategoryController.rename);
    router.post('/:id/merge', AdminCategoryController.merge);
    router.delete('/:id', AdminCategoryController.remove);
    return router;
}

/** Build the category admin surface behind an arbitrary guard chain. */
export function buildAdminCategoryRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
