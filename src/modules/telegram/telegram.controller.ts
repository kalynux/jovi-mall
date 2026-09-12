import { Request, Response, NextFunction } from 'express';
import { CommandBus } from '../command-bus/command-bus';
import { buildCommandChannelReply } from '../command-bus/command-reply';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { AppError, createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

interface TelegramWebhookPayload {
    chat_id: string;
    user_id?: string;
    is_command: boolean;
    command?: string;
    payload?: any;
}

/**
 * Telegram bot ingress — **the webhook, and nothing else**.
 *
 * Account linking is NOT here any more. `link-token`, `status`, `toggle` and
 * `disconnect` moved to `/api/me/connections`, which binds to the User rather
 * than issuing a deep-link token the user carries to the bot.
 *
 * The admin direct-send is not here either (Phase 5 Part C). `sendNotification` was an
 * admin-only handler on a webhook prefix; the capability now lives at
 * `POST /api/internal/admin/messaging/telegram` and calls
 * `TelegramNotificationService` from there, which is why this class no longer holds one.
 * The service itself is untouched and has several other callers.
 */
export class TelegramController {
    private commandBus: CommandBus;

    constructor(commandBus: CommandBus) {
        this.commandBus = commandBus;
    }

    /**
     * Inbound bot messages, relayed by the automation layer.
     *
     * Phase 4 registers `connect` on the bus; the context carries `chat_id`,
     * which IS the messaging identity the code will be minted against. Phase
     * `/login` adds `login` and `login_contact` on the same context.
     */
    handleWebhook = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
        try {
            const body: TelegramWebhookPayload = req.body;
            const { chat_id, is_command, command, payload, user_id } = body;

            let result: any = { message: 'Inbound recorded' };
            if (is_command && command) {
                const context = {
                    source: 'telegram',
                    chat_id,
                    user_id,
                };

                console.log(`[Telegram-Webhook] Dispatching command: ${command}`);
                const cmdResult = await this.commandBus.execute(command, payload, context);
                result = { ...result, ...cmdResult };

                /**
                 * The channel-ready body, so the automation layer relays and never renders.
                 *
                 * ⚠ **Without this, `requestContact` is an instruction n8n has to obey**, and
                 * the record shows what that is worth: the mapping was specified on
                 * 2026-08-16, never built, and `/login` reached the model instead of the
                 * command bus until 2026-09-08. A `reply` cannot be forgotten — it is either
                 * sent or the turn is visibly silent.
                 *
                 * Attached after the spread so a command that ever returns its own `reply`
                 * wins, which is the direction that lets one graduate to composing its own.
                 */
                const reply = buildCommandChannelReply(cmdResult, 'telegram', String(chat_id ?? ''));
                if (reply && !(cmdResult as { reply?: unknown })?.reply) {
                    result = { ...result, reply };
                }
            }

            res.status(200).json(result);
        } catch (error: any) {
            console.error('[Telegram-Webhook] Error:', error.message);

            /**
             * ⚠ An AppError is forwarded UNCHANGED. This catch used to flatten every
             * failure into `INTERNAL_SERVER_ERROR` at 400, keeping only the message —
             * so a command that raised a precise, deliberate code had it erased on the
             * way out, and every Telegram webhook failure looked identical in the logs,
             * in the metrics and to the automation layer.
             *
             * That became load-bearing with `login_contact`, whose contact-share guard
             * raises `MAGIC_CONTACT_UNVERIFIED` — the one signal that distinguishes
             * "tapped the wrong contact" from an attempted account takeover. Flattened,
             * it was indistinguishable from a null-pointer bug.
             *
             * Non-AppError throws keep the old wrapping: they are genuinely unclassified,
             * and the status stays 400 rather than 500 so the automation layer's existing
             * branch is unchanged.
             */
            if (error instanceof AppError) return next(error);

            next(createAppError(ERROR_CODES.INTERNAL_SERVER_ERROR, 400, error.message));
        }
    });
}
