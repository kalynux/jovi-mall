import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { loadUploadConfig } from '../../../core/uploads/upload-config';
import { UploadIntakeService } from '../../../core/uploads/upload-intake.service';
import { resolveVirusScanner } from '../../../core/uploads/scanners';
import { IUploadObserver } from '../../../core/uploads/upload-policy.types';
import { getStorageProvider } from '../../../core/storage';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { botCallerOf } from '../middlewares/bot-identity.middleware';
import { BotInboundFileSchema } from '../validators/bot.validators';
import { inboundFileStore } from '../services/inbound-file.store';
import { toBotInboundFileDto } from '../dto/bot-projections';

/** No-op observer, as every other upload site uses. */
class BotUploadObserver implements IUploadObserver {}

/**
 * The largest file a chat may hand us, measured on the DECODED bytes.
 *
 * ⚠ **Not the same number as the parser limit, and both are needed.** `app.ts` mounts a
 * wider `express.json` on this one path because the global ceiling is 1 MB and base64
 * inflates by a third — but a parser limit produces a bare 413 with no code a chat can
 * relay. This is the refusal a customer actually reads, and it fires first for anything
 * under the parser's ceiling.
 *
 * 8 MB is above every image either channel will deliver (WhatsApp caps images at 5 MB;
 * Telegram compresses photos well below that) and below the pipeline's own 10 MB per-image
 * policy, so a file that passes here is never refused later for its size alone.
 */
export const BOT_INBOUND_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * What a chat may send. **Narrower than the upload pipeline's allowlist, deliberately.**
 *
 * The pipeline also permits `application/zip`, `audio/mpeg` and `audio/wav`. None of the
 * three is a thing a customer usefully attaches to a support ticket from a phone, and each
 * would be a download the support agent has to decide whether to trust. Voice notes are
 * the case worth naming: both channels send them as `audio/ogg`, which the pipeline refuses
 * anyway, so forwarding them would buy a guaranteed failure. The automation layer filters
 * on the same rule before it spends a download, and this is the half that is enforced.
 */
const BOT_INBOUND_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'application/pdf',
]);

/**
 * Files a customer sent in a chat window (Step 7b).
 *
 * ── WHY THIS ROUTE EXISTS AT ALL ────────────────────────────────────────────
 * A photo arrives on WhatsApp or Telegram as an id pointing at a file on Meta's or
 * Telegram's servers. Only the automation layer can fetch it: it holds the channel tokens,
 * and this service must not — a backend that fetched a URL a caller supplied would be an
 * outbound request to wherever the caller pointed it. So the bytes come in here, and the
 * split is the honest one: n8n knows the channels, this service knows what an upload is.
 *
 * ⚠ **This row is `flow_only` and must stay `flow_only`.** It is called by the deterministic
 * step that runs when a media message arrives, before the model does anything. A model has
 * no bytes and therefore nothing to send it; registering it as a tool would only offer a
 * language model a base64 field to fill in.
 *
 * ── IT STORES THE FILE AND ATTACHES IT TO NOTHING ───────────────────────────
 * Where the file belongs is a decision, and this route is not where decisions are made — a
 * customer photographs a damaged item before there is a ticket to put it on as often as
 * after. So it runs the ordinary upload pipeline (sniffing, virus scan, quota, storage) and
 * answers with a handle. `tickets_add_attachment` is what spends it.
 *
 * A handle nobody spends costs a stored file and nothing else: no `file_references` row is
 * written here, so the orphan garbage collector reclaims it on its own schedule. That is
 * the designed outcome for the photos a conversation never uses, not a leak.
 */
export class BotFileController {
    /**
     * `POST /files/inbound` — take delivery of a file the customer sent.
     *
     * The upload is stamped `ownerType: 'customer'` / `ownerId: caller.customerId`, which is
     * not bookkeeping: `TicketAttachmentService.enforceFileAttachmentAuthorization` lets an
     * attacher use a file only when it is system-owned or their own, comparing exactly those
     * two fields against the actor. Stamping anything else here would store the file
     * successfully and then refuse every attempt to attach it.
     */
    static receiveInbound = asyncHandler(async (req: Request, res: Response) => {
        const input = BotInboundFileSchema.parse(req.body ?? {});
        const caller = botCallerOf(req);

        /**
         * ⚠ **Decode before measuring, and measure the buffer rather than the string.**
         * `contentBase64.length * 3 / 4` is the arithmetic somebody writes instead, and it
         * is wrong by up to two bytes for padding and by an unbounded amount if the string
         * carries whitespace or a `data:` prefix. Node accepts all of that silently and
         * produces a shorter buffer, so the estimate over-reports and refuses valid files.
         */
        const bytes = Buffer.from(input.contentBase64, 'base64');

        if (bytes.length === 0) {
            throw createAppError(ERROR_CODES.UPLOAD_POLICY_VIOLATION, 400, 'Upload policy violations found', {
                violations: [{ code: 'NO_FILES_UPLOADED', message: 'The file content decoded to nothing' }],
            });
        }

        if (bytes.length > BOT_INBOUND_FILE_MAX_BYTES) {
            throw createAppError(ERROR_CODES.UPLOAD_POLICY_VIOLATION, 413, 'Upload policy violations found', {
                violations: [
                    {
                        code: 'FILE_TOO_LARGE',
                        message: `File "${input.fileName}" exceeds the ${BOT_INBOUND_FILE_MAX_BYTES / (1024 * 1024)} MB chat limit`,
                        metadata: { size: bytes.length, limit: BOT_INBOUND_FILE_MAX_BYTES },
                    },
                ],
            });
        }

        if (!BOT_INBOUND_MIME_ALLOWLIST.has(input.mimeType)) {
            /**
             * `MIME_NOT_ALLOWED`, not a code of our own: this is the same refusal the
             * sniffing pipeline makes later and the spelling `api-doc/errors/README.md`
             * publishes. The pipeline still re-checks the REAL type from the bytes, so a
             * caller that lies about `mimeType` to get past this line is refused there.
             */
            throw createAppError(ERROR_CODES.UPLOAD_POLICY_VIOLATION, 400, 'Upload policy violations found', {
                violations: [
                    {
                        code: 'MIME_NOT_ALLOWED',
                        message: `"${input.mimeType}" cannot be sent from a chat. Allowed: images and PDF`,
                        metadata: { claimedMimeType: input.mimeType, originalName: input.fileName },
                    },
                ],
            });
        }

        const config = loadUploadConfig();
        const intake = new UploadIntakeService(
            config,
            getStorageProvider(),
            new FileRepositoryMongo(),
            new BotUploadObserver(),
            resolveVirusScanner(config),
        );

        const [file] = await intake.execute({
            // 'by-type', as `POST /api/files/upload` uses: the caller has not said what the
            // file is FOR, and a purpose folder carries an access rule this has no basis to
            // claim. Where it ends up is decided when the handle is spent.
            folder: 'by-type',
            context: {
                userId: caller.userId,
                role: 'user',
                ownerType: 'customer',
                ownerId: caller.customerId,
            },
            files: [
                {
                    buffer: bytes,
                    originalName: input.fileName,
                    // No `size`: `UploadFileInput` has no such field — the pipeline
                    // measures `buffer.length` itself, which is the number that counts.
                    mimeType: input.mimeType,
                },
            ],
        });

        const ref = await inboundFileStore.mint(caller.userId, {
            fileId: file.id,
            fileName: file.originalName ?? input.fileName,
            mimeType: file.mimeType,
            size: file.size,
        });

        sendSuccess(res, toBotInboundFileDto(ref, file), { status: 201 });
    });
}
