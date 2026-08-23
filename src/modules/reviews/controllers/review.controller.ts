import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { ReviewAuthorRole } from '../models/review.model';
import { ReviewAuthor } from '../domain/services/review-eligibility.service';
import { reviewService } from '../services/review.service';
import { toAuthorReviewDto } from '../dto/review.dto';
import {
  MyReviewsQuerySchema,
  ReviewEligibilityQuerySchema,
  SubmitReviewSchema,
} from '../validators/review.validator';

/**
 * The authoring surface, from one factory, for all three author roles.
 *
 * The three routers are an endpoint-for-endpoint mirror and the service is symmetric,
 * so the only thing that differs is which role the caller is — and that comes from the
 * mount, never from the request. Writing it three times would be three places for the
 * eligibility rules to be read differently.
 *
 * ⚠ **Both identities are taken from the token.** `userId` is the `users` row (what a
 * review is authored by, and what "one review per subject" is keyed on) and
 * `roleEntityId` is the role document (what ownership of an order or a shipment is
 * checked against). They are different collections and are never interchangeable —
 * passing the role entity as the author would let somebody holding two roles review
 * one delivery twice.
 */
const authorOf = (role: ReviewAuthorRole) => (req: Request): ReviewAuthor => ({
  userId: req.auth!.user._id.toString(),
  role,
  roleEntityId: req.auth!.role_entity._id.toString(),
});

export function buildReviewController(role: ReviewAuthorRole) {
  const author = authorOf(role);

  return {
    /** POST / — submit. 201, and the body says whether it published or is held. */
    create: asyncHandler(async (req: Request, res: Response) => {
      const input = SubmitReviewSchema.parse(req.body);
      const review = await reviewService.submit(author(req), input);
      res.status(201).json({ success: true, data: toAuthorReviewDto(review) });
    }),

    /**
     * GET /eligibility?subjectType=&subjectId= — may I write one?
     *
     * A 200 with `eligible: false` rather than the refusal the write path would
     * raise: this is a question, and the answer "no, and here is the code why" is a
     * successful answer to it. The `reason` is the same error code the write would
     * have thrown, so a client can reuse one copy table for both.
     */
    eligibility: asyncHandler(async (req: Request, res: Response) => {
      const query = ReviewEligibilityQuerySchema.parse(req.query);
      const verdict = await reviewService.checkEligibility(author(req), query.subjectType, query.subjectId);
      res.json({ success: true, data: verdict });
    }),

    /** GET / — this author's own reviews, every status. */
    list: asyncHandler(async (req: Request, res: Response) => {
      const query = MyReviewsQuerySchema.parse(req.query);
      const page = await reviewService.listMine(author(req), query.page, query.limit, query.status);
      res.json({
        success: true,
        data: page.data.map(toAuthorReviewDto),
        // `pages` at the repository layer, `totalPages` on the wire — the existing
        // convention across the connection, contract and stock-request lists.
        meta: {
          total: page.meta.total,
          page: page.meta.page,
          limit: page.meta.limit,
          totalPages: page.meta.pages,
        },
      });
    }),
  };
}
