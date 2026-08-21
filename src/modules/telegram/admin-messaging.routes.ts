import { RequestHandler, Router } from 'express';
import { TelegramNotificationService } from './services/telegram-notification.service';
import { SendNotificationSchema } from './validators/telegram.validator';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { sendSuccess } from '../../core/responses';

/**
 * The administrative messaging surface — one route, and it exists to get an admin-only
 * capability off a webhook path.
 *
 * ── What moved, and why it had to ────────────────────────────────────────────
 * `POST /api/webhooks/telegram/send` was the last of three admin-only endpoints living on
 * a public-looking prefix (Phase 5 Part B moved the two file ones). It was guarded by
 * `requireAuth + requireRole(['admin'])` — a platform `users` row carrying the legacy
 * `admin` role, a credential that predates wi-admin's permission catalog entirely and
 * knows nothing about tiers. Here it sits behind `requireAdminCaller` and wi-admin gates
 * it on `messaging.telegram.send`, with a real administrator identity on the audit row.
 *
 * ── It is NOT a broadcast, and the permission was renamed to say so ──────────
 * One message, one recipient. There is no audience, no segmentation, no scheduling and no
 * delivery record — `TelegramBotService.sendMessage` returns a boolean and keeps nothing.
 * The reachable set is not "platform users" but the accounts that linked Telegram through
 * `/connect`. wi-admin's family was `broadcast` and is now `messaging` (Phase 5 D-11).
 *
 * ── ⚠ Two consequences of the move that a diff does not show (Phase 5 C-6) ───
 * The plan this came from stated both of these backwards, so they are written out here
 * rather than left to be rediscovered:
 *
 *  1. **The send is now MORE available during maintenance, not less.**
 *     `/api/internal/admin` is the FIRST entry in `ALWAYS_EXEMPT`
 *     (`modules/system/domain/maintenance-mode.ts`) — reachable unconditionally, in every
 *     mode. The old `/api/webhooks` exemption was CONDITIONAL: an operator could revoke it
 *     for a given window by setting `blockWebhooks`. So the operator LOSES a per-window off
 *     switch they used to have, and wi-admin has no maintenance mode of its own to replace
 *     it. Accepted: the exemption exists because blocking `/api/internal/admin` locks the
 *     operator out of turning maintenance off, and carving one path out of it would be a
 *     second, weaker rule over the same prefix.
 *
 *  2. **This service's rate limiter does not apply here at all.** wi-admin presents
 *     `INTERNAL_ADMIN_SERVICE_TOKEN`, so `resolveCallerClass` returns `internal_service`,
 *     which is `'exempt'` in both `GLOBAL_POLICY` and `IDENTITY_POLICY`. Layer B never runs
 *     — it is mounted at the tail of `requireAuth`, and this path has no session. What
 *     bounds an operator now is wi-admin's own identity-scoped limiter on
 *     `POST /api/v1/messaging/telegram`, which is new and is the intended answer.
 *
 * ── What did NOT move ────────────────────────────────────────────────────────
 * `POST /api/webhooks/telegram/webhook`, the bot bridge behind `requireBotWebhookSecret`.
 * That is genuinely a webhook — inbound, secret-guarded, called by the automation layer —
 * and it stays exactly where it is.
 */

const notificationService = new TelegramNotificationService();

function attachRoutes(router: Router): Router {
    /**
     * POST /telegram — body `{ userId?, chatId?, message }`, exactly one of the first two.
     *
     * Answers `{ sent: true, chatId }`. The `chatId` comes back because it is the only
     * evidence of WHERE the message went when the caller addressed a `userId`: the
     * connection is resolved here, and a caller that never learns the resolved chat cannot
     * tell "sent to the right person" from "sent to a stale connection".
     *
     * ⚠ **Two failures, and they are told apart by `chatId` rather than by the message
     * string.** `TelegramNotificationService.send` reports every failure as
     * `{ success: false, error }`, and the two causes need different statuses — one is the
     * caller's (there is nobody to send to), the other is Telegram's. The structural
     * discriminator is that the service echoes the resolved `chatId` on a delivery failure
     * and cannot echo one it never resolved:
     *
     *   no `chatId`  → the address could not be resolved     → 404 MESSAGING_CONNECTION_NOT_FOUND
     *   has `chatId` → resolved, and Telegram refused it     → 502 MESSAGING_DELIVERY_FAILED
     *
     * Matching on `result.error`'s wording would work today and break the first time
     * somebody rewords a log line. Both codes and both statuses are the ones the credential
     * delivery service already raises for the same two conditions
     * (`admin-credential-delivery.service.ts`, `channel-connection.service.ts`), which is
     * what `test:errors` requires — a code raised at two disagreeing statuses fails its
     * census.
     */
    router.post(
        '/telegram',
        asyncHandler(async (req, res) => {
            const input = SendNotificationSchema.parse(req.body);

            const result = await notificationService.send(input);

            if (!result.success) {
                throw result.chatId
                    ? createAppError(
                        ERROR_CODES.MESSAGING_DELIVERY_FAILED,
                        502,
                        result.error ?? 'Telegram delivery failed',
                        { channel: 'telegram' },
                    )
                    : createAppError(
                        ERROR_CODES.MESSAGING_CONNECTION_NOT_FOUND,
                        404,
                        undefined,
                        { channel: 'telegram' },
                    );
            }

            sendSuccess(res, { sent: true, chatId: result.chatId });
        }),
    );

    return router;
}

/** Build the administrative messaging surface behind an arbitrary guard chain. */
export function buildAdminMessagingRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
