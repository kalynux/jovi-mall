import type { BotSyncDto } from '../dto/bot-projections';
import { acceptTermsActionId, skipActionId } from './bot-action-id';
import { botChrome } from './bot-chrome-copy';
import { languageChoiceIntent } from './language-choice';
import type { BotReplyIntent } from './channel-reply';

/** The next setup question, as `toBotSyncDto` words it. Null once the checklist is finished. */
export type BotOnboardingNextDto = BotSyncDto['onboarding']['next'];

/**
 * Turn the next onboarding step into the message to send.
 *
 * Extracted from `bot-identity.controller.ts` (which still sets it on every sync) so that a
 * second door can ask the same question with the same control: the website's Bargain link can
 * arrive while the checklist is still open, and its answer leads with this question rather than
 * a price question the customer cannot answer yet (`bargain-entry.service.ts`). Two renderings
 * of one step would drift — one would gain a Skip button the other never draws.
 *
 * ⚠ **`null` for a finished checklist, and that is the important branch.** `next: null` means the
 * platform has no question left and the turn belongs to whoever answers what the customer asked.
 *
 * ── A SKIPPABLE STEP SHIPS A BUTTON, NOT AN INSTRUCTION ─────────────────────
 * The Skip action's label is translated and its **id is not** (`skipActionId`), so nothing
 * downstream has to know five spellings of "skip". See `bot-action-id.ts`.
 */
export function onboardingReplyIntent(next: BotOnboardingNextDto, language: string | null): BotReplyIntent | null {
    if (!next) return null;

    if (next.step === 'language') {
        // The first question for a new account: the same picker the account menu draws, so a
        // tap here and a tap there are one `lang:<code>` token answered by one handler.
        return languageChoiceIntent(next.prompt, language);
    }

    if (next.requestContact) {
        // The phone step. A verified contact is its own control, and it is never skippable.
        return { kind: 'contact_request', text: next.prompt, buttonLabel: botChrome('contactButton', language) };
    }

    if (next.requestLocation) {
        /**
         * The address step. A pin is the shortcut and typing still works, so this control
         * replaces the plain `text` + Skip action rather than sitting beside it.
         *
         * ⚠ **The Skip travels as `skipLabel`, not as an `action`.** On Telegram a location
         * request is a reply keyboard and `reply_markup` is a union, so an inline Skip carrying
         * `skip:address` cannot be on the same message. The renderer puts a second keyboard
         * button there instead, and the caller is handed the exact string it will send back
         * (`next.skipLabel`) so it never has to know the word.
         */
        return {
            kind: 'location_request',
            text: next.prompt,
            buttonLabel: botChrome('locationButton', language),
            ...(next.skipLabel ? { skipLabel: next.skipLabel } : {}),
        };
    }

    if (next.step === 'terms') {
        // The consent step: the links are in the prompt, and agreeing is one tap. Required, so
        // there is no Skip — a customer who does not agree simply does not press it.
        return {
            kind: 'text',
            text: next.prompt,
            actions: [{ id: acceptTermsActionId(), label: botChrome('acceptTermsButton', language) }],
        };
    }

    return {
        kind: 'text',
        text: next.prompt,
        // Absent — not an empty array — on a required step, so the renderer's own "no actions"
        // branch is what draws a plain message.
        ...(next.skippable
            ? { actions: [{ id: skipActionId(next.step), label: botChrome('skipButton', language) }] }
            : {}),
    };
}
