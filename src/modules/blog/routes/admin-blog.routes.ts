import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import {
  AdminArticleController,
  AdminArticleAuthorController,
} from '../controllers/admin-article.controller';

/**
 * The editor — `/api/admin/articles` and `/api/admin/article-authors`.
 *
 * Two routers rather than one so each keeps its own `:id` namespace; they are exported
 * separately and mounted at their own prefixes in `api/index.ts`.
 */

const articleRouter = Router();
articleRouter.use(requireAuth);
articleRouter.use(requireRole(['admin']));

/** GET /api/admin/articles — every status by default. */
articleRouter.get('/', AdminArticleController.list);

/** POST /api/admin/articles — creates a **draft**; publishing is a separate decision. */
articleRouter.post('/', AdminArticleController.create);

/** GET /api/admin/articles/:id */
articleRouter.get('/:id', AdminArticleController.getById);

/** GET /api/admin/articles/:id/preview?locale=… — the public shape, at any status. */
articleRouter.get('/:id/preview', AdminArticleController.preview);

/** PATCH /api/admin/articles/:id — `translations`, if sent, replaces the whole array. */
articleRouter.patch('/:id', AdminArticleController.update);

/** POST /api/admin/articles/:id/publish — body `{ publishedAt? }` for imports. */
articleRouter.post('/:id/publish', AdminArticleController.publish);

/** POST /api/admin/articles/:id/unpublish — back to draft, for a correction. */
articleRouter.post('/:id/unpublish', AdminArticleController.unpublish);

/** POST /api/admin/articles/:id/archive — retired for good; the URL answers `410 Gone`. */
articleRouter.post('/:id/archive', AdminArticleController.archive);

/** DELETE /api/admin/articles/:id — refused once the article has ever been published. */
articleRouter.delete('/:id', AdminArticleController.remove);

const authorRouter = Router();
authorRouter.use(requireAuth);
authorRouter.use(requireRole(['admin']));

authorRouter.get('/', AdminArticleAuthorController.list);
authorRouter.post('/', AdminArticleAuthorController.create);
authorRouter.get('/:id', AdminArticleAuthorController.getById);
authorRouter.patch('/:id', AdminArticleAuthorController.update);
/** Refused while any article credits this byline. */
authorRouter.delete('/:id', AdminArticleAuthorController.remove);

export { articleRouter as adminArticleRoutes, authorRouter as adminArticleAuthorRoutes };
