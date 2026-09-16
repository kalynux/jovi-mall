/**
 * What Meta sends inside the encrypted envelope, and what we are allowed to send back.
 *
 * ── PURE, AND THAT IS WHY THE HEALTH CHECK IS TESTABLE ──────────────────────
 * `decryptFlowRequest` hands this module a parsed object and nothing else — no request, no
 * clock, no store. So the entire decision table below is assertable offline, which matters
 * more here than usual: **the health check is the gate on publishing a Flow at all.** Meta
 * refuses to publish against an endpoint whose ping it cannot complete, and the WhatsApp
 * number this platform sends from is currently dead — so the only way to know the handshake
 * is right before that clears is to prove it against the documented shape.
 *
 * ── THE THREE ACTIONS THAT ARE NOT A SCREEN ─────────────────────────────────
 * `ping`, `error` and an unreadable payload are answered here and never reach a screen
 * handler. Each has a rule that is easy to get wrong in the same direction:
 *
 *   - **`ping` carries no meaningful `flow_token`** and must not be made to. It is Meta's
 *     infrastructure probing ours, not a customer — resolving a session for it would fail
 *     every health check and make the endpoint unpublishable, while looking like correct
 *     authentication.
 *   - **`error` is ACKNOWLEDGED with a 200**, not treated as a failure. It is Meta telling us
 *     their client hit a problem; answering anything else makes them retry a report of a
 *     failure, which is a retry loop over bad news.
 *   - **`version` is ECHOED, never asserted.** Meta bumps the data-API version and an
 *     endpoint that refuses an unfamiliar one breaks every live Flow the moment they do.
 *     We are not the party that gets to decide which version is current.
 */

/** Meta's reserved terminal screen name. Returning it closes the Flow on the handset. */
export const FLOW_TERMINAL_SCREEN = 'SUCCESS';

/** The data-API version we answer with when a request carries none. */
const FALLBACK_VERSION = '3.0';

/**
 * A request that is ours to answer without touching a session.
 *
 * `malformed` is here rather than in the crypto verdict because the bytes decrypted fine —
 * the plaintext simply was not a Flow request. That is a different fault from a bad tag and
 * gets a different status.
 */
export type FlowControlRequest =
    | { kind: 'ping'; version: string }
    | { kind: 'error'; version: string; errorKey: string | null }
    | { kind: 'malformed' };

/** A request that names a screen and therefore needs a session and a handler. */
export interface FlowScreenRequest {
    kind: 'screen';
    version: string;
    /** `INIT`, `BACK` or `data_exchange`. Passed through — the handler decides what it means. */
    action: string;
    /**
     * The screen the customer is on. ⚠ Absent on `INIT` under `data_exchange`, because in
     * that mode Meta is asking US which screen comes first — that is the whole reason
     * checkout uses it.
     */
    screen: string | null;
    /** Whatever the form collected. Entirely untrusted: it is typed by the handset. */
    data: Record<string, unknown>;
    /**
     * The in-app surface handle (`ia_…`).
     *
     * ⚠ **Not a new identifier.** It is the same handle the Telegram Mini App carries in its
     * URL, minted by `inAppSurfaceStore` and passed to the renderer as `flow.token`, so one
     * customer session serves both channels. See the store's docstring for why a second
     * scheme was rejected.
     */
    flowToken: string | null;
}

export type FlowRequest = FlowControlRequest | FlowScreenRequest;

const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;

/**
 * Classify one decrypted payload.
 *
 * ⚠ **Never throws and never narrows on trust.** Everything in here arrived from the public
 * internet through a cipher, and a cipher proves the sender held a key — not that the
 * contents are well-formed.
 */
export function classifyFlowRequest(payload: Record<string, unknown>): FlowRequest {
    const version = asString(payload.version) ?? FALLBACK_VERSION;
    const action = asString(payload.action);

    if (action === null) return { kind: 'malformed' };

    if (action === 'ping') return { kind: 'ping', version };

    if (action === 'error') {
        const data = payload.data;
        const errorKey =
            typeof data === 'object' && data !== null && !Array.isArray(data)
                ? asString((data as Record<string, unknown>).error_key)
                : null;
        return { kind: 'error', version, errorKey };
    }

    const data = payload.data;
    return {
        kind: 'screen',
        version,
        action,
        screen: asString(payload.screen),
        data:
            typeof data === 'object' && data !== null && !Array.isArray(data)
                ? (data as Record<string, unknown>)
                : {},
        flowToken: asString(payload.flow_token),
    };
}

/** The body of a response, before encryption. Meta reads `version`, `screen` and `data`. */
export interface FlowResponseBody {
    version: string;
    screen: string;
    data: Record<string, unknown>;
}

/**
 * The health-check answer.
 *
 * ⚠ **The literal `{ data: { status: 'active' } }` is Meta's, not ours**, and it carries no
 * `screen`. Adding one, renaming `status`, or wrapping it in this service's `{success, data}`
 * envelope all produce the same outcome: Meta reports the endpoint as unhealthy and refuses
 * to publish, with a message that does not say which field was wrong.
 */
export function pingResponse(version: string): Record<string, unknown> {
    return { version, data: { status: 'active' } };
}

/**
 * The acknowledgement for an `error` action.
 *
 * Deliberately says only that we heard it. There is nothing useful to send back — the client
 * has already failed — and anything we put in `data` would be rendered to a customer who is
 * looking at an error screen.
 */
export function errorAcknowledgement(version: string): Record<string, unknown> {
    return { version, data: { acknowledged: true } };
}

/** An ordinary screen answer: here is the next screen and the data to draw it with. */
export function screenResponse(
    version: string,
    screen: string,
    data: Record<string, unknown>,
): FlowResponseBody {
    return { version, screen, data };
}

/**
 * The closing answer — the Flow finishes and the handset returns to the thread.
 *
 * ⚠ **`extension_message_response` is the only part of a Flow's result that reaches the
 * conversation**, and it arrives as an inbound `interactive.nfm_reply` message rather than on
 * this endpoint. So whatever is put in `params` here is what a later inbound handler has to
 * work from — and at the time of writing **nothing in this codebase reads `nfm_reply` at
 * all**, which is tracked separately as unassigned scope.
 *
 * `flow_token` is echoed into it deliberately: it is the only thing tying the completion
 * message back to the customer session that produced it, and the inbound handler will have no
 * other way to know whose checkout just finished.
 */
export function completionResponse(
    version: string,
    flowToken: string | null,
    params: Record<string, unknown>,
): FlowResponseBody {
    return {
        version,
        screen: FLOW_TERMINAL_SCREEN,
        data: {
            extension_message_response: {
                params: {
                    ...params,
                    ...(flowToken ? { flow_token: flowToken } : {}),
                },
            },
        },
    };
}
