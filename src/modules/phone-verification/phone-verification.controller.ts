import { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { phoneVerificationService } from './services/phone-verification.service';
import { phoneVerificationCoordinator } from './services/phone-verification.coordinator';

/**
 * WhatsApp phone verification — the HTTP surface.
 *
 * Mounted at `/api/me/phone/verify/*`, beside the existing `/api/me/phone` contact-change
 * verbs, because it is the same subject reached by a different proof. Both are behind
 * `requireAuth`.
 *
 * ⚠ **Route order matters and is safe here by construction:** `verify` is a LITERAL segment
 * under `/phone`, and the neighbouring routes (`/phone/confirm`, `/phone/pending`) are literals
 * too — no `:param` is declared on that prefix, so nothing can shadow anything. This service
 * has been bitten by route order twice; the note is here so the next person adding
 * `/phone/:something` sees it.
 */

const ConfirmSchema = z.object({
    /**
     * `.strict()` on the envelope, so a client that sends `phone` alongside the code gets a
     * 400 rather than having it silently stripped. The number being verified is decided by the
     * SERVER when the code was minted and is stored with it — accepting one here would let a
     * caller prove control of number A and have number B marked verified.
     */
    code: z.string().min(4).max(12),
}).strict();

export class PhoneVerificationController {
    /**
     * POST /api/me/phone/verify/request
     *
     * Sends a code to the pending number if a change is in flight, otherwise to the number
     * already on the account. The caller does not choose — see {@link ConfirmSchema}.
     */
    static request = asyncHandler(async (req: Request, res: Response) => {
        const result = await phoneVerificationCoordinator.request({
            userId: req.auth!.user._id.toString(),
            role: req.auth!.role,
            roleEntityId: req.auth!.role_entity._id.toString(),
        });

        sendSuccess(res, result, {
            message: `A verification code was sent to ${result.phoneMasked} on WhatsApp. It expires in a few minutes.`,
        });
    });

    /** POST /api/me/phone/verify/confirm — spend the code. */
    static confirm = asyncHandler(async (req: Request, res: Response) => {
        const { code } = ConfirmSchema.parse(req.body);

        const result = await phoneVerificationCoordinator.confirm(
            {
                userId: req.auth!.user._id.toString(),
                role: req.auth!.role,
                roleEntityId: req.auth!.role_entity._id.toString(),
            },
            code,
        );

        sendSuccess(res, result, {
            message: result.changed
                ? 'Your phone number has been changed and verified.'
                : 'Your phone number is verified.',
        });
    });

    /** GET /api/me/phone/verify — is a verification in flight, and is the number verified? */
    static state = asyncHandler(async (req: Request, res: Response) => {
        const state = await phoneVerificationCoordinator.describe({
            userId: req.auth!.user._id.toString(),
            role: req.auth!.role,
            roleEntityId: req.auth!.role_entity._id.toString(),
        });
        sendSuccess(res, state);
    });
}

/** Re-exported so the routes file does not have to know the service exists. */
export { phoneVerificationService };
