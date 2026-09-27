import { RequestHandler, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess } from '../../core/responses';
import { VendorModel } from '../vendors/vendor.model';
import { DeliveryAgencyModel } from '../delivery/delivery-agency.model';
import { DeliveryAgentModel } from '../agents/models/agent.model';
import { MailService } from './mail.service';

/**
 * `POST /api/internal/admin/mail/statement` — carry an account statement that **wi-admin
 * rendered** to the account holder's registered email.
 *
 * ── This service computes NOTHING here (owner decision O-8, 2026-09-27) ──────
 * wi-admin reads `jovi_mall` directly, builds the xlsx/pdf and posts the bytes. This route is a
 * mail relay with exactly one decision of its own: **who receives it**. See
 * `PRODUCTION-READINESS/ACCOUNT-STATEMENTS-AND-ANALYTICS-PLAN.md`.
 *
 * ── ⚠ There is no recipient field, and that is the security property ─────────
 * The recipient is the owner profile's `email`, and only when `email_verified` — the same rule
 * every vendor/agency/agent notification email already follows. A caller cannot name an
 * address, so a leaked `INTERNAL_ADMIN_SERVICE_TOKEN` can mail a statement only to the person
 * it describes. The schema is `.strict()` so a `to` field is REFUSED rather than ignored — an
 * ignored field would let a future caller believe it had chosen the address.
 *
 * Audit lives on wi-admin's side (`auditedAttempt`, fail-closed), where the administrator is
 * actually known. Nothing is persisted here.
 */

/** Decoded-size cap. Brevo, Resend and typical SMTP relays all accept a message of this size. */
export const STATEMENT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

export const StatementMailSchema = z
    .object({
        ownerType: z.enum(['vendor', 'agency', 'agent']),
        ownerId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id'),
        from: IsoDay,
        to: IsoDay,
        fileName: z
            .string()
            .trim()
            .min(1)
            .max(120)
            // No path separators, no header-breaking characters.
            .regex(/^[\w.\- ]+\.(pdf|xlsx)$/, 'Must be a plain file name ending in .pdf or .xlsx'),
        contentType: z.enum(ALLOWED_CONTENT_TYPES),
        contentBase64: z.string().min(1),
    })
    .strict();

export type StatementOwnerType = z.infer<typeof StatementMailSchema>['ownerType'];

interface ResolvedRecipient {
    email: string;
    name: string | null;
}

/**
 * The owner's registered email, or a coded refusal. Exported for `test:statement-mail`.
 *
 * `ownerId` is the PROFILE id (vendors / delivery_agencies / delivery_agents `_id`) — the same
 * id `earnings_allocations.beneficiary_id` and every billing `owner_id` carry.
 */
export async function resolveStatementRecipient(
    ownerType: StatementOwnerType,
    ownerId: string,
): Promise<ResolvedRecipient> {
    const profile = await loadProfile(ownerType, ownerId);
    if (!profile) {
        const code =
            ownerType === 'vendor'
                ? ERROR_CODES.VENDOR_NOT_FOUND
                : ownerType === 'agency'
                  ? ERROR_CODES.DELIVERY_AGENCY_NOT_FOUND
                  : ERROR_CODES.AGENT_NOT_FOUND;
        throw createAppError(code, 404);
    }
    if (!profile.email) {
        throw createAppError(ERROR_CODES.STATEMENT_RECIPIENT_MISSING, 409, undefined, { ownerType });
    }
    if (!profile.email_verified) {
        throw createAppError(ERROR_CODES.STATEMENT_RECIPIENT_UNVERIFIED, 409, undefined, { ownerType });
    }
    return { email: profile.email, name: profile.name ?? null };
}

async function loadProfile(
    ownerType: StatementOwnerType,
    ownerId: string,
): Promise<{ email?: string; email_verified?: boolean; name?: string } | null> {
    switch (ownerType) {
        case 'vendor': {
            const v = await VendorModel.findById(ownerId).select('email email_verified display_name').lean();
            return v ? { email: v.email, email_verified: v.email_verified, name: v.display_name } : null;
        }
        case 'agency': {
            const a = await DeliveryAgencyModel.findById(ownerId).select('email email_verified display_name').lean();
            return a ? { email: a.email, email_verified: a.email_verified, name: a.display_name } : null;
        }
        case 'agent': {
            const g = await DeliveryAgentModel.findById(ownerId).select('email email_verified name').lean();
            return g ? { email: g.email, email_verified: g.email_verified, name: g.name } : null;
        }
    }
}

/** Decode and size-check. Exported for `test:statement-mail`. */
export function decodeStatementAttachment(contentBase64: string): Buffer {
    const bytes = Buffer.from(contentBase64, 'base64');
    if (bytes.length === 0) {
        throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, 'contentBase64 decodes to nothing', {
            field: 'contentBase64',
        });
    }
    if (bytes.length > STATEMENT_ATTACHMENT_MAX_BYTES) {
        throw createAppError(ERROR_CODES.STATEMENT_ATTACHMENT_TOO_LARGE, 413, undefined, {
            maxBytes: STATEMENT_ATTACHMENT_MAX_BYTES,
        });
    }
    return bytes;
}

const mailService = new MailService();

function attachRoutes(router: Router): Router {
    /**
     * Body: {@link StatementMailSchema}. Answers `{ sent: true, recipient }`, where `recipient`
     * is the address MASKED (`j***@example.com`) — wi-admin shows the operator where it went
     * without this route becoming a way to read an account's email.
     */
    router.post(
        '/statement',
        asyncHandler(async (req, res) => {
            const input = StatementMailSchema.parse(req.body);
            if (input.from > input.to) {
                throw createAppError(ERROR_CODES.VALIDATION_ERROR, 400, '`from` must not be after `to`', {
                    field: 'from',
                });
            }
            const content = decodeStatementAttachment(input.contentBase64);
            const recipient = await resolveStatementRecipient(input.ownerType, input.ownerId);

            await mailService.send({
                to: recipient.email,
                type: 'SYSTEM',
                subject: `Your account statement (${input.from} to ${input.to})`,
                template: 'account-statement',
                variables: {
                    title: 'Your account statement',
                    recipientName: recipient.name,
                    from: input.from,
                    to: input.to,
                    fileName: input.fileName,
                },
                attachments: [{ filename: input.fileName, contentType: input.contentType, content }],
            });

            sendSuccess(res, { sent: true, recipient: maskEmail(recipient.email), bytes: content.length });
        }),
    );
    return router;
}

/** `jane.doe@example.com` → `j***@example.com`. Exported for `test:statement-mail`. */
export function maskEmail(email: string): string {
    const at = email.indexOf('@');
    if (at <= 0) return '***';
    return `${email[0]}***${email.slice(at)}`;
}

/** Build the statement-mail surface behind an arbitrary guard chain. */
export function buildAdminStatementMailRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
