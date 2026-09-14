import { Request, Response } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { KycDocumentSlot, KYC_MULTI_SLOT_MAX_FILES } from '../../../core/types/kyc-documents.types';
import { KycRole, kycSubjectFor } from '../domain/kyc-subject';
import { kycSubmissionService } from '../services/kyc-submission.service';
import {
    buildKycDocumentParamSchema,
    buildKycSlotParamSchema,
    KycFileIdParamSchema,
    UpdateKycDetailsSchema,
} from '../validators/kyc.validator';

/**
 * The multipart intake for a verification document.
 *
 * ⚠ **Multer's ceilings protect PROCESS MEMORY and are not the policy.** The file is buffered
 * whole (`memoryStorage`) and Node Buffers live outside the V8 heap, so ten 10 MB uploads
 * against a `mem_limit: 768m` container is the number that matters here. The real policy —
 * which MIME types, which transforms, the virus scan, the applicant's storage quota — is
 * `getKycDocumentUploadConfig()`, applied inside the intake pipeline, and it is what produces
 * a documented `UPLOAD_POLICY_VIOLATION` rather than multer's own error shape.
 *
 * The two must not drift: this is the same pairing `getDigitalAssetUploadConfig` documents.
 */
const KYC_UPLOAD_MAX_SIZE_BYTES = 10 * 1024 * 1024;

export const uploadKycDocuments = multer({
    storage: multer.memoryStorage(),
    limits: { files: KYC_MULTI_SLOT_MAX_FILES, fileSize: KYC_UPLOAD_MAX_SIZE_BYTES },
}).array('documents', KYC_MULTI_SLOT_MAX_FILES);

/**
 * One controller, three roles.
 *
 * `req.auth!.role_entity._id` is the vendor / agency / agent id, so every handler is scoped to
 * the caller's own record by construction — there is no id in any path here, and therefore no
 * way to address somebody else's documents. That is deliberate on a surface whose payload is
 * a photograph of a person holding their identity card.
 */
export class KycController {
    static build(role: KycRole) {
        const subject = kycSubjectFor(role);
        const SlotParamSchema = buildKycSlotParamSchema(subject.slots);
        const DocumentParamSchema = buildKycDocumentParamSchema(subject.slots);

        const entityIdOf = (req: Request) => req.auth!.role_entity._id.toString();

        return {
            get: asyncHandler(async (req: Request, res: Response) => {
                const data = await kycSubmissionService.get(role, entityIdOf(req));
                res.json({ success: true, data });
            }),

            updateDetails: asyncHandler(async (req: Request, res: Response) => {
                const input = UpdateKycDetailsSchema.parse(req.body);
                const data = await kycSubmissionService.updateDetails(role, entityIdOf(req), input);
                res.json({ success: true, data, message: 'Verification details updated' });
            }),

            attach: asyncHandler(async (req: Request, res: Response) => {
                const { slot } = SlotParamSchema.parse(req.params);
                const files = (req.files as Express.Multer.File[] | undefined) ?? [];
                if (files.length === 0) {
                    throw createAppError(
                        ERROR_CODES.KYC_FILE_REQUIRED,
                        400,
                        'Attach at least one file under the field name "documents"',
                    );
                }

                const data = await kycSubmissionService.attach(
                    role,
                    entityIdOf(req),
                    slot as KycDocumentSlot,
                    files.map((f) => ({
                        buffer: f.buffer,
                        originalName: f.originalname,
                        size: f.size,
                        mimeType: f.mimetype,
                    })),
                );
                res.status(201).json({ success: true, data, message: 'Document uploaded' });
            }),

            detach: asyncHandler(async (req: Request, res: Response) => {
                const { slot, fileId } = DocumentParamSchema.parse(req.params);
                const data = await kycSubmissionService.detach(
                    role,
                    entityIdOf(req),
                    slot as KycDocumentSlot,
                    fileId,
                );
                res.json({ success: true, data, message: 'Document removed' });
            }),

            submit: asyncHandler(async (req: Request, res: Response) => {
                const data = await kycSubmissionService.submit(role, entityIdOf(req));
                res.json({ success: true, data, message: 'Submitted for review' });
            }),

            /**
             * The applicant reading back their own upload.
             *
             * `inline`, and the filename is stripped of quotes and control characters —
             * `originalName` is uploader-supplied and an unescaped one is header injection.
             * `private, no-store` because these bytes are authorization-scoped: nothing between
             * here and the browser caches today, and the day something does is the day this
             * line matters and nobody is looking at it.
             */
            content: asyncHandler(async (req: Request, res: Response) => {
                const { fileId } = KycFileIdParamSchema.parse(req.params);
                const file = await kycSubmissionService.streamOwnDocument(
                    role,
                    entityIdOf(req),
                    fileId,
                );

                res.setHeader('Content-Type', file.mimeType);
                res.setHeader('Content-Length', String(file.size));
                const filename = file.filename.replace(/["\\\r\n]/g, '');
                res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
                res.setHeader('Cache-Control', 'private, no-store');

                file.stream.pipe(res);
            }),
        };
    }
}
