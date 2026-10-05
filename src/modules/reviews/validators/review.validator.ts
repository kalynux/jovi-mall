import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid MongoDB ObjectId');

/**
 * Submit a review. Symmetric across roles — the object is the same whoever writes it,
 * and only *what they may write it about* differs, which is the eligibility service's
 * job rather than a schema's.
 *
 * `rating` is an integer 1–5 and there is no half-star: the trust composite reads
 * these as a 1–5 average and a histogram renders five bars. Adding halves later is a
 * schema change and a migration, and nothing has asked for one.
 *
 * `title` and `body` are optional. Since 2026-10-05 they change nothing about where the
 * review lands: every review publishes on submission, prose included, and an
 * administrator can take it down afterwards.
 */
export const SubmitReviewSchema = z
  .object({
    subjectType: z.enum(['product', 'delivery']),
    subjectId: objectId,
    rating: z.number().int().min(1, 'Rating must be between 1 and 5').max(5, 'Rating must be between 1 and 5'),
    title: z.string().trim().min(1).max(120).optional(),
    body: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type SubmitReviewInputDto = z.infer<typeof SubmitReviewSchema>;

/** `GET /eligibility` — the "may I write one?" pre-flight. */
export const ReviewEligibilityQuerySchema = z
  .object({
    subjectType: z.enum(['product', 'delivery']),
    subjectId: objectId,
  })
  .strict();

/** "My reviews". Every status by default — an author sees a review an administrator hid. */
export const MyReviewsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['published', 'unpublished']).optional(),
  })
  .strict();

/** The storefront's list. No status filter — published is the only thing it can see. */
export const PublicReviewQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

/** The administrators' list: every live review, newest first, every status unless filtered. */
export const AdminReviewQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['published', 'unpublished']).optional(),
    subjectType: z.enum(['product', 'delivery']).optional(),
    authorRole: z.enum(['customer', 'vendor', 'agency']).optional(),
  })
  .strict();

/**
 * `POST /:id/unpublish` and `DELETE /:id` — the reason is REQUIRED, unlike the optional
 * reasons elsewhere in this codebase.
 *
 * Taking somebody's review down is the administrator's own judgement rather than a rule
 * the platform applied, and the reason is never shown to the author, so its only reader
 * will be the next administrator looking at the same account. A blank one makes the
 * record worthless at exactly the moment somebody needs it. Same position
 * `AdminRejectAgencyKycSchema` takes.
 */
export const ReviewModerationReasonSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** `POST /:id/republish` — undoing an unpublish needs no justification; one may be given. */
export const RepublishReviewSchema = z
  .object({
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict();

export const ReviewIdParamSchema = z.object({ id: objectId });

export const ProductIdParamSchema = z.object({ productId: objectId });
