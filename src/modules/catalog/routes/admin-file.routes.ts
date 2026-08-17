import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { getStorageProvider } from '../../../core/storage';
import { resolveFileDetails } from '../read-models/file-detail.resolver';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';

/**
 * File resolution — the one thing wi-admin cannot do for itself.
 *
 * ── The gap this closes ───────────────────────────────────────────────────────
 * Every wi-admin DTO that references a file ships a bare id: `logoFileId`,
 * `avatarFileId`, `bannerFileId`, `deliveryProofFileId`, `store.logoFileId`. Its own
 * contract states the reason — "this service resolves no file URLs" (ADR-009 D-6) —
 * and tells the dashboard to resolve them "against jovi-mall". But the dashboard
 * talks to wi-admin and to nothing else, by design, so that instruction pointed at a
 * door nobody could open. Every avatar and logo on the admin surface renders as a
 * placeholder as a result (the dashboard's gap **D2**).
 *
 * ── Why the fix belongs here and not there ───────────────────────────────────
 * A URL is `storage.getPublicUrl(key)`, and which provider that is comes from
 * `STORAGE_PROVIDER`. Teaching wi-admin to build one means a second copy of the
 * storage configuration in a second deployment, which is the drift the service split
 * exists to prevent. So the resolution stays where the provider is, and wi-admin
 * delegates. D-6 is upheld rather than reversed.
 *
 * ── Batch only, and bounded ──────────────────────────────────────────────────
 * A detail screen resolves one file; a roster resolves twenty. One shape serves both,
 * because a per-id route would make the second case twenty HTTP hops in front of one
 * `find({_id: {$in: […]}})`. The cap matches wi-admin's own page ceiling, so a caller
 * can always resolve a full page in one call and can never ask for more than a page.
 *
 * ⚠ **This returns metadata and a public URL. It performs no ownership check**, and
 * must not grow one — the caller is an authenticated administrator who already holds
 * the record carrying the id, and a file id is a 24-hex value nobody can guess. What
 * it must never become is a *listing*: `POST` with an explicit id set, never a
 * `GET /files` that enumerates.
 */

const ResolveFilesSchema = z.object({
    fileIds: z
        .array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Each id must be a 24-character hex string'))
        .min(1, 'At least one file id is required')
        .max(100, 'At most 100 file ids may be resolved at once'),
});

const fileRepository = new FileRepositoryMongo();

function attachRoutes(router: Router): Router {
    /**
     * POST /resolve — body `{ fileIds: string[] }` (1..100).
     *
     * Answers `{ files: FileDetail[] }`. **Ids that resolve to nothing are simply
     * absent** rather than present-and-null: a file may have been swept by
     * file-cleanup or soft-deleted, and the caller's job is to render what exists.
     * A caller needing to tell "missing" from "never asked" has its own request to
     * compare against.
     *
     * `POST` rather than `GET` because a hundred 24-hex ids is 2.4 KB of query string,
     * which is inside every limit but reliably unreadable in a log line. The operation
     * is a read and is not audited (ADR-006 D-5).
     */
    router.post(
        '/resolve',
        asyncHandler(async (req, res) => {
            const { fileIds } = ResolveFilesSchema.parse(req.body);
            const resolved = await resolveFileDetails(fileIds, fileRepository, getStorageProvider());

            sendSuccess(res, { files: [...resolved.values()] });
        }),
    );

    return router;
}

/** Build the file-resolution surface behind an arbitrary guard chain. */
export function buildAdminFileRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
