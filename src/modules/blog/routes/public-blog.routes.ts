import { Router } from 'express';
import { PublicArticleController } from '../controllers/public-article.controller';

/**
 * Public blog routes — published articles, readable without a session.
 * Mounted at `/api/public` → `/public/articles`, `/public/articles/index`,
 * `/public/articles/:slug`.
 *
 * ⚠️ There is **no `requireAuth`** on this router, the same as `public-billing.routes.ts`.
 * Every handler mounted here must be a read of data that is already published on a
 * marketing page. Nothing owner-scoped, nothing that reads `req.auth`, nothing that writes.
 * The editor's endpoints live on `/api/admin/articles` behind `requireRole(['admin'])`, and
 * a preview belongs there — never here behind a flag.
 */
const router = Router();

/** Summaries for one locale. `?locale=` is required; `?category=`, `?limit=`, `?offset=`. */
router.get('/articles', PublicArticleController.list);

/**
 * ⚠️ **Before `/articles/:slug`.** Express matches in declaration order, so reversing these
 * two lines makes `/articles/index` resolve as an article slugged "index" and the build's
 * route enumeration 404s. `index` is a reserved slug for the same reason, which means the
 * ordering and the reservation each cover the other's failure.
 */
router.get('/articles/index', PublicArticleController.index);

/** One article with its body. `?locale=` is required — the pair is the key. */
router.get('/articles/:slug', PublicArticleController.getBySlug);

export default router;
