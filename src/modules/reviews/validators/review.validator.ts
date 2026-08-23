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
 * `title` and `body` are optional, and whether they are present decides where the
 * review lands — a bare star publishes, prose is held for a moderator
 * (`initialStatusOf`). That is a domain rule and deliberately not expressed here: a
 * schema cannot say "this field changes the workflow".
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

/** "My reviews". Every status by default — an author must be able to see a held row. */
export const MyReviewsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['pending', 'published', 'rejected']).optional(),
  })
  .strict();

/** The storefront's list. No status filter — published is the only thing it can see. */
export const PublicReviewQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

/**
 * The moderation queue. Defaults to `pending` at the repository, not here — a query
 * schema stating the queue's default would put it in two places.
 */
export const ModerationQueueQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['pending', 'published', 'rejected']).optional(),
    subjectType: z.enum(['product', 'delivery']).optional(),
    authorRole: z.enum(['customer', 'vendor', 'agency']).optional(),
  })
  .strict();

/**
 * `POST /:id/reject` — the reason is REQUIRED, unlike the optional reasons elsewhere
 * in this codebase.
 *
 * A rejection is the moderator's own judgement rather than a rule the platform
 * applied, and it is never shown to the author, so the only reader it will ever have
 * is the next moderator looking at the same account. A blank one makes the record
 * worthless at exactly the moment somebody needs it. Same position
 * `AdminRejectAgencyKycSchema` takes.
 */
export const RejectReviewSchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const ReviewIdParamSchema = z.object({ id: objectId });

export const ProductIdParamSchema = z.object({ productId: objectId });
