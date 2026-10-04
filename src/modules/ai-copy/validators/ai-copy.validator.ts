import { z } from 'zod';
import { AI_COPY_FIELDS, AI_COPY_LANGUAGES } from '../ai-copy.types';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

export const AI_COPY_TITLE_MAX = 200;
export const AI_COPY_NOTES_MAX = 500;
export const AI_COPY_MAX_IMAGES = 4;

/** Regenerate's `previous` is the vendor's own last answer, echoed back. Bounded so it cannot carry a payload. */
const PREVIOUS_MAX_JSON = 12_000;

/**
 * `POST /api/vendor/ai/listing-copy`.
 *
 * `.strict()` on purpose: there is no prompt field and there must never be one. A request
 * that tries to send instructions is refused rather than silently ignored, so a client that
 * thinks it is steering the model finds out at once.
 */
export const AiCopyRequestSchema = z
  .object({
    target: z.enum(['product', 'service']),
    productType: z.enum(['physical', 'digital']).optional(),
    listingId: objectId.optional(),
    language: z.enum(AI_COPY_LANGUAGES),
    fields: z
      .array(z.enum(AI_COPY_FIELDS))
      .min(1, 'Ask for at least one field')
      .max(AI_COPY_FIELDS.length)
      .refine((f) => new Set(f).size === f.length, 'Each field may be asked for once'),
    input: z
      .object({
        title: z.string().trim().min(1, 'A name is required').max(AI_COPY_TITLE_MAX),
        categories: z
          .array(
            z
              .object({
                id: objectId.optional(),
                name: z.string().trim().min(1).max(200),
              })
              .strict(),
          )
          .max(5)
          .default([]),
        notes: z.string().trim().max(AI_COPY_NOTES_MAX).optional(),
        imageFileIds: z
          .array(objectId)
          .min(1, 'Pick at least one photo')
          .max(AI_COPY_MAX_IMAGES, `At most ${AI_COPY_MAX_IMAGES} photos`)
          .refine((ids) => new Set(ids).size === ids.length, 'A photo may be picked once'),
      })
      .strict(),
    previous: z
      .record(z.unknown())
      .optional()
      .refine((p) => p === undefined || JSON.stringify(p).length <= PREVIOUS_MAX_JSON, 'previous is too large'),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.target === 'product' && !body.productType) {
      ctx.addIssue({ code: 'custom', path: ['productType'], message: 'Required for a product' });
    }
    if (body.target === 'service' && body.productType) {
      ctx.addIssue({ code: 'custom', path: ['productType'], message: 'A service has no product type' });
    }
    // The dashboard hides the choice once a category is set; a client that sends it anyway
    // would pay for a suggestion the editor will not offer.
    if (body.fields.includes('categories') && body.input.categories.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'categories can be asked for only when the listing has none yet',
      });
    }
    if (body.previous) {
      for (const key of Object.keys(body.previous)) {
        if (!(body.fields as string[]).includes(key)) {
          ctx.addIssue({ code: 'custom', path: ['previous', key], message: 'Not one of the requested fields' });
        }
      }
    }
  });

export type AiCopyRequest = z.infer<typeof AiCopyRequestSchema>;
