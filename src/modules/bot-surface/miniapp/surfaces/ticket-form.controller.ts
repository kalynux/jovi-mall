import { Request, Response } from 'express';
import { asyncHandler } from '../../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../../core/responses';
import { TelegramBotService } from '../../../telegram/services/telegram-bot.service';
import { botTicketOpenedPush } from '../../domain/bot-ticket-copy';
import { TicketFormOpened, readTicketForm, submitTicketForm } from './ticket-form.read';

const telegramBotService = new TelegramBotService();

/**
 * `tf` — the one-screen support form, as a page inside Telegram.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────
 * Two thin wrappers over `ticket-form.read.ts`, plus the one thing a transport owns: saying so in the
 * chat afterwards. Every rule — what the form shows, which ticket type a submission becomes, that the
 * handle is spent exactly once — lives in that module, because the WhatsApp Flow calls the same two
 * functions and a second copy is a copy that drifts on the channel nobody can open in a browser.
 *
 * ── ⚠ THE PAGE IS TOLD ALMOST NOTHING BACK ──────────────────────────────────
 * A screen that is about to close is the wrong place for a receipt. The submit answers with the
 * request's id and subject so the page can say "sent", and everything the customer actually needs
 * arrives in the chat — where it stays, in their language, with a button to open the request.
 */
export class TicketFormController {
    /** `GET /api/bot/miniapp/s/tf/:handle/data` — repeatable; spends nothing. */
    static data = asyncHandler(async (req: Request, res: Response) => {
        sendSuccess(res, await readTicketForm(String(req.params.handle ?? '')));
    });

    /**
     * `POST /api/bot/miniapp/s/tf/:handle/submit` — SPENDS the handle and opens the request.
     *
     * ⚠ **The confirmation is pushed BEFORE the response is sent, and cannot fail it.** The page may
     * be closed by the customer the instant it gets an answer, so a push afterwards would race the
     * WebView's own teardown — and `pushConfirmation` swallows its failures, because a request that
     * exists must never be reported as a failure over a notification about it.
     */
    static submit = asyncHandler(async (req: Request, res: Response) => {
        const opened = await submitTicketForm(String(req.params.handle ?? ''), req.body ?? {});

        await pushConfirmation(opened);

        sendSuccess(
            res,
            {
                ticketId: opened.ticketId,
                subject: opened.subject,
                attachmentAttached: opened.attachmentAttached,
            },
            { status: 201 },
        );
    });
}

/**
 * Say in the conversation that the request is in.
 *
 * ⚠ **Telegram only, and the WhatsApp gap is stated rather than hidden.** A Mini App page is a
 * Telegram control; on WhatsApp this form is a Flow, and a completed Flow comes back through the
 * ordinary reply renderer, which needs no push at all. The same split `bot-purchase.controller.ts`
 * documents for Bargain and Book.
 *
 * ⚠ **Best-effort by construction.** `sendMessage` answers false rather than throwing, and the
 * request has already been opened — turning a failed notification into a failed submission would tell
 * a customer their complaint was lost when the only thing lost was the message about it.
 */
async function pushConfirmation(opened: TicketFormOpened): Promise<void> {
    if (opened.conversation.channel !== 'telegram') return;

    await telegramBotService.sendMessage(
        opened.conversation.externalId,
        botTicketOpenedPush(opened.subject, opened.conversation.language),
    );
}
