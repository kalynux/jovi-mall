import { z } from 'zod';
import { APP_KEYS } from '../app-distribution.types';

/**
 * The `:app` path segment.
 *
 * ⚠ An ENUM, not a string — and on an unauthenticated route that is the difference between a
 * closed surface and a probe. `storageKey` is derived from nothing the caller sends, so a free
 * string could not reach the filesystem even so; the enum is what keeps the query count at
 * zero for a caller trying names, and what makes "unknown app" a decision the router takes
 * rather than an empty result Mongo returns.
 */
export const AppKeyParamSchema = z.object({
    app: z.enum(APP_KEYS),
});

export type AppKeyParam = z.infer<typeof AppKeyParamSchema>;
