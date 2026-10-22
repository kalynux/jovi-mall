import { z } from 'zod';

/**
 * Request schemas for `/api/internal/vectoriser` — the door the n8n
 * `wi-mall-vectoriser` workflow calls back through.
 *
 * Contract: `api-doc/n8n/vectoriser/README.md` § 2–4.
 *
 * ── The validation posture here is deliberately asymmetric ───────────────────
 *
 * The ENVELOPE is strict: a body missing `job_id` or `results` is not a report
 * this service can act on at all, and accepting it would mean guessing.
 *
 * Each RESULT is loose about `status` only. A strict enum there would reject the
 * whole body — every product in it — because of one row the vectoriser labelled
 * with a value we have not seen. One unrecognised outcome should cost one
 * product, not thirty-one. `VectorisationService.applyCallbackReport` records
 * such a row under `unknown` and writes nothing for it, which is the honest
 * answer: we do not know what happened to it.
 */

const ObjectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid product id');

/**
 * Upper bound on one `/payloads` request.
 *
 * `buildPayload` runs on the order of a dozen queries per product, so this is a
 * database-load ceiling rather than a body-size one. The caller is the
 * spreadsheet path, which fetches full payloads for id-only rows; a sheet larger
 * than this has to be split, and being told so is better than a request that
 * quietly saturates the connection pool.
 */
export const PAYLOADS_MAX_IDS = 500;

/** `POST /api/internal/vectoriser/payloads` */
export const VectoriserPayloadsSchema = z.object({
  product_ids: z
    .array(ObjectIdSchema)
    .min(1, 'product_ids must name at least one product')
    .max(PAYLOADS_MAX_IDS, `product_ids may name at most ${PAYLOADS_MAX_IDS} products per request`),
});

/**
 * One product's outcome inside a report.
 *
 * `product_id` is NOT validated as an ObjectId here: a report naming an id this
 * service cannot use is a per-row problem, and rejecting the envelope over it
 * would discard every sibling result. `applyCallbackReport` checks it and files
 * the row under `unknown`.
 */
const VectoriserCallbackResultSchema = z.object({
  product_id: z.string().min(1),
  status: z.string().min(1),
  vectorised_id: z.string().nullish(),
  error: z.string().nullish(),
});

/**
 * `POST /api/internal/vectoriser/callback` — README § 3.
 *
 * `job_id` is coerced: n8n sends it as the string `"833"`, but it originates as
 * a number and a workflow edit could start sending it as one. It is compared
 * against a stored string, so a silent type flip would make every callback match
 * nothing and every product sit at `pending` forever — a failure that reports
 * itself as "all ignored" rather than as an error.
 *
 * `total`, `succeeded` and `failed` are accepted and NOT trusted: this service
 * counts what it actually wrote. They are the vectoriser's own tally, useful in
 * a log line and worthless as a source of truth.
 */
export const VectoriserCallbackSchema = z.object({
  job_id: z.union([z.string().min(1), z.number()]).transform(String),
  finished_at: z.string().optional(),
  total: z.number().optional(),
  succeeded: z.number().optional(),
  failed: z.number().optional(),
  results: z.array(VectoriserCallbackResultSchema),
});

export type VectoriserPayloadsInput = z.infer<typeof VectoriserPayloadsSchema>;
export type VectoriserCallbackInput = z.infer<typeof VectoriserCallbackSchema>;

// ─── `kind` dispatch: service listings (SERVICE-LISTINGS-PLAN L-18, § n8n) ────
//
// The vectoriser now indexes two kinds. A payload entry, a callback row or a `/payloads` body
// carrying `kind: 'listing'` belongs to `listings/domain/services/listing-vectorisation.service`;
// ANYTHING ELSE — including every body the workflow sends today, which carries no `kind` — is a
// product, parsed by the schemas above exactly as before. The product schemas are untouched:
// listing rows are split off BEFORE `VectoriserCallbackSchema` sees the body, and a body with no
// listing row reaches it as the very same object.

export const VECTORISER_LISTING_KIND = 'listing';

/** `POST /api/internal/vectoriser/payloads` with `kind: 'listing'`. */
export const VectoriserListingPayloadsSchema = z.object({
  kind: z.literal(VECTORISER_LISTING_KIND),
  listing_ids: z
    .array(z.string().regex(/^[a-f\d]{24}$/i, 'Must be a valid listing id'))
    .min(1, 'listing_ids must name at least one listing')
    .max(PAYLOADS_MAX_IDS, `listing_ids may name at most ${PAYLOADS_MAX_IDS} listings per request`),
});

/** One listing's outcome inside a callback report. Loose on `status`, like the product row. */
export const VectoriserListingResultSchema = z.object({
  kind: z.literal(VECTORISER_LISTING_KIND),
  listing_id: z.string().min(1),
  status: z.string().min(1),
  vectorised_id: z.string().nullish(),
  error: z.string().nullish(),
});

export const VectoriserListingResultsSchema = z.array(VectoriserListingResultSchema);

/** Whether a `/payloads` body asks for listings. */
export function isListingPayloadsRequest(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { kind?: unknown }).kind === VECTORISER_LISTING_KIND;
}

/**
 * Split a callback body by kind. `listingRows` is empty for every product-only report, and
 * then `productBody` IS the body that came in — the same reference, byte for byte.
 */
export function splitCallbackByKind(body: unknown): { productBody: unknown; listingRows: unknown[] } {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return { productBody: body, listingRows: [] };
  const isListing = (r: unknown) => !!r && typeof r === 'object' && (r as { kind?: unknown }).kind === VECTORISER_LISTING_KIND;
  const listingRows = results.filter(isListing);
  if (listingRows.length === 0) return { productBody: body, listingRows: [] };
  return {
    productBody: { ...(body as Record<string, unknown>), results: results.filter((r) => !isListing(r)) },
    listingRows,
  };
}
