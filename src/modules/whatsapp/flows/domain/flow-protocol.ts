/**
 * What Meta sends inside the encrypted envelope, and what we are allowed to send back.
 *
 * ── ⚠ EVERY SHAPE HERE IS VERIFIED AGAINST TWO PRIMARY SOURCES ──────────────
 * Meta's endpoint guide (`developers.facebook.com/docs/whatsapp/flows/guides/
 * implementingyourflowendpoint`) and Meta's own reference endpoint
 * (`github.com/WhatsApp/WhatsApp-Flows-Tools`, `examples/endpoint/nodejs/basic/src/`), read on
 * 2026-09-16. ⛔ **The first version of this file was written from memory and got FOUR things
 * wrong**, all of them shipped, and the suite pinned two of them as correct:
 *
 *   1. The ping answer carried a `version` field. Meta's answer is exactly
 *      `{ data: { status: 'active' } }` and nothing else.
 *   2. Client errors were detected as `action: 'error'`. **No such action exists.** A client
 *      error arrives as an ordinary `INIT` or `data_exchange` whose `data` carries `error` and
 *      `error_message`. Written the old way, every error report was misread as a screen request.
 *   3. Screen and completion answers echoed `version`. Neither documented shape has one.
 *   4. The completion's `flow_token` was optional. Meta marks it **Required**.
 *
 * The health check is the gate on publishing a Flow at all, and the number could not publish
 * when this was first written, so none of the four could have been caught by trying. That's
 * the reason this header exists: a protocol answered from memory passes a suite written from
 * the same memory.
 *
 * ── PURE, SO THE WHOLE DECISION TABLE IS TESTABLE OFFLINE ───────────────────
 * `decryptFlowRequest` hands this module a parsed object and nothing else — no request, no
 * clock, no store.
 */

/** Meta's reserved terminal screen name. Returning it closes the Flow on the handset. */
export const FLOW_TERMINAL_SCREEN = 'SUCCESS';

/**
 * A request that is ours to answer without touching a session.
 *
 * `malformed` is here rather than in the crypto verdict because the bytes decrypted fine; the
 * plaintext simply wasn't a Flow request. That's a different fault from a bad tag and gets a
 * different status.
 */
export type FlowControlRequest =
    | { kind: 'ping' }
    /**
     * A client error report.
     *
     * ⚠ **Detected by `data.error` being present, whatever the action.** Meta's guide gives the
     * shape as `action: "data_exchange | INIT"` with `data: { error, error_message }`, and the
     * reference endpoint tests `data?.error`, not the action. It carries a `flow_token`, but
     * it is answered here, before any session is resolved: an acknowledgement authorises
     * nothing, and resolving a session for it would turn a report of a failure into a second
     * failure when the handle has lapsed.
     */
    | { kind: 'error'; errorKey: string | null; errorMessage: string | null }
    | { kind: 'malformed' };

/** A request that names a screen and therefore needs a session and a handler. */
export interface FlowScreenRequest {
    kind: 'screen';
    /** `INIT`, `BACK` or `data_exchange`. Passed through; the handler decides what it means. */
    action: string;
    /**
     * The screen the customer is on.
     *
     * ⚠ **Absent on `INIT`.** Meta's guide: "`screen` may not be populated". On INIT Meta is
     * asking US which screen comes first, and a handler that requires one refuses exactly the
     * mode every screen here opens with.
     */
    screen: string | null;
    /** Whatever the form collected. Entirely untrusted: it is typed by the handset. */
    data: Record<string, unknown>;
    /**
     * The in-app surface handle (`ia_…`). **Required by Meta on INIT and data_exchange.**
     *
     * ⚠ **Not a new identifier.** It is the same handle the Telegram Mini App carries in its URL,
     * minted by `inAppSurfaceStore`, so one customer session serves both channels.
     */
    flowToken: string | null;
}

export type FlowRequest = FlowControlRequest | FlowScreenRequest;

const asString = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

/**
 * Classify one decrypted payload.
 *
 * ⚠ **Never throws and never narrows on trust.** Everything in here arrived from the public
 * internet through a cipher, and a cipher proves the sender held a key, not that the contents
 * are well-formed.
 *
 * ⚠ **The version is not read at all.** An earlier draft echoed it back into every answer,
 * and no documented answer carries one. Not reading it removes the temptation.
 */
export function classifyFlowRequest(payload: Record<string, unknown>): FlowRequest {
    const action = asString(payload.action);
    if (action === null) return { kind: 'malformed' };

    if (action === 'ping') return { kind: 'ping' };

    const data = asRecord(payload.data);

    /**
     * ⚠ **Checked BEFORE the screen branch, and the order is the fix.** A client error arrives
     * with action `INIT` or `data_exchange`, the same two actions a screen request uses, so a
     * classifier that tests for a screen first will never see an error report. That is exactly
     * how the previous version handled every one.
     */
    if (data.error !== undefined && data.error !== null) {
        return {
            kind: 'error',
            errorKey: asString(data.error),
            errorMessage: asString(data.error_message),
        };
    }

    return {
        kind: 'screen',
        action,
        screen: asString(payload.screen),
        data,
        flowToken: asString(payload.flow_token),
    };
}

/** What we send back, before encryption. Documented shapes only: `screen` and `data`. */
export interface FlowResponseBody {
    screen: string;
    data: Record<string, unknown>;
}

/**
 * The health-check answer, exactly as Meta documents it.
 *
 * ⚠ **`{ data: { status: 'active' } }` and not one field more.** Meta's guide calls it the
 * "Required response body (exact)". A `version`, a `screen`, or this service's
 * `{ success, data }` envelope all leave the endpoint unpublishable, and Meta's refusal does not
 * say which field was wrong. The first version of this function added a `version`.
 */
export function pingResponse(): Record<string, unknown> {
    return { data: { status: 'active' } };
}

/**
 * The acknowledgement for a client error report.
 *
 * Deliberately says only that we heard it. The client has already failed, and anything put in
 * `data` would be rendered to a customer who is looking at an error screen.
 */
export function errorAcknowledgement(): Record<string, unknown> {
    return { data: { acknowledged: true } };
}

/**
 * An ordinary screen answer: here is the next screen and the data to draw it with.
 *
 * ⚠ **`error_message` in `data` is Meta's way to keep a customer on the screen and say
 * something went wrong**: the guide says it "redirects the user to `<SCREEN_NAME>` and
 * triggers a snackbar error". Use it for a correction the customer can make, like a mistyped
 * number. Never use it for anything after a checkout handle is spent, where the only honest
 * answer is "look in the chat".
 */
export function screenResponse(
    screen: string,
    data: Record<string, unknown>,
    errorMessage?: string,
): FlowResponseBody {
    return {
        screen,
        data: errorMessage ? { ...data, error_message: errorMessage } : data,
    };
}

/**
 * The closing answer: the Flow finishes and the handset returns to the thread.
 *
 * ⚠ **`flow_token` is REQUIRED**, and the parameter is `string`, not `string | null`, so a
 * caller cannot omit it by accident. Meta's guide marks
 * `data.extension_message_response.params.flow_token` "**Required.**" It is also the only
 * thing tying the completion message back to the session that produced it.
 *
 * ⚠ **It is spread LAST**, so no param can overwrite it. A completion param named `flow_token`
 * would otherwise attribute the finished checkout to whatever that param said.
 *
 * `extension_message_response.params` is what reaches the conversation, as an inbound
 * `interactive.nfm_reply`, handled by `commands/flow-complete.command.ts`.
 */
export function completionResponse(
    flowToken: string,
    params: Record<string, unknown>,
): FlowResponseBody {
    return {
        screen: FLOW_TERMINAL_SCREEN,
        data: {
            extension_message_response: {
                params: { ...params, flow_token: flowToken },
            },
        },
    };
}

/**
 * The body that goes WITH an HTTP 427: the token is unusable, the Flow is disabled, and this
 * sentence is shown to the customer.
 *
 * ⚠ **Encrypted like any other answer.** Meta's reference endpoint sends
 * `encryptResponse({ error_msg }, …)` with the 427, not a bare status. A bare 427 still ends the
 * Flow, but the customer sees nothing they can act on. This one tells them to go back to the
 * chat.
 */
export function tokenUnusableBody(message: string): Record<string, unknown> {
    return { error_msg: message };
}
