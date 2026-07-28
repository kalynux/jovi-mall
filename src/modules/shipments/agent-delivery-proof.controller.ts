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
}
