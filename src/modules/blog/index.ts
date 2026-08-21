/**
 * Blog / editorial — the marketing site's article pages.
 *
 * **This is the public READER and the data model. The editor is not here.**
 *
 * It was until Phase 5 Part A, when article and byline writes moved to wi-admin outright
 * (ADR-004 D-4): `/api/v1/content` there is the editor, and it writes this database
 * directly. `/api/admin/articles` and `/api/admin/article-authors` no longer exist.
 *
 * ── What that leaves here, and why each piece stayed ──────────────────────────
 * - **The models.** `articles` and `article_authors` keep their Mongoose schemas and
 *   **their indexes** in this repository, because the public reader needs the schema and
 *   because `autoIndex` is off in production, so the indexes come from this service's
 *   migration ledger. wi-admin owns the writes to a collection this repo declares — a real
 *   split, and the one thing to check before adding a field to either side.
 * - **The read half of both repositories.** The write methods went with the services.
 * - **`ArticleBodySchema`.** wi-admin is the authority on the block union now, since it is
 *   the only writer. The copy here is what the public DTO's `ArticleBody` type comes from,
 *   and `test:blog` asserts it reaches the same verdict as wi-admin's on a shared fixture
 *   list — neither repo imports the other, and both go red when they disagree.
 *
 * Consume the module through this barrel — **except routes**, which `api/index.ts` imports
 * directly from `routes/*`, matching how the agent domain does it: routers depend on
 * `auth.middleware`, and re-exporting them here is the shape that closes a require cycle.
 */
export * from './blog.types';
export * from './models/article.model';
export * from './models/article-author.model';
export * from './validators/article-body.validator';
export { articleRepository, ArticleRepository } from './repositories/article.repository';
export {
  articleAuthorRepository,
  ArticleAuthorRepository,
} from './repositories/article-author.repository';
export { publicArticleService, PublicArticleService } from './services/public-article.service';
export * from './dto/public-article.dto';
