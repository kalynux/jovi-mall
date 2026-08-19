import { Request, Response } from 'express';
import multer from 'multer';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { deliveryProofService } from './delivery-proof.service';

/**
 * Single-file multer instance for the delivery-proof upload. Field name `file`.
 * The 20 MB ceiling only protects process memory; the real per-image cap (10 MB,
 * jpeg/png/webp) and the "exactly one image" rule are enforced by the upload
 * pipeline (getDeliveryProofUploadConfig), which returns clean policy violations.
 */
export const uploadDeliveryProof = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fileSize: 20 * 1024 * 1024 },
}).single('file');

/**
 * AgentDeliveryProofController
 *
 * The agent's optional single delivery-proof image for a shipment they hold. The
 * image is stored on (and charged to) the shipment's AGENCY, attached at/after
 * the delivery outcome. See DeliveryProofService.
 */
export class AgentDeliveryProofController {
    /** POST /api/agent/shipments/:id/delivery-proof (multipart, field `file`) */
    static upload = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;

        if (!req.file) {
            throw createAppError(
                ERROR_CODES.SHIPMENT_PROOF_FILE_REQUIRED,
                400,
                'A single image file is required (multipart field "file")',
            );
        }

        const proof = await deliveryProofService.attach(agentId, shipmentId, {
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            size: req.file.size,
            mimeType: req.file.mimetype,
        });

        res.status(201).json({
            success: true,
            data: proof,
            message: 'Delivery proof uploaded',
        });
    });

    /** GET /api/agent/shipments/:id/delivery-proof */
    static get = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;

        const proof = await deliveryProofService.get(agentId, shipmentId);

        res.json({ success: true, data: proof });
    });

    /** DELETE /api/agent/shipments/:id/delivery-proof */
    static remove = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        const agentId = req.auth!.role_entity._id.toString();
        const shipmentId = req.params.id;

        await deliveryProofService.remove(agentId, shipmentId);

        res.json({ success: true, message: 'Delivery proof removed' });
    });

    /**
     * GET /api/agent/shipments/:id/delivery-proof/file — the BYTES.
     *
     * This is the door that replaces the public URL (ADR-A01 D-2). The metadata route above
     * still answers with a `FileDetail`, whose `url` is now `null` and whose `access` is
     * `authorized`; this is where the image itself comes from.
     */
    static download = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        await streamDeliveryProof(res, { role: 'agent', id: req.auth!.role_entity._id.toString() }, req.params.id);
    });
}

/**
 * GET /api/agency/shipments/:id/delivery-proof/file — the same bytes, the agency's scope.
 *
 * Its own controller rather than a role parameter on the one above, because the two live on
 * routers with different guards and different id sources; the shared part is
 * `DeliveryProofService.streamTo`, which is where the scoping decision actually is.
 */
export class AgencyDeliveryProofController {
    static download = asyncHandler(async (req: Request, res: Response): Promise<void> => {
        await streamDeliveryProof(res, { role: 'agency', id: req.auth!.role_entity._id.toString() }, req.params.id);
    });
}

/**
 * One streaming body for both roles.
 *
 * `inline`, not `attachment`: a proof photo is looked at on a shipment screen, not filed. And
 * **`no-store`** — this replaced a URL that any cache would have been free to keep, which is
 * half of what made the old public path a durable leak.
 */
async function streamDeliveryProof(
    res: Response,
    viewer: { role: 'agent' | 'agency'; id: string },
    shipmentId: string,
): Promise<void> {
    const { stream, mimeType, size, filename } = await deliveryProofService.streamTo(viewer, shipmentId);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Cache-Control', 'private, no-store');

    stream.pipe(res);
    stream.on('error', () => {
        // The headers are already out by the time a read fails, so there is no status left to
        // send. Destroying the response is what tells the client the body is incomplete —
        // ending it cleanly would hand over a truncated image that looks like the whole one.
        res.destroy();
    });
}
