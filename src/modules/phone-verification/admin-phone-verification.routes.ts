import { Request, RequestHandler, Response, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { DEFAULT_LANGUAGE, Language, SUPPORTED_LANGUAGES } from '../../core/constants/languages';
import { phoneVerificationService } from './services/phone-verification.service';
import { adminSubject } from './domain/subject';

/**
 * `POST /api/internal/admin/phone-verification/{request,confirm}` — the OTP, for a caller whose
 * account this service does not own.
 *
 * ── Why wi-admin cannot do this itself ───────────────────────────────────────
 *
 * jovi-mall owns the WhatsApp integration: the Cloud API credentials, the 24-hour service
 * window bookkeeping, the approved templates. wi-admin has none of it and should not grow a
 * second copy — that would mean two services holding the same Meta credentials, two window
 * caches disagreeing about whether a free-form message is allowed, and the template set
 * approved against one phone number being used by another.
 *
 * ── Why jovi-mall does not finish the job either ─────────────────────────────
 *
 * ⚠ **This endpoint sends and judges. It writes NOTHING about the administrator**, because
 * administrators live in wi-admin's own database and this service has no row to stamp. The
 * confirm answers "this number was proved" and wi-admin writes `phone_verified` against its
 * own session. That split is the same one ADR-004 D-2 already draws for every other admin
 * operation, and it keeps the identity separation the whole admin architecture rests on: this
 * service never learns what an administrator *is*, only that somebody holding the service
 * token proved control of a number.
 *
 * ── The subject is namespaced ────────────────────────────────────────────────
 *
 * `admin:<id>`, never the bare id — administrator ids and `users._id` are both ObjectIds from
 * independently generated spaces, so a bare key lets the two collide. See `domain/subject.ts`.
 *
 * ⚠ The id comes from `X-Actor-Id` via `requireAdminCaller`, which this service trusts without
 * verifying. That is the established posture (the token is full-privilege, so re-checking the
 * header would be theatre) and the blast radius here is small: a forged header buys a code sent
 * to a number the forger supplied, on a credential they already hold. It cannot verify anybody
 * else's number, because the record that matters is written in wi-admin against a real session.
 */

const RequestSchema = z.object({
    /** E.164. Supplied by wi-admin from the administrator's own account — never guessed here. */
    phone: z.string().min(6).max(20),
    language: z.string().optional(),
}).strict();

const ConfirmSchema = z.object({
    code: z.string().min(4).max(12),
}).strict();

/** The administrator's id, as `requireAdminCaller` synthesised it onto `req.auth`. */
function subjectOf(req: Request): string {
    const id = req.auth?.user?._id?.toString();
    if (!id) {
        throw createAppError(
            ERROR_CODES.PHONE_VERIFICATION_NO_TARGET,
            422,
            'No administrator identity on this request',
        );
    }
    return adminSubject(id);
}

export function buildAdminPhoneVerificationRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);

    router.post('/request', asyncHandler(async (req: Request, res: Response) => {
        const input = RequestSchema.parse(req.body);
        // An unrecognised language falls back rather than refusing: wi-admin stores a free
        // string, and a code nobody can read is still a code — refusing to send one over a
        // locale mismatch would be the wrong failure.
        const language: Language = SUPPORTED_LANGUAGES.includes(input.language as Language)
            ? (input.language as Language)
            : DEFAULT_LANGUAGE;

        const result = await phoneVerificationService.send({
            subject: subjectOf(req),
            phone: input.phone,
            /**
             * Always `verify_current`. The `complete_change` intent drives
             * `ContactChangeService.applyPhoneChange`, which operates on a `users` row — there
             * is none here, and offering the value would let wi-admin ask for an outcome this
             * service cannot deliver.
             */
            intent: 'verify_current',
            language,
        });

        sendSuccess(res, result);
    }));

    router.post('/confirm', asyncHandler(async (req: Request, res: Response) => {
        const { code } = ConfirmSchema.parse(req.body);
        const proved = await phoneVerificationService.confirm(subjectOf(req), code);

        // The proved number and nothing else. wi-admin compares it against the number on its
        // own account before stamping — so a code minted for one number cannot verify another
        // even if wi-admin's state moved in between.
        sendSuccess(res, { phone: proved.phone, verified: true });
    }));

    return router;
}
