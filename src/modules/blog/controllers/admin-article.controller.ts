import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { articleService } from '../services/article.service';
import { articleAuthorService } from '../services/article-author.service';
import {
  AdminArticleQuerySchema,
  ArticleKeyParamSchema,
  AuthorKeyParamSchema,
  CreateArticleSchema,
  CreateAuthorSchema,
  PublicArticleDetailQuerySchema,
  PublishArticleSchema,
  UpdateArticleSchema,
  UpdateAuthorSchema,
} from '../validators/article.validator';

/** The editor. Everything here is behind `requireAuth + requireRole(['admin'])`. */
export class AdminArticleController {
  /** GET /api/admin/articles — every status by default; a draft inbox is the point. */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const query = AdminArticleQuerySchema.parse(req.query);
    const page = await articleService.list(query);
    res.json({
      success: true,
      data: page.data,
      // `pages` at the repository layer, `totalPages` on the wire — the existing convention.
      meta: {
        total: page.meta.total,
        page: page.meta.page,
        limit: page.meta.limit,
        totalPages: page.meta.pages,
      },
    });
  });

  /** POST /api/admin/articles — always lands as a draft. */
  static create = asyncHandler(async (req: Request, res: Response) => {
    const input = CreateArticleSchema.parse(req.body);
    const article = await articleService.create(input);
    res.status(201).json({ success: true, data: article });
  });

  /** GET /api/admin/articles/:id */
  static getById = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ArticleKeyParamSchema.parse(req.params);
    res.json({ success: true, data: await articleService.getByKey(id) });
  });

  /**
   * GET /api/admin/articles/:id/preview?locale=…
   *
   * The public detail shape, at any status. Exists so previewing never becomes a reason to
   * return drafts from the public endpoints.
   */
  static preview = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ArticleKeyParamSchema.parse(req.params);
    const { locale } = PublicArticleDetailQuerySchema.parse(req.query);
    res.json({ success: true, data: await articleService.preview(id, locale) });
  });

  /** PATCH /api/admin/articles/:id — `translations` is a full-array replace. */
  static update = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ArticleKeyParamSchema.parse(req.params);
    const input = UpdateArticleSchema.parse(req.body);
    res.json({ success: true, data: await articleService.update(id, input) });
  });

  /** POST /api/admin/articles/:id/publish */
  static publish = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ArticleKeyParamSchema.parse(req.params);
    const input = PublishArticleSchema.parse(req.body ?? {});
    res.json({ success: true, data: await articleService.publish(id, input) });
  });

  /** POST /api/admin/articles/:id/unpublish — back to draft, for a correction. */
  static unpublish = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ArticleKeyParamSchema.parse(req.params);
    res.json({ success: true, data: await articleService.unpublish(id) });
  });

  /** POST /api/admin/articles/:id/archive — retire for good; the URL answers 410. */
  static archive = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ArticleKeyParamSchema.parse(req.params);
    res.json({ success: true, data: await articleService.archive(id) });
  });

  /** DELETE /api/admin/articles/:id — only an article that was never published. */
  static remove = asyncHandler(async (req: Request, res: Response) => {
    const { id } = ArticleKeyParamSchema.parse(req.params);
    await articleService.remove(id);
    res.json({ success: true, data: { id, deleted: true } });
  });
}

/** Bylines, same guard. */
export class AdminArticleAuthorController {
  static list = asyncHandler(async (_req: Request, res: Response) => {
    res.json({ success: true, data: await articleAuthorService.list() });
  });

  static create = asyncHandler(async (req: Request, res: Response) => {
    const input = CreateAuthorSchema.parse(req.body);
    res.status(201).json({ success: true, data: await articleAuthorService.create(input) });
  });

  static getById = asyncHandler(async (req: Request, res: Response) => {
    const { id } = AuthorKeyParamSchema.parse(req.params);
    res.json({ success: true, data: await articleAuthorService.getByKey(id) });
  });

  static update = asyncHandler(async (req: Request, res: Response) => {
    const { id } = AuthorKeyParamSchema.parse(req.params);
    const input = UpdateAuthorSchema.parse(req.body);
    res.json({ success: true, data: await articleAuthorService.update(id, input) });
  });

  /** Refused while any article credits this byline. */
  static remove = asyncHandler(async (req: Request, res: Response) => {
    const { id } = AuthorKeyParamSchema.parse(req.params);
    await articleAuthorService.remove(id);
    res.json({ success: true, data: { id, deleted: true } });
  });
}
