import type { FlowDefinition, FlowScreen } from './flow-definition.types';
import { FLOW_SCREEN_TITLE, NOTICE_SCREEN, noticeScreen } from './notice.screen';

/**
 * Opening a support request, as a WhatsApp Flow — the port of the `tf` screen.
 *
 * ── ⚠ A DRAFT, AND DELIBERATELY NOT IN THE PUBLISH LIST YET ─────────────────
 * The Telegram `tf` screen does not exist yet: the session kind and its prefill are in the store,
 * the words are in `bot-ticket-copy.ts`, and the read and the submit core are being built by the
 * stream that owns tickets. This file is the WhatsApp half drawn AGAINST the shape that was asked
 * for, so that when those two exports land only an adapter is left — instead of the round-1
 * sequence, where three projections were written inline and then had to be extracted.
 *
 * It is held to every structural rule by `test:whatsapp-flows` from the day it lands, and it is
 * **absent from `scripts/publish-whatsapp-flows.ts`**, so nothing can push an unfinished Flow to
 * Meta. Adding it there is the last step, not the first.
 *
 * ── WHAT A SUPPORT REQUEST NEEDS, AND WHERE EACH PART COMES FROM ────────────
 *   · **what it is about** — the eight subjects from `botTicketSubjectChoices(language)`, already
 *     worded in the customer's language. Eight fits a `RadioButtonsGroup` (cap 20) with every
 *     option visible, which a `Dropdown` hides behind a tap.
 *   · **what happened** — free text. `TextArea`, whose own cap is 600 characters.
 *   · **what the chat already knows** — the order the customer was looking at, or the photo they
 *     just sent. That is the session's PREFILL, never something the form asks for again.
 *
 * ── ⚠ TWO SCREENS, FOR THE REASON THE PRODUCT FORM HAS TWO ──────────────────
 * Meta documents no way to hide a component, so a context line ("about order …", "photo
 * attached") cannot be blanked when there is nothing to say — an empty caption is not a valid
 * component. So the endpoint picks: `SUPPORT` when the session carries context, `SUPPORT_PLAIN`
 * when it does not. Both are built from ONE list of children below, so they cannot drift.
 *
 * ── ⚠ THE PREFILLED TOPIC DECIDES THE TYPE, NOT THE QUESTION ────────────────
 * A failed-delivery card's "Ask to redeliver" / "Address is wrong" arrive as a topic on the
 * session, and `BOT_TICKET_TYPE_OF_TOPIC` already turns those into a `TicketType`. The form still
 * ASKS what it is about, because pre-selecting a radio needs an `init-value` this file has not
 * verified against Meta's reference — and a wrong guess there is a screen that fails at publish,
 * which is the one place this platform cannot rehearse. If pre-selection is wanted later, verify
 * that property first; nothing else here changes.
 *
 * ── ⚠ ONE HANDLE, ONE TICKET — AND THE GUARD IS NOT HERE ────────────────────
 * The `tf` handle is spent by the submit (`consume`, not `read`), inside the ticket stream's own
 * core. This side adds the same claim the checkout press takes, for the same reason: WhatsApp
 * retries an exchange on its own schedule, so a retry must REPLAY the first answer rather than
 * meet a spent handle and be told to start again — which is how a customer ends up opening a
 * second request about the same thing.
 */

/** The children both support screens share. `withContext` prepends the one line they differ by. */
function supportScreen(id: string, withContext: boolean): FlowScreen {
    return {
        id,
        title: FLOW_SCREEN_TITLE,
        data: {
            ...(withContext
                ? {
                      /**
                       * "About order ORD-123", "Photo attached", or both, composed server-side.
                       * ⚠ A `TextCaption` takes 409 characters — it is the labels that are short.
                       */
                      contextLine: { type: 'string' as const, __example__: 'About order ORD-2026-000123 · Photo attached' },
                  }
                : {}),
            subjectLabel: { type: 'string', __example__: 'What is it about?' },
            subjects: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        /** One of the eight `BotTicketSubjectKey` values — never a free string. */
                        id: { type: 'string' },
                        /** ⚠ Capped at 30 by Meta, like every option title. */
                        title: { type: 'string' },
                    },
                },
                __example__: [
                    { id: 'order', title: 'A problem with an order' },
                    { id: 'delivery', title: 'Delivery' },
                    { id: 'other', title: 'Something else' },
                ],
            },
            /** ⚠ A `TextArea` label caps at 20 — the French wording is exactly 20. */
            descriptionLabel: { type: 'string', __example__: 'What happened?' },
            /** ⚠ `helper-text` caps at 80. */
            descriptionHint: { type: 'string', __example__: 'A few sentences are enough.' },
            submitLabel: { type: 'string', __example__: 'Send' },
        },
        layout: {
            type: 'SingleColumnLayout',
            children: [
                ...(withContext
                    ? [{ type: 'TextCaption', text: '${data.contextLine}' }]
                    : []),
                {
                    /**
                     * ⚠ **`RadioButtonsGroup`, not a `Dropdown`.** Eight options fit inside the cap
                     * of 20 and every one stays visible; a drop-down would hide the list behind a
                     * tap, which on the screen somebody opens because something went wrong is one
                     * obstacle too many.
                     */
                    type: 'RadioButtonsGroup',
                    name: 'subject',
                    label: '${data.subjectLabel}',
                    required: true,
                    'data-source': '${data.subjects}',
                },
                {
                    type: 'TextArea',
                    name: 'description',
                    label: '${data.descriptionLabel}',
                    'helper-text': '${data.descriptionHint}',
                    required: true,
                },
                {
                    type: 'Footer',
                    label: '${data.submitLabel}',
                    /**
                     * ⚠ **`data_exchange`: the endpoint opens the request**, exactly as the
                     * checkout footer places the order — so the customer is told on the closing
                     * screen whether it worked, and the handle is spent once.
                     */
                    'on-click-action': {
                        name: 'data_exchange',
                        payload: {
                            subject: '${form.subject}',
                            description: '${form.description}',
                        },
                    },
                },
            ],
        },
    };
}

export const SUPPORT_SCREEN = 'SUPPORT';
export const SUPPORT_NO_CONTEXT_SCREEN = 'SUPPORT_PLAIN';

export const TICKET_FORM_FLOW: FlowDefinition = {
    version: '6.0',
    data_api_version: '3.0',
    routing_model: {
        [SUPPORT_SCREEN]: [NOTICE_SCREEN],
        [SUPPORT_NO_CONTEXT_SCREEN]: [NOTICE_SCREEN],
        [NOTICE_SCREEN]: [],
    },
    screens: [
        supportScreen(SUPPORT_SCREEN, true),
        supportScreen(SUPPORT_NO_CONTEXT_SCREEN, false),
        noticeScreen('tf'),
    ],
};
