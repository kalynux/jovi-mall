import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { publicArticleService } from '../services/public-article.service';
import {
  PublicArticleDetailQuerySchema,
  PublicArticleListQuerySchema,
  PublicArticleSlugParamSchema,
} from '../validators/article.validator';

/**
 * Unauthenticated reads of published articles — the marketing site's blog.
 *
 * Read-only, no side effects, no identity. Everything served here is prose written to be
 * published; nothing owner-scoped is reachable from this controller and it must stay that
 * way — see `public-blog.routes.ts`.
 */

/**
 * Matches the plan catalog's convention, and the number is the same for the same reason:
 * five minutes is the window in which a newly published article is invisible to the site.
 *
 * **That is not instant, and must not be described to an editor as instant** — the reader
 * waits this window *plus* whatever the page's own `revalidate` adds.
 */
const PUBLIC_CACHE_SECONDS = 300;

function cacheable(res: Response): Response {
  return res.set('Cache-Control', `public, max-age=${PUBLIC_CACHE_SECONDS}`);
}

export class PublicArticleController {
  /**
   * GET /api/public/articles?locale=…[&category=…][&limit=…][&offset=…]
   *
   * Summaries for one locale — the index and the category hubs. `publishedAt` descending.
   * Returns `{ items, total }` rather than the usual `meta` page envelope: `total` with
   * `limit`/`offset` is what path-based pagination (`/blog/page/2`) needs.
   */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = PublicArticleListQuerySchema.parse(req.query);
    const result = await publicArticleService.list(query);
    cacheable(res).json({ success: true, data: result });
  });

  /**
   * GET /api/public/articles/index
   *
   * Every `(locale, slug)` pair plus dates, for `generateStaticParams` and the sitemap.
   *
   * ⚠️ Registered **before** `/:slug` — Express matches in declaration order, and reversed
   * it would be swallowed by the slug route. `index` is also a reserved slug, so no article
   * can be published at the address this shadows either way.
   */
  static index = asyncHandler(async (_req: Request, res: Response) => {
    const rows = await publicArticleService.index();
    cacheable(res).json({ success: true, data: rows });
  });

  /**
   * GET /api/public/articles/{slug}?locale=…
   *
   * One article with its body. The pair `(locale, slug)` is the key; a slug that exists in
   * another language is a 404 here, deliberately — see the service.
   */
  static getBySlug = asyncHandler(async (req: Request, res: Response) => {
    const { slug } = PublicArticleSlugParamSchema.parse(req.params);
    const { locale } = PublicArticleDetailQuerySchema.parse(req.query);
    const article = await publicArticleService.getBySlug(slug, locale);
    cacheable(res).json({ success: true, data: article });
  });
}
