import { Router, RequestHandler, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { staffIdentityDocumentService } from '../services/staff-identity-document.service';

/**
 * The multipart intake for a staff identity document.
 *
 * ⚠ **Multer's ceilings protect PROCESS MEMORY and are not the policy.** The file is buffered
 * whole (`memoryStorage`) and Node Buffers live outside the V8 heap, so the byte count against
 * a `mem_limit: 768m` container is the number that matters here. The real policy — which MIME
 * types, which transforms, the virus scan — is `getAdminIdentityDocumentUploadConfig()`,
 * applied inside the intake pipeline, and it is what produces a documented
 * `UPLOAD_POLICY_VIOLATION` rather than multer's own error shape.
 *
 * The two must not drift: the same pairing the KYC and digital-asset configs document.
 *
 * ── ⚠ EXACTLY ONE FILE PER REQUEST, and this is NOT an arbitrary limit ───────
 * The applicant KYC route accepts ten, because the service that receives it also owns the slot
 * and can count what a slot already holds before it stores anything.
 *
 * Here the slot lives in wi-admin and the bytes land here, and **wi-admin cannot count the
 * parts in a multipart body** — it pipes the body across unread and holds no multer by
 * decision (ADR-021 D-2). So its pre-flight "does this slot have room" check has to assume a
 * number. If that number can be wrong, the check is worthless in exactly the case it exists
 * for: a client posting three sketches into a slot holding eight would pass a check written
 * for one, and land eleven files in a ten-file slot with three already stored and no way to
 * refuse them that does not orphan bytes.
 *
 * Capping at one makes the assumption exact. A multi-value slot is filled one file at a time,
 * which is what a picker does anyway, and the cost is nil. A second part is refused by multer
 * as `LIMIT_UNEXPECTED_FILE` rather than silently ignored.
 */
const MAX_FILES_PER_REQUEST = 1;
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

export const uploadStaffIdentityDocuments = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_FILES_PER_REQUEST, fileSize: MAX_SIZE_BYTES },
}).array('documents', MAX_FILES_PER_REQUEST);

const FileIdParamSchema = z.object({
    fileId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id'),
});

/**
 * `/api/internal/admin/identity-documents` — where a member of platform staff puts their own
 * identity evidence.
 *
 * ── ⚠ THERE IS NO ID IN ANY PATH HERE, AND THERE MUST NOT BE ─────────────────
 * The administrator is taken from `X-Actor-Id`, which `requireAdminCaller` has already
 * validated. Adding a `:adminId` would introduce an authorization decision — *may this caller
 * write that person's record* — on a surface whose payload is a photograph of somebody
 * holding their identity card, and there is no caller who needs one: uploading is
 * self-service in wi-admin, and a tier-1 reviewer READS this evidence rather than supplying
 * it. Same rule, same reason, as `modules/identity-verification/routes/kyc.routes.ts`.
 *
 * ── What this surface does NOT have ──────────────────────────────────────────
 * **No read.** The bytes come back through `GET /api/internal/admin/files/:id/content`, which
 * already streams any file including a private one and which wi-admin already fronts with an
 * audited, permissioned route. A second door onto the same bytes would be a second place to
 * get the audit posture right.
 *
 * **No list.** wi-admin holds the record that says which file is in which slot; this service
 * holds bytes and a usage marker. A listing route here would have to invent an answer from
 * `ownerType`/`ownerId`, and it would be the wrong answer the moment a file was soft-deleted
 * in one place and not the other.
 *
 * **Nothing is audited on this side.** This service authenticates a SERVICE, so a row written
 * here would attribute a staff upload to `X-Actor-Id`, a header the token holder sets.
 * wi-admin records it where the person is actually known — the same reasoning as ADR-020 D-5
 * and as the `/files/upload` route beside this one.
 */
export function buildAdminStaffIdentityRouter(guards: RequestHandler[] = []): Router {
    const router = Router();
    if (guards.length > 0) router.use(...guards);

    /**
     * POST / — store ONE document for the calling administrator.
     *
     * Multipart, field name `documents`, exactly one file — see the ⚠ on the multer instance
     * above for why the cap is one rather than ten. Answers the created file as a `FileDetail`
     * in a one-element array (the array shape is kept so a future relaxation of the cap is not
     * a breaking response change), `url: null, access: 'authorized'` because `admin-identity`
     * is a private tree. wi-admin files the returned id into a slot on its own record; this
     * service never learns which.
     */
    router.post(
        '/',
        uploadStaffIdentityDocuments,
        asyncHandler(async (req: Request, res: Response) => {
            const adminId = req.auth!.user.id;
            const files = (req.files as Express.Multer.File[] | undefined) ?? [];
            if (files.length === 0) {
                throw createAppError(
                    ERROR_CODES.VALIDATION_ERROR,
                    400,
                    'Attach at least one file under the field name "documents"',
                );
            }

            const data = await staffIdentityDocumentService.upload(
                adminId,
                files.map((f) => ({
                    buffer: f.buffer,
                    originalName: f.originalname,
                    size: f.size,
                    mimeType: f.mimetype,
                })),
            );

            res.status(201).json({ success: true, data });
        }),
    );

    /**
     * DELETE /:fileId — drop one of the CALLER'S OWN documents.
     *
     * The service re-checks ownership against the `File` row and answers 404 when it does not
     * match, so this cannot reach another staff member's evidence even though the token that
     * opened the door is full-privilege. Soft delete — see the service.
     */
    router.delete(
        '/:fileId',
        asyncHandler(async (req: Request, res: Response) => {
            const { fileId } = FileIdParamSchema.parse(req.params);
            await staffIdentityDocumentService.detach(req.auth!.user.id, fileId);
            res.json({ success: true, data: { id: fileId, removed: true } });
        }),
    );

    return router;
}
