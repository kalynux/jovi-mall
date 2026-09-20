import { __CALLBACK_DATA_BYTES, confirmActionId, declineActionId, ticketActionId } from './bot-action-id';
import { mintConfirmationRef } from './bot-confirmation-ref';
import { INBOUND_FILE_HANDLE_LENGTH } from '../services/inbound-file.store';

/**
 * ⭐ **THE GRAMMAR OF THE `tkt` VERB, and every byte budget a support button depends on.**
 *
 * ── WHY ONE PURE FILE ───────────────────────────────────────────────────────
 * `tkt` has one owner (Stream G), so the dispatcher routes it by the verb alone and hands this
 * stream the whole argument (`domain/bot-action-dispatch.ts`). That argument now has seven shapes,
 * and two of them carry a single-use file handle. Parsing them inline in a controller would put
 * the grammar somewhere no suite can reach — controllers pull in `orders/`, and anything that does
 * hangs bare `ts-node` at import. Here the builders and the parser sit side by side, so the two
 * ends of every token are one file apart and a suite can prove they agree.
 *
 * ── THE SHAPES ──────────────────────────────────────────────────────────────
 *     tkt:<ticketId>                  one request: status, latest replies, buttons       28 B
 *     tkt:<ticketId>:rp               Reply / Reply here — the assistant takes the turn  31 B
 *     tkt:<ticketId>:ph               Attach photo — "send it here"                      31 B
 *     tkt:<ticketId>:cl               Close — the are-you-sure                           31 B
 *     tkt:<ticketId>:<att_…>          put the file just sent on this request             55 B
 *     tkt:list                        the customer's requests                            8 B
 *     tkt:new                         the support form, no subject                       7 B
 *     tkt:new:<att_…>                 the support form, carrying the file just sent      34 B
 *     tkt:new:rd|ad|hp:<orderId>      the support form, pre-filled for a delivery        35 B
 *     yes:tcl:<ticketId>:<ref>        close it — signed, ten minutes                     62 B
 *     no:tcl:<ticketId>               keep it                                            31 B
 *     yes:cnc:<orderId>:<ref>         cancel the order — signed, ten minutes             62 B
 *     no:cnc:<orderId>                keep it                                            31 B
 *
 * ⚠ **The two-letter sub-words (`rp`, `ph`, `cl`) are a budget decision, not a style.** Telegram
 * TRUNCATES a `callback_data` over 64 bytes in silence and the button then does nothing; the
 * customer never learns why. Nothing here is near the cap except the two confirm tokens and the
 * file-carrying row, which is exactly why those three are asserted at import below.
 *
 * ⚠ **A ticket id and a file handle are told apart by SHAPE, never by position alone.** An id is 24
 * hex characters; a handle begins `att_`. The two cannot collide, which is what lets
 * `tkt:<ticketId>:<att_…>` and `tkt:<ticketId>:rp` share one arity.
 */

/** The three delivery topics a failed-delivery card can open support about. */
export const SUPPORT_TOPIC_CODES = Object.freeze(['rd', 'ad', 'hp'] as const);
export type SupportTopicCode = (typeof SUPPORT_TOPIC_CODES)[number];

/** What a `tkt` argument asks for, once read. */
export type TicketTap =
    | { kind: 'show'; ticketId: string }
    | { kind: 'reply'; ticketId: string }
    | { kind: 'photo'; ticketId: string }
    | { kind: 'close'; ticketId: string }
    | { kind: 'attach'; ticketId: string; attachmentRef: string }
    | { kind: 'list' }
    | {
          kind: 'new';
          topic: SupportTopicCode | null;
          orderId: string | null;
          attachmentRef: string | null;
      };

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * The shape of an inbound-file handle as a BUTTON may carry it.
 *
 * ⚠ **Prefix and alphabet, deliberately not the length.** `inbound-file.store.ts` explains why its
 * own `consume` does the same: a handle minted before a length change is still live for thirty
 * minutes after it. The store is the authority on whether a handle is real; this only decides
 * whether the argument is one at all. Bounded at 64 so an absurd argument is refused here rather
 * than digested.
 */
const FILE_HANDLE = /^att_[A-Za-z0-9_-]{1,64}$/;

const SUB_WORDS = Object.freeze({ rp: 'reply', ph: 'photo', cl: 'close' } as const);

/**
 * Read a `tkt` argument, or null when it is not one of ours.
 *
 * ⚠ **Null, never a throw** — the caller answers null with `unknownBotAction()`, the same refusal an
 * unknown verb gets, so a mangled `tkt:` and a retired `zzz:` read identically to the customer.
 */
export function parseTicketTap(argument: string): TicketTap | null {
    const parts = argument.split(':');
    const [head, second, third, ...extra] = parts;
    if (extra.length > 0) return null;

    if (head === 'list') return parts.length === 1 ? { kind: 'list' } : null;

    if (head === 'new') {
        if (second === undefined) return { kind: 'new', topic: null, orderId: null, attachmentRef: null };
        if (third === undefined) {
            return FILE_HANDLE.test(second)
                ? { kind: 'new', topic: null, orderId: null, attachmentRef: second }
                : null;
        }
        return (SUPPORT_TOPIC_CODES as readonly string[]).includes(second) && OBJECT_ID.test(third)
            ? { kind: 'new', topic: second as SupportTopicCode, orderId: third, attachmentRef: null }
            : null;
    }

    if (!OBJECT_ID.test(head ?? '') || third !== undefined) return null;
    if (second === undefined) return { kind: 'show', ticketId: head };
    if (FILE_HANDLE.test(second)) return { kind: 'attach', ticketId: head, attachmentRef: second };

    const sub = SUB_WORDS[second as keyof typeof SUB_WORDS];
    return sub ? { kind: sub, ticketId: head } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Builders — every one goes through `ticketActionId` / `confirmActionId`, which throw past 64
// ─────────────────────────────────────────────────────────────────────────────

export function ticketCardActionId(ticketId: string): string {
    return ticketActionId(ticketId);
}

export function ticketReplyActionId(ticketId: string): string {
    return ticketActionId(`${ticketId}:rp`);
}

export function ticketPhotoActionId(ticketId: string): string {
    return ticketActionId(`${ticketId}:ph`);
}

export function ticketCloseActionId(ticketId: string): string {
    return ticketActionId(`${ticketId}:cl`);
}

export function ticketListActionId(): string {
    return ticketActionId('list');
}

/** `tkt:new` — the support form with nothing pre-chosen; the support ladder decides the subject. */
export function supportFormActionId(): string {
    return ticketActionId('new');
}

/** `tkt:new:<topic>:<orderId>` — the failed-delivery card's two support buttons, and Get help. */
export function supportTopicActionId(topic: SupportTopicCode, orderId: string): string {
    return ticketActionId(`new:${topic}:${orderId}`);
}

/**
 * `tkt:<ticketId>:<att_…>` and `tkt:new:<att_…>` — the rows of "which request is this file for?".
 *
 * ⚠ **The handle is checked here as well as by `token()`'s length cap, because the two fail
 * differently.** An over-long token throws; a handle with a `:` in it would build a token that
 * PARSES as something else. Handles are minted by this service, so either is a programming fault.
 */
export function attachToTicketActionId(ticketId: string, attachmentRef: string): string {
    assertButtonHandle(attachmentRef);
    return ticketActionId(`${ticketId}:${attachmentRef}`);
}

export function supportFormWithFileActionId(attachmentRef: string): string {
    assertButtonHandle(attachmentRef);
    return ticketActionId(`new:${attachmentRef}`);
}

/** `yes:tcl:<ticketId>:<ref>` / `no:tcl:<ticketId>` — the close confirm. The decline carries no ref. */
export function ticketCloseConfirmActionId(ticketId: string, ref: string): string {
    return confirmActionId('tcl', `${ticketId}:${ref}`);
}

export function ticketCloseDeclineActionId(ticketId: string): string {
    return declineActionId('tcl', ticketId);
}

/** `yes:cnc:<orderId>:<ref>` / `no:cnc:<orderId>` — the order-cancel confirm. */
export function orderCancelConfirmActionId(orderId: string, ref: string): string {
    return confirmActionId('cnc', `${orderId}:${ref}`);
}

export function orderCancelDeclineActionId(orderId: string): string {
    return declineActionId('cnc', orderId);
}

/**
 * Split a confirm argument `<id>:<ref>`, or null.
 *
 * ⚠ **A missing ref is null, not "unsigned and therefore fine".** A bare `yes:cnc:<orderId>` is the
 * shape before refs existed; it was never deployed, and accepting it would re-open exactly the
 * three-weeks-later tap the ref exists to refuse.
 */
export function splitConfirmArgument(argument: string): { id: string; ref: string } | null {
    const colon = argument.indexOf(':');
    if (colon < 0) return null;
    const id = argument.slice(0, colon);
    const ref = argument.slice(colon + 1);
    return OBJECT_ID.test(id) && ref.length > 0 ? { id, ref } : null;
}

function assertButtonHandle(attachmentRef: string): void {
    if (!FILE_HANDLE.test(attachmentRef)) {
        // eslint-disable-next-line no-restricted-syntax -- programming fault, not a request outcome
        throw new Error('[BotSurface] a file handle that cannot ride a button was given to a tkt builder');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ⭐ THE BYTE BUDGET — asserted at import, so a regression stops the boot
// ─────────────────────────────────────────────────────────────────────────────

/** A 24-hex id, the only id shape any of these tokens carries. */
const SAMPLE_ID = 'f'.repeat(24);

/**
 * Every token above whose length depends on something OUTSIDE this file, measured against the cap.
 *
 * ⚠ **Pure, and parameterised by the two lengths that can move**, so a suite can hand it the old
 * 47-character handle and watch it name the row that would break. That is the proof this guard
 * bites; the call at the bottom of this file is the proof it runs.
 *
 * Returns one line per token over the cap, empty when all fit.
 */
export function ticketTokenBudgetProblems(input: {
    handleLength: number;
    confirmationRefLength: number;
}): string[] {
    const handle = `att_${'A'.repeat(Math.max(0, input.handleLength - 'att_'.length))}`;
    const ref = 'r'.repeat(input.confirmationRefLength);

    const worst: Array<[name: string, token: string]> = [
        ['tkt:<ticketId>:<att_>', `tkt:${SAMPLE_ID}:${handle}`],
        ['tkt:new:<att_>', `tkt:new:${handle}`],
        ['yes:tcl:<ticketId>:<ref>', `yes:tcl:${SAMPLE_ID}:${ref}`],
        ['yes:cnc:<orderId>:<ref>', `yes:cnc:${SAMPLE_ID}:${ref}`],
    ];

    return worst
        .map(([name, token]) => [name, Buffer.byteLength(token, 'utf8')] as const)
        .filter(([, bytes]) => bytes > __CALLBACK_DATA_BYTES)
        .map(([name, bytes]) => `${name} is ${bytes} bytes, cap is ${__CALLBACK_DATA_BYTES}`);
}

/**
 * The longest confirmation ref this service will mint before 2100.
 *
 * ⚠ **Measured by minting one, not computed.** A ref is `base36(expiry) "." base64url(mac)`, and the
 * expiry half GROWS: six characters today, seven from 2039. Minting at a far-future clock with a
 * throwaway key gives the real length without restating the construction here, so a change to the
 * MAC size in `bot-confirmation-ref.ts` is measured rather than missed. The key is not a secret —
 * this ref is discarded unread.
 */
export function longestConfirmationRefLength(): number {
    return mintConfirmationRef(
        'ticket-close',
        { userId: SAMPLE_ID, channel: 'telegram' },
        SAMPLE_ID,
        Date.UTC(2100, 0, 1),
        'byte-budget-probe',
    ).length;
}

/**
 * Refuse to load when a support button could not be carried.
 *
 * ⚠ **At import, not at request time.** `token()` already throws on an oversized token — but it
 * throws while BUILDING a reply, so the fault would surface as every photo a customer sends failing
 * to offer its "which request" list, discovered one customer at a time. Here it stops the process
 * for the session that made the change.
 */
export function assertTicketTokenBudgets(): void {
    const problems = ticketTokenBudgetProblems({
        handleLength: INBOUND_FILE_HANDLE_LENGTH,
        confirmationRefLength: longestConfirmationRefLength(),
    });
    if (problems.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- boot assertion, no request in flight
        throw new Error(`[BotSurface] a support button no longer fits Telegram's cap: ${problems.join('; ')}`);
    }
}

assertTicketTokenBudgets();
