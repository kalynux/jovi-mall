import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { FileManagementController } from '../../../api/controllers/file-management.controller';
import { sendSuccess } from '../../../core/responses';
import { getStorageProvider } from '../../../core/storage';
import { resolveFileDetails } from '../read-models/file-detail.resolver';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';

/**
 * The administrative file surface — resolution, and the two housekeeping routes.
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
 * ── ⚠ `/resolve` resolves and must never enumerate — and `/orphans` IS a listing ──
 * These two sentences sit together on purpose, because the mount now carries both
 * shapes and the distinction between them is the whole reason the first is safe.
 *
 * `POST /resolve` returns metadata and a public URL for an id set the caller already
 * holds. It performs no ownership check and must not grow one: the caller is an
 * authenticated administrator who already holds the record carrying the id, and a file
 * id is a 24-hex value nobody can guess. **That** is what makes it grantable to every
 * wi-admin tier (`files.resolve`). It must stay `POST` with an explicit id set and must
 * never become a `GET /files` that enumerates the collection.
 *
 * `GET /orphans` is the listing, and it is a different thing behind a different
 * permission. It enumerates — by definition, since an orphan is found rather than
 * named — so it is tier-1-only in wi-admin (`files.orphans.read`) and it exists solely
 * to let an operator judge a file before the unrecoverable delete below it. wi-admin
 * withholds the storage `key` from its own projection (Phase 5 D-10); this route is the
 * unfiltered internal form and answers the whole `File`.
 *
 * The rule the header used to state as "no listing here, ever" is therefore sharper,
 * not weaker: **a listing on this mount needs its own permission and its own tier.**
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

    /**
     * GET /orphans — files nothing references, older than a cutoff.
     *
     * Answers `{ data: File[], meta: { count, olderThan } }`. Optional `?olderThan=`
     * ISO instant, defaulting to seven days ago; `OrphansQuerySchema` refuses anything
     * inside the last 24 hours, which is the guard rail that keeps a just-uploaded file
     * — attached a second later — out of the delete candidate list.
     *
     * Declared before `/:id/permanent` for the ordinary reason, though nothing collides
     * here: the two differ in method and in segment count.
     *
     * The handler is the one that served `GET /api/files/orphans` unchanged. Its
     * in-handler `req.auth.role !== 'admin'` check is satisfied by `requireAdminCaller`,
     * which fabricates exactly that shape, and it stays as a second lock on the path
     * that feeds the hard delete (Phase 5 C-5).
     */
    router.get('/orphans', FileManagementController.listOrphans);

    /**
     * DELETE /:id/permanent — the unrecoverable one.
     *
     * Removes the row and then deletes the object from storage best-effort: the database
     * is the source of truth, so a storage failure is logged and the delete stands rather
     * than rolling back into a half state.
     *
     * ⚠ **`:id`, not `:fileId`.** The handler reads `req.params.id` and comes across
     * unchanged; naming the segment anything else hands it `undefined` and turns the
     * route into a 404-on-everything. wi-admin's own path is `/files/:fileId/permanent`
     * and its confirmation guard (Phase 5 D-9) lives there — this side takes the id it
     * is given.
     */
    router.delete('/:id/permanent', FileManagementController.hardDeleteFile);

    return router;
}

/** Build the file-resolution surface behind an arbitrary guard chain. */
export function buildAdminFileRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
