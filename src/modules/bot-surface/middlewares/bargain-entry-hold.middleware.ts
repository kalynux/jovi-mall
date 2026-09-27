import { ErrorRequestHandler } from 'express';
import { AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { bargainEntryFromText } from '../../bot-commands/domain/bargain-entry';
import { holdForUnregisteredSender } from '../services/bargain-entry.service';

/**
 * Keep the website's Bargain link through the ONE refusal a brand-new Telegram chat meets.
 *
 * ── THE GAP ──────────────────────────────────────────────────────────────────
 * `t.me/<bot>?start=bargain_<p>_<v>` arrives as `/start bargain_…` from a chat that may never have
 * shared its contact. `/command` is not an anonymous route, so the identity guard refuses it
 * with `BOT_IDENTITY_NEEDS_CONTACT` before any handler runs — and that refusal is the right first
 * turn (its reply renders the contact-share button). But nothing after it knows a product was
 * asked for: the setup turns that follow carry no text from this one.
 *
 * ── WHY AN ERROR HANDLER, AND NOT A BRANCH IN THE GUARD ─────────────────────
 * `requireBotIdentity` is the surface's security boundary and stays exactly as it is — no
 * exemption, no route that answers an unresolved sender. This runs only AFTER the guard has
 * refused, observes the refusal, keeps a product hint, and passes the SAME error on unchanged.
 * The customer sees precisely what they would have seen without it.
 *
 * ⚠ **Three conditions, all required:** the path is `/command`; the refusal is one of the two
 * "no account for this chat" codes; and the text parses as the Bargain link through the same
 * parser the router uses. Anything else is passed on untouched, and so is a failure in here.
 *
 * ⚠ **The hint carries no owner**, because there is none yet — see `pending-bargain.store.ts`.
 */
const NO_ACCOUNT_YET: ReadonlySet<string> = new Set([
    ERROR_CODES.BOT_IDENTITY_NEEDS_CONTACT,
    ERROR_CODES.BOT_IDENTITY_UNRESOLVED,
]);

export const holdBargainEntryForUnregisteredSender: ErrorRequestHandler = (error, req, _res, next) => {
    const envelope = req.bot?.envelope;
    const isCandidate =
        error instanceof AppError
        && NO_ACCOUNT_YET.has(error.code)
        && req.path === '/command'
        && envelope !== undefined;

    if (!isCandidate) {
        next(error);
        return;
    }

    const ids = bargainEntryFromText(typeof req.body?.text === 'string' ? req.body.text : null);
    if (!ids) {
        next(error);
        return;
    }

    // The refusal is passed on only once the hint is written, so the customer's contact share
    // cannot overtake it. `holdForUnregisteredSender` never rejects; `finally` is belt and braces.
    void holdForUnregisteredSender({ channel: envelope.channel, externalId: envelope.externalId }, ids)
        .finally(() => next(error));
};
