/**
 * Blog / editorial — the marketing site's article pages.
 *
 * Two halves that never touch: a **public** reader (`/api/public/articles`, no auth, five
 * -minute cache) and an **editor** (`/api/admin/articles`, admin-only). The public half
 * serves published articles and nothing else; a preview lives on the admin side rather
 * than as a flag on a public endpoint.
 *
 * Consume the module through this barrel — **except routes**, which `api/index.ts` imports
 * directly from `routes/*`, matching how the agent domain does it: routers depend on
 * `auth.middleware`, and re-exporting them here is the shape that closes a require cycle.
 */
export * from './blog.types';
export * from './models/article.model';
export * from './models/article-author.model';
export * from './validators/article-body.validator';
export * from './domain/article-content.rules';
export { articleRepository, ArticleRepository } from './repositories/article.repository';
export {
  articleAuthorRepository,
  ArticleAuthorRepository,
} from './repositories/article-author.repository';
export { articleService, ArticleService } from './services/article.service';
export { articleAuthorService, ArticleAuthorService } from './services/article-author.service';
export { publicArticleService, PublicArticleService } from './services/public-article.service';
export * from './dto/public-article.dto';
export * from './dto/admin-article.dto';
