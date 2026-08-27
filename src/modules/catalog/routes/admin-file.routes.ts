import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { FileManagementController } from '../../../api/controllers/file-management.controller';
import { FileUploadController, uploadMultiple } from '../../../api/controllers/file-upload.controller';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
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
 *
 * ── ⚠ The title above is a summary, not a census, and it has been stale twice ──
 * It read "resolution, and the two housekeeping routes" when the mount had three; BR-011
 * added `GET /:id/content` and BR-015 added `POST /upload`, and neither updated it. Stated
 * as a rule instead, so the next addition does not have to remember: **this mount is
 * everything the ADMINISTRATION does with a file, and nothing a platform session does.**
 * Each route arrived here because the equivalent on the public router is unreachable to an
 * administrator — Phase 5 Part B removed the `admin` branch from `requireAuth` — so this is
 * the only door, and every route on it is guarded by `requireAdminCaller` rather than by a
 * session.
 *
 * ⚠ **`POST /upload` is the first WRITE here**, and the first route on this mount that puts
 * something on the platform rather than reading or removing it. It reuses the public
 * router's own middleware and handler unchanged; see its own note below for why the
 * per-role limit and the owner stamping resolve correctly for a synthetic actor.
 */

const ResolveFilesSchema = z.object({
    fileIds: z
        .array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Each id must be a 24-character hex string'))
        .min(1, 'At least one file id is required')
        .max(100, 'At most 100 file ids may be resolved at once'),
});

/**
 * The path id on `GET /:id/content`.
 *
 * ⚠ **`:id`, not `:fileId`** — matching `/:id/permanent` below, whose handler comes across
 * from the public router and reads `req.params.id`. Two different segment names on one
 * mount is the kind of thing that reads as a typo and gets "fixed" into a 404-on-everything.
 */
const FileIdParamSchema = z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'The file id must be a 24-character hex string'),
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
     * POST /upload — an administrator's upload, arriving through wi-admin (BR-015).
     *
     * ── The door, not the capability ──────────────────────────────────────────
     * Everything this needs already existed and none of it was reachable. `POST
     * /api/files/upload` on the public router declares role-based limits that include
     * **`Admin: 2 GB per file`**, `ownerType: 'admin'` is a legal value throughout the file
     * layer, and `by-type` intake is explicitly *"general media intake for EVERY role"*.
     * What Phase 5 Part B removed was the *session*: `requireAuth` has no `admin` branch,
     * nothing mints a token carrying that role, and its own header says an `admin` *"can no
     * longer arrive on it at all"*. So the administration could not put a file on the
     * platform, and four screens on the admin dashboard were blocked behind that.
     *
     * ⚠ **This is NOT the public router re-opened.** That file's instruction — *"Do not
     * re-add an admin-only route here: this surface is the one a vendor, agency, agent or
     * customer session reaches"* — is honoured exactly: the door is on the INTERNAL mount,
     * behind `requireAdminCaller` and a service token, beside the resolve and the two
     * housekeeping routes that moved here for the same reason. BR-015's own option 3
     * (re-open the public route to an `admin` session) is not merely undesirable, it is
     * **structurally impossible** — there is no such session to re-open it to.
     *
     * ── The handler is REUSED, byte for byte ──────────────────────────────────
     * `uploadMultiple` and `FileUploadController.uploadFiles` are the public route's own
     * middleware and handler, mounted unchanged. Not a copy, and not a variant: the upload
     * pipeline is virus scanning, MIME sniffing, image transformation, storage-provider
     * writes, quota enforcement and the `files` row, and a second entry point into it would
     * be a second thing to keep in step with all six.
     *
     * ⚠ **Why the per-role limit resolves correctly here — deliberately, not by luck.**
     * `uploadFiles` reads `ROLE_UPLOAD_LIMITS[req.auth.role]` and falls back to the
     * *customer* figure for an unrecognised role. `requireAdminCaller` synthesises
     * `role: 'admin'` with no database query (ADR-004 D-1), so the lookup hits the `admin`
     * entry and the ceiling here is 2 GB — the intended one, not the fallback. It is
     * checked and stated rather than left as a coincidence, because the failure it would
     * otherwise have is silent: a 100 MB fallback that only bites on a large file.
     *
     * That 2 GB is a **backstop and never the binding limit.** wi-admin declares its own
     * (`ADMIN_UPLOAD_MAX_BYTES`, 32 MiB) and refuses past it *before* streaming, so a body
     * that would reach this ceiling never crosses the hop. Sizing an administrator's upload
     * is wi-admin's call — it is the service that knows the operation is a blog image or a
     * ticket attachment.
     *
     * The other three context values land correctly for the same synthetic-actor reason:
     * `ownerType: 'admin'` and `ownerId` come from `X-Actor-Id` via
     * `req.auth.role_entity._id`, and `vendorId` stays `undefined` because the role is not
     * `vendor`. `resolveStorageContext` returns `{}` for `admin` — plan-metered storage is
     * vendor/agency/agent only — so an administrator's upload is not billed against
     * anybody's plan, which is correct: there is no plan to bill it to.
     *
     * ── ⚠ It lands PUBLIC, and the blog depends on that ───────────────────────
     * `folder: 'by-type'` resolves per file through `resolveTypeFolder`, which maps every
     * `MediaCategory` onto one of `images|videos|audio|documents|archives|other` — and
     * `storage-trees.ts` classifies **all six `public`**. So an administrator's blog cover
     * gets `access: 'public'` and a real, working `url`. BR-015 asked for a definitive
     * answer on this because an article's `cover.url` is a stored string served to anonymous
     * readers; the answer is yes, and it is a property of the intake folder rather than
     * anything this route chooses. A caller cannot ask for a private tree here and there is
     * no reason to want one.
     *
     * ── The response is the raw `File[]`, and wi-admin resolves it ────────────
     * `uploadFiles` answers `{ success, data: File[], meta }` — domain entities with a
     * `key` and no `url`, because it never runs them through `resolveFileDetails`. That
     * shape is left ALONE: it is the response every vendor, agency, agent and customer
     * upload on the platform already receives, and changing it to close a wi-admin request
     * would be a breaking wire change on four other clients. wi-admin builds the
     * `FileDetail` locally instead (BR-015 decision L-3), using a URL builder proved
     * byte-identical to this service's by its own `verify:files`.
     *
     * **Nothing is audited on this side**, matching `/:id/content` below and for the same
     * reason: this service authenticates a *service*, so `X-Actor-Id` is a header its
     * holder sets, and a row written here would attribute an upload to an unverifiable
     * string. wi-admin audits it, where the human is actually known. Same reasoning as
     * ADR-020 D-5.
     */
    router.post('/upload', uploadMultiple, FileUploadController.uploadFiles);

    /**
     * GET /:id/content — the file's BYTES, for an administrator (BR-011).
     *
     * ── The gap this closes ───────────────────────────────────────────────────
     * `/resolve` answers metadata and a URL, and a file in a PRIVATE tree has no URL —
     * `toFileDetail` returns `url: null, access: 'authorized'` for `digital/` and
     * `shipments/` (ADR-A01 D-2). So the single most useful image on the platform for
     * settling a dispute, the delivery-proof photograph, was the one an administrator
     * could be told about and could not look at. There was no path to its bytes for an
     * administrator at all: the two that exist are scoped to the AGENT and the AGENCY
     * (`GET /api/{agent,agency}/shipments/:id/delivery-proof/file`), and an administrator
     * holds neither identity here.
     *
     * ── BYTES, not a signed URL, and that is the decided shape ────────────────
     * The dashboard's request proposed a short-lived signed URL. Streaming was chosen
     * instead, for a reason that is specific to this deployment rather than aesthetic:
     * `STORAGE_PROVIDER` is `local`, where `getSignedUrl` **does not exist** — minting one
     * would mean inventing a signing scheme AND exposing a new unauthenticated route that
     * serves private bytes to anyone holding the link for its lifetime, which is a smaller
     * copy of the `express.static` hole ADR-A01 D-2 was written to close. Streaming needs
     * no new public surface and is the mechanism the platform's two existing private-file
     * routes already use. `storage.factory.ts`'s header names both options and puts this
     * one first.
     *
     * ── Any tree, and the public case is NOT a special case ───────────────────
     * This answers for a public file too, streaming it exactly the same way. The caller
     * therefore needs one code path and never has to know which tree a file is in — and
     * an administrator holding a `FileDetail` with a working `url` may still prefer this,
     * because the URL is unauthenticated and this is not. Refusing public files would buy
     * nothing and cost the client a branch.
     *
     * ⚠ **`digital/` is included, deliberately.** That means an administrator can retrieve
     * a vendor's saleable product file. It is the decided scope (an operator resolving a
     * dispute about a digital sale needs to see what was sold), and it is why wi-admin
     * AUDITS this read — the audit is the other half of the grant, exactly as it is for
     * `agents.tracking.read`. **Nothing is audited on this side**: this service
     * authenticates a *service*, not a person, so a row written here would attribute a
     * disclosure to `X-Actor-Id`, a header the token holder sets. Same reasoning as
     * ADR-020 D-5.
     *
     * ── `409`, not `501`, when the provider cannot serve ──────────────────────
     * `firebase` and `cloudinary` throw 501 from `getDownloadStream`. That is asked about
     * up front via `supportsDownloadStream()` and reported as
     * `409 STORAGE_DOWNLOAD_NOT_SUPPORTED`, because "this deployment cannot show private
     * files" is a configuration state a client must be able to render as such — a 5xx
     * sends somebody looking for an outage that is not happening.
     *
     * ⚠ Note what that 409 also means for the two EXISTING private-file routes: they call
     * `getDownloadStream` unguarded, so on those providers the digital download and the
     * delivery-proof download are already broken today. This route reports the condition;
     * it does not introduce it.
     */
    router.get(
        '/:id/content',
        asyncHandler(async (req, res) => {
            const { id } = FileIdParamSchema.parse(req.params);
            const storage = getStorageProvider();

            // Asked BEFORE the lookup: the answer does not depend on which file was
            // named, and a 404 for a provider that could never have served it would send
            // the caller looking for a missing file rather than a missing capability.
            if (!storage.supportsDownloadStream()) {
                throw createAppError(
                    ERROR_CODES.STORAGE_DOWNLOAD_NOT_SUPPORTED,
                    409,
                    `The configured storage provider (${storage.getProviderType()}) cannot serve file contents`,
                    { provider: storage.getProviderType() },
                );
            }

            const [file] = await fileRepository.findManyByIds([id]);
            if (!file) {
                // Same answer `/resolve` gives by omission: files are soft-deleted and
                // swept, so a record legitimately outlives the picture it points at.
                throw createAppError(ERROR_CODES.CATALOG_FILE_NOT_FOUND, 404, 'File not found');
            }

            const stream = await storage.getDownloadStream(file.key);

            res.setHeader('Content-Type', file.mimeType);
            res.setHeader('Content-Length', String(file.size));
            /**
             * `inline`, because the caller is displaying the file rather than saving it —
             * that is the entire point of BR-011. The filename is quoted and stripped of
             * quotes and control characters: `originalName` is uploader-supplied, and an
             * unescaped one is header injection.
             */
            const filename = (file.originalName ?? 'file').replace(/["\\\r\n]/g, '');
            res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
            /**
             * The bytes are authorization-scoped, so no shared cache may hold them. Belt
             * and braces — nothing between these two services caches today, and the day
             * something does is the day this line matters and nobody is looking at it.
             */
            res.setHeader('Cache-Control', 'private, no-store');

            stream.pipe(res);
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
