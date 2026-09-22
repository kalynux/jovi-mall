import { __CALLBACK_DATA_BYTES, confirmActionId, declineActionId } from './bot-action-id';
import { __IN_APP_HANDLE_PREFIX, newInAppHandle } from '../services/inapp-surface.store';

/**
 * ⭐ **THE GRAMMAR OF THE CHAT CHECKOUT'S CONFIRM PAIR, and the byte budget it depends on.**
 *
 *     yes:co:<checkoutRef>:<addressId>   Place order — a physical basket, to THAT address   57 B
 *     yes:co:<checkoutRef>               Place order — a download, which goes nowhere        32 B
 *     no:co:<checkoutRef>                Not now — writes nothing                            31 B
 *
 * `<checkoutRef>` is the `co` handle `checkout_review` minted (`ia_` + 22 base64url characters
 * today); `<addressId>` is one of the customer's own saved addresses, 24 hex.
 *
 * ── WHY A FILE OF ITS OWN, BESIDE `bot-action-id.ts` ────────────────────────
 * The confirm pair is shared (`yes` / `no` route by CONTEXT — `bot-action-dispatch.ts`), so the
 * builders here go through `confirmActionId('co', …)` with the context as a LITERAL. That is not
 * style: `test-bot-surface` § 20 proves every drawn button is routed by reading the first argument
 * of each `confirmActionId(` call site, and it cannot read one out of a wrapper whose first argument
 * is a variable. A builder in `bot-action-id.ts` returning `token('yes', …)` directly would be a
 * `yes:?` the guard reports as unresolvable. This is the shape `bot-ticket-actions.ts` already takes
 * for `yes:tcl` and `yes:cnc`, for the same reason — builders and parser one file apart, so a suite
 * can prove the two ends of every token agree.
 *
 * ── ⚠ THE BUTTON CARRIES A CREDENTIAL, AND THAT IS WHAT MAKES IT SAFE ───────
 * `bot-action-id.ts` argues that a MINTED checkout handle must never sit in a chat button, because
 * it would be dead on arrival and a live one is an order-placing URL. Both halves are answered here
 * rather than ignored:
 *   - **Dead on arrival is the designed state.** The handle lives ten minutes and a chat message
 *     lives forever, so a stale Place order is ORDINARY. The tap then draws a fresh confirmation
 *     instead of placing (`confirmCheckoutTap`), which is the are-you-sure `yes:cnc` gives a stale
 *     reference. A stale button can never place an order the customer has not just re-read.
 *   - **A live one is useless to anybody else.** The chat place passes the caller's customer id, and
 *     `placeCheckout` refuses a handle minted for someone else AFTER spending it — so a forwarded or
 *     replayed token cannot place an order for its owner, and cannot be tried twice.
 *
 * ── ⚠ THE REF'S LENGTH IS DELIBERATELY NOT PINNED ───────────────────────────
 * Prefix and alphabet, bounded at 64 — the position `bot-ticket-actions.ts` takes for a file handle.
 * A handle minted before a deploy that changed `HANDLE_BYTES` is still live for ten minutes after
 * it, and the store is the authority on whether one is real; this only decides whether the argument
 * is a handle at all. Refusing a live one on its length would turn a customer's Place order into
 * "that button is no longer active" for a reason that is ours.
 */

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** What may follow the handle prefix — base64url, the alphabet `newInAppHandle` writes. */
const HANDLE_BODY = /^[A-Za-z0-9_-]{1,64}$/;

/** Is this the shape of a `co` handle? Prefix and alphabet — see the header for why not length. */
export function isCheckoutRef(value: string): boolean {
    return typeof value === 'string'
        && value.startsWith(__IN_APP_HANDLE_PREFIX)
        && HANDLE_BODY.test(value.slice(__IN_APP_HANDLE_PREFIX.length));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Builders — every one goes through `confirmActionId` / `declineActionId`, which throw past 64
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `yes:co:<checkoutRef>:<addressId>` — or `yes:co:<checkoutRef>` for a download.
 *
 * ⚠ **The address rides the token, never "the default".** The customer tapped a button standing
 * under — or labelled with — one address; placing against whatever the default is at tap time would
 * ship the parcel somewhere the message on their screen does not name. The chat place REQUIRES a
 * named address for a physical basket for exactly this reason (`precheckChatDoor`).
 */
export function checkoutConfirmActionId(checkoutRef: string, addressId: string | null): string {
    assertButtonRef(checkoutRef);
    if (addressId !== null && !OBJECT_ID.test(addressId)) {
        // eslint-disable-next-line no-restricted-syntax -- programming fault, not a request outcome
        throw new Error('[BotSurface] a checkout confirm was built with an address id that is not one');
    }
    return confirmActionId('co', addressId ? `${checkoutRef}:${addressId}` : checkoutRef);
}

/**
 * `no:co:<checkoutRef>` — Not now.
 *
 * ⚠ **It carries the ref although declining writes nothing and checks nothing.** A token says
 * what it was pressed ON (`bot-action-id.ts`'s doctrine), and a bare `no:co` is a Not now about no
 * checkout in particular. The ref authorises nothing here: a stale one declines exactly as well as
 * a fresh one, because refusing a stale "Not now" would refuse the one answer that is always safe.
 */
export function checkoutDeclineActionId(checkoutRef: string): string {
    assertButtonRef(checkoutRef);
    return declineActionId('co', checkoutRef);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parsers — the handler's half. Null, never a throw: the caller answers null with
//  `unknownBotAction()`, so a mangled `yes:co:` reads exactly like a retired verb.
// ─────────────────────────────────────────────────────────────────────────────

/** What a `yes:co` argument asks for. `addressId` null means a download. */
export interface CheckoutConfirmTap {
    checkoutRef: string;
    addressId: string | null;
}

/**
 * Read the argument after `yes:co:` — `<ref>` or `<ref>:<24-hex addressId>`, and nothing else.
 *
 * ⚠ **Strict on the number of parts.** A third segment is refused rather than ignored: a token this
 * service did not build is not one to act on, least of all on the one tap that spends money.
 */
export function parseCheckoutConfirm(argument: string): CheckoutConfirmTap | null {
    const parts = argument.split(':');
    if (parts.length === 1) {
        return isCheckoutRef(parts[0]) ? { checkoutRef: parts[0], addressId: null } : null;
    }
    if (parts.length === 2) {
        return isCheckoutRef(parts[0]) && OBJECT_ID.test(parts[1])
            ? { checkoutRef: parts[0], addressId: parts[1] }
            : null;
    }
    return null;
}

/** Read the argument after `no:co:` — the ref alone. */
export function parseCheckoutDecline(argument: string): string | null {
    return isCheckoutRef(argument) ? argument : null;
}

function assertButtonRef(checkoutRef: string): void {
    if (!isCheckoutRef(checkoutRef)) {
        // eslint-disable-next-line no-restricted-syntax -- programming fault, not a request outcome
        throw new Error('[BotSurface] a checkout button was built with something that is not a checkout handle');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⭐ THE BYTE BUDGET — asserted at import, so a regression stops the boot
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_ADDRESS_ID = 'f'.repeat(24);

/**
 * Every checkout token measured against Telegram's cap, at a handle of the given length.
 *
 * ⚠ **Measured through the BUILDERS, not restated.** A sample written as a string here would be a
 * second composition of the token that could fit while the real one does not. `token()` throws past
 * 64 bytes, so a row that would overflow is reported by name rather than by a number.
 *
 * ⚠ **Pure and parameterised by the one length that can move**, so a suite can hand it a longer
 * handle and watch it name the row that would break. That is the proof this guard bites; the call at
 * the bottom of this file is the proof it runs.
 */
export function checkoutTokenBudgetProblems(input: { handleLength: number }): string[] {
    const body = 'A'.repeat(Math.max(1, input.handleLength - __IN_APP_HANDLE_PREFIX.length));
    const ref = `${__IN_APP_HANDLE_PREFIX}${body}`;

    const rows: Array<[name: string, build: () => string]> = [
        ['the Place order button with an address', () => checkoutConfirmActionId(ref, SAMPLE_ADDRESS_ID)],
        ['the Place order button for a download', () => checkoutConfirmActionId(ref, null)],
        ['the Not now button', () => checkoutDeclineActionId(ref)],
    ];

    const problems: string[] = [];
    for (const [name, build] of rows) {
        try {
            const bytes = Buffer.byteLength(build(), 'utf8');
            // Unreachable while `token()` throws first; kept so the rule does not rest on that.
            if (bytes > __CALLBACK_DATA_BYTES) problems.push(`${name} is ${bytes} bytes, cap is ${__CALLBACK_DATA_BYTES}`);
        } catch {
            problems.push(`${name} does not fit ${__CALLBACK_DATA_BYTES} bytes at a ${ref.length}-character handle`);
        }
    }
    return problems;
}

/**
 * Refuse to load when a checkout button could not be carried.
 *
 * ⚠ **Against a handle the STORE generated** (`newInAppHandle`), never a length restated here —
 * the only way a change to the handle is measured the moment it is made.
 */
export function assertCheckoutTokenBudgets(): void {
    const problems = checkoutTokenBudgetProblems({ handleLength: newInAppHandle().length });
    if (problems.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] a checkout button no longer fits Telegram's cap: ${problems.join('; ')}`);
    }
}

assertCheckoutTokenBudgets();
