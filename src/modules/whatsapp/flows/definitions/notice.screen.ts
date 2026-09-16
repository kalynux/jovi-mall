import type { InAppSurfaceKind } from '../../../bot-surface/services/inapp-surface.store';
import type { FlowScreen } from './flow-definition.types';

/**
 * The title every screen shows in WhatsApp's navigation bar.
 *
 * ⚠ **The brand, not a localised heading, and that is forced rather than chosen.** Meta's Flow
 * JSON reference doesn't confirm that a screen `title` can be dynamic, and a static English
 * word ("Products", "Checkout") would sit above French and Arabic content for every customer
 * who isn't English. The brand reads the same in all five languages. The localised heading is a
 * `TextHeading` inside the screen, where dynamic text is documented.
 *
 * If a later check confirms dynamic titles, this becomes `${data.screenTitle}`. Changing it is a
 * republish of all three Flows.
 */
export const FLOW_SCREEN_TITLE = 'wi-mall';

/** Screen id of the shared notice screen, the same in every Flow. */
export const NOTICE_SCREEN = 'NOTICE';

/**
 * One sentence and a button back to the chat, for every state that is not the screen itself:
 * an empty listing, a product that's gone, a basket with no delivery address, a checkout that
 * has been placed.
 *
 * ── WHY ONE SHARED SCREEN AND NOT A STATE PER FLOW ──────────────────────────
 * Meta allows several terminal screens, so each state could have its own. They'd all be the
 * same component pair, and three near-copies drift: one gains a caption, another loses its
 * close button. So the SENTENCE varies, chosen by the endpoint from the five-language screen
 * copy, and the screen doesn't.
 *
 * ⚠ **The payload stamps which Flow closed and names no outcome the customer could forge into
 * an action.** `flow_complete` reports and never writes, so a stamp can do no more than route
 * a thank-you. `outcome: 'notice'` tells it this wasn't a choice.
 *
 * `flow_token` is not in the payload. Meta's reference says the business receives the
 * completion "together with the flow_token and all of the other parameters from the payload".
 */
export function noticeScreen(kind: InAppSurfaceKind): FlowScreen {
    return {
        id: NOTICE_SCREEN,
        title: FLOW_SCREEN_TITLE,
        terminal: true,
        data: {
            message: {
                type: 'string',
                __example__: 'This page is no longer available. Ask me again in the chat and I will open a fresh one.',
            },
            closeLabel: { type: 'string', __example__: 'Back to chat' },
        },
        layout: {
            type: 'SingleColumnLayout',
            children: [
                { type: 'TextBody', text: '${data.message}' },
                {
                    type: 'Footer',
                    label: '${data.closeLabel}',
                    'on-click-action': {
                        name: 'complete',
                        payload: { screen: kind, outcome: 'notice' },
                    },
                },
            ],
        },
    };
}
