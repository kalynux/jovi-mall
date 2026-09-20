/**
 * Test: STREAM G — orders, parcels and delivery, in the chat.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework). DB-free.
 *
 * ── ⚠ THE CONTROLLER IS READ AS TEXT, NEVER IMPORTED ────────────────────────
 * `bot-order.controller.ts` reaches `orders/`, `shipments/` and `cod/` services, which do work at
 * import and hang bare `ts-node` with no output at all — a run that prints nothing reads as a broken
 * test rather than as an unimportable module (found by backend-2d, 2026-09-16). So the controller is
 * scanned, and only the pure domain files are imported: the status table, the tap vocabulary and the
 * dispatch contract.
 *
 * ── ⚠ EVERY SCAN IS PROVEN TO BITE ──────────────────────────────────────────
 * A "must" or "must not" scan passes vacuously the day the code it guards moves somewhere it does not
 * look — three guards on this surface did exactly that on one afternoon. So each scan below is a
 * named predicate over source text, run once against the real file (must pass) and once against a
 * deliberately broken copy (must fail). A mutation that no longer applies is itself a failure: it
 * means the text the guard depends on has changed and the guard needs re-reading.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *   - The delivery-code disclosure shape (`discloseCodCode` and its two doors) — backend-14's guard
 *     in `test:bot-surface` owns it. One copy of a guard, not two.
 *   - `pending` and `processing` landing in different buckets — backend-4d's `test:inapp-orders`
 *     pins it, with its own bite-proof, because their screen is the other reader of that table.
 *
 * Run: npm run test:inapp-fulfilment
 */
import fs from 'fs';
import path from 'path';
import {
    __CALLBACK_DATA_BYTES,
    codCodeActionId,
    confirmActionId,
    declineActionId,
    openSurfaceActionId,
    orderActionId,
    orderCancelActionId,
    orderShipmentsActionId,
    parseBotActionId,
    shipmentActionId,
    trackActionId,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { actionKeyOf } from '../../src/modules/bot-surface/domain/bot-action-dispatch';
import {
    attachToTicketActionId,
    longestConfirmationRefLength,
    orderCancelConfirmActionId,
    orderCancelDeclineActionId,
    supportFormActionId,
    supportFormWithFileActionId,
    supportTopicActionId,
    ticketCardActionId,
    ticketCloseActionId,
    ticketCloseConfirmActionId,
    ticketCloseDeclineActionId,
    ticketListActionId,
    ticketPhotoActionId,
    ticketReplyActionId,
} from '../../src/modules/bot-surface/domain/bot-ticket-actions';
import { INBOUND_FILE_HANDLE_LENGTH } from '../../src/modules/bot-surface/services/inbound-file.store';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import {
    ORDER_CASH_ON_DELIVERY_COPY,
    ORDER_PAYMENT_COPY,
    ORDER_STATUS_UNAVAILABLE_COPY,
    assertOrderStatusCopyComplete,
    botFulfillmentStateLabel,
    botPaymentStateLabel,
    toBotOrderPaymentState,
} from '../../src/modules/bot-surface/domain/bot-order-status-copy';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const CONTROLLER_PATH = path.join(
    __dirname,
    '../../src/modules/bot-surface/controllers/bot-order.controller.ts',
);

/** CRLF folded first — the tree is edited from Windows and a `\r` breaks every multi-line match. */
const CONTROLLER = fs.readFileSync(CONTROLLER_PATH, 'utf8').replace(/\r\n/g, '\n');

/**
 * The support half of this stream, scanned as a SECOND span.
 *
 * ⚠ **This exists because the `tkt` handlers MOVED**, and that is the sixth guard shape: a scan of
 * one file goes vacuously green when the code it guards is extracted elsewhere. `ticketTap` was in
 * the order controller until phase 8; every "no tap swallows an error" rule has to follow it, so both
 * files are read and the section below asserts each handler is found in the file that should hold it.
 */
const TICKET_CONTROLLER_PATH = path.join(
    __dirname,
    '../../src/modules/bot-surface/controllers/bot-ticket.controller.ts',
);

const TICKET_CONTROLLER = fs.readFileSync(TICKET_CONTROLLER_PATH, 'utf8').replace(/\r\n/g, '\n');

/** Block and line comments removed, so a guard cannot be satisfied by a sentence about the code. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Where a `static <name> =` member or a top-level `function <name>(` declaration begins — the start
 * of its own line — or -1.
 *
 * ⚠ **Plain string search, not a built `RegExp`.** The repository bans `new RegExp(...)` outright
 * (`no-restricted-syntax`), escaped or not, and a name interpolated into a pattern is exactly what
 * that rule exists to stop.
 *
 * ⚠ **The start is the declaration's OWN line.** Stripping comments leaves runs of blank lines, and
 * this helper's first version began its match at the first of them — so the search for the NEXT
 * declaration found this one, and every region came back two characters long: seven assertions
 * reporting the real controller broken when it was the slicer. The bite-proofs caught it, by
 * reporting the swallowed-error guard as vacuous.
 */
function declarationStart(code: string, name: string): number {
    const member = code.indexOf(`static ${name} =`);
    if (member >= 0) return code.lastIndexOf('\n', member) + 1;

    let from = 0;
    for (;;) {
        const at = code.indexOf(`function ${name}(`, from);
        if (at < 0) return -1;
        const lineStart = code.lastIndexOf('\n', at) + 1;
        // Only whitespace and the two modifiers may precede it — never a call like `x.function name(`.
        if (/^[ \t]*(?:export )?(?:async )?$/.test(code.slice(lineStart, at))) return lineStart;
        from = at + 1;
    }
}

/**
 * The body of one top-level function or `static X =` member, comments stripped — or `null` when it
 * does not exist, which every caller treats as a failure rather than as "nothing to find".
 */
function regionOf(source: string, name: string): string | null {
    const code = stripComments(source);
    const start = declarationStart(code, name);
    if (start < 0) return null;
    const next = code.slice(start + 1).search(/\n(?:export )?(?:async )?function [a-zA-Z]+\(|\n {4}static [a-zA-Z]+ =|\nexport const |\nconst [A-Z_]+ =/);
    return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

/**
 * The argument list of one call, from `fn(` to its closing `);` — or `''` when there is no such call.
 *
 * ⚠ **This exists because a guard about one CALL must not read a span containing others.** The
 * signed-cancel guard first asserted `verifyConfirmationRef([\s\S]*split.id,` and passed happily
 * against a copy with the scope removed, because a later line in the same handler also says
 * `split.id,`. Naming the span is the whole lesson of this file's header.
 */
function callArguments(region: string, fn: string): string {
    const at = region.indexOf(`${fn}(`);
    if (at < 0) return '';
    const end = region.indexOf(');', at);
    return end < 0 ? '' : region.slice(at + fn.length + 1, end);
}

/**
 * Run a source predicate against the real file (must hold) and a broken copy (must not).
 *
 * ⚠ **A mutation that changes nothing fails the assertion.** If the text a mutation replaces has
 * moved, the guard is now reading something else, and passing silently is the defect this file exists
 * to refuse.
 */
function assertBites(
    name: string,
    predicate: (source: string) => boolean,
    mutate: (source: string) => string,
): void {
    assertBitesIn(CONTROLLER, name, predicate, mutate);
}

/**
 * `assertBites` against any source, because this stream now spans two controllers.
 *
 * ⚠ **The source is a PARAMETER rather than a second copy of this function**, so the "a mutation that
 * no longer applies FAILS" rule holds for the support half too. That rule is the whole value here.
 */
function assertBitesIn(
    source: string,
    name: string,
    predicate: (source: string) => boolean,
    mutate: (source: string) => string,
): void {
    assert(name, () => {
        const CONTROLLER = source;
        const broken = mutate(CONTROLLER);
        if (broken === CONTROLLER) {
            console.error('     ↳ the mutation no longer applies — re-read this guard against the controller');
            return false;
        }
        const holds = predicate(CONTROLLER);
        const bites = !predicate(broken);
        if (!holds) console.error('     ↳ the real controller fails it');
        if (!bites) console.error('     ↳ it still passes against the broken copy — the guard is vacuous');
        return holds && bites;
    });
}

/** The keys `ORDER_ACTION_HANDLERS` registers, read from the source. */
function registeredKeys(source: string): string[] {
    const code = stripComments(source);
    const start = code.indexOf('export const ORDER_ACTION_HANDLERS');
    if (start < 0) return [];
    const body = code.slice(code.indexOf('{', start) + 1, code.indexOf('});', start));
    return [...body.matchAll(/^\s+'?([a-z]+(?::[a-z]+)?)'?\s*:/gm)].map((m) => m[1]);
}

const O = '0123456789abcdef01234567';

/**
 * A file handle and a confirmation reference at their REAL lengths, so the cap assertions below are
 * about the tokens this service actually mints rather than about short stand-ins.
 */
const HANDLE = `att_${'A'.repeat(INBOUND_FILE_HANDLE_LENGTH - 'att_'.length)}`;
const REF = 'r'.repeat(longestConfirmationRefLength());
const S = 'fedcba9876543210fedcba98';

function main(): void {
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n══ § 1 · Every button this stream draws reaches a handler ══');

    /**
     * The whole chat vocabulary of this stream, built with the real builders. A button added to the
     * controller and not to this list is caught by the scan after it.
     */
    const EMITTED: ReadonlyArray<readonly [label: string, token: string]> = [
        ['order row', orderActionId(O)],
        ['order card · Shipments', orderShipmentsActionId(O)],
        ['order card · Cancel', orderCancelActionId(O)],
        ['order card · Get help', supportTopicActionId('hp', O)],
        ['cancel · Yes', orderCancelConfirmActionId(O, REF)],
        ['cancel · No', orderCancelDeclineActionId(O)],
        ['parcel row', shipmentActionId(O, S)],
        ['COD card · Get code', codCodeActionId(O, S)],
        ['COD card · Track', trackActionId(O)],
        ['confirm · Yes', confirmActionId('cd', `${O}:${S}`)],
        ['confirm · No', declineActionId('cd', `${O}:${S}`)],
        ['failed · redeliver', supportTopicActionId('rd', O)],
        ['failed · address', supportTopicActionId('ad', O)],
        ['order list · Load more', openSurfaceActionId('ol')],
        ['order list · from a menu', orderActionId('list')],
        ['request row', ticketCardActionId(O)],
        ['request · Reply', ticketReplyActionId(O)],
        ['request · Attach photo', ticketPhotoActionId(O)],
        ['request · Close', ticketCloseActionId(O)],
        ['request list · from a menu', ticketListActionId()],
        ['support form', supportFormActionId()],
        ['support form · with the file just sent', supportFormWithFileActionId(HANDLE)],
        ['which request · attach here', attachToTicketActionId(O, HANDLE)],
        ['close request · Yes', ticketCloseConfirmActionId(O, REF)],
        ['close request · No', ticketCloseDeclineActionId(O)],
    ];

    const keys = registeredKeys(CONTROLLER);

    assert('the registry export exists and is not empty', () => keys.length > 0);

    assert('it registers EXACTLY the keys this stream owns — none missing, none extra', () => {
        const expected = ['ord', 'shp', 'code', 'track', 'tkt', 'yes:cd', 'no:cd', 'yes:cnc', 'no:cnc',
            'yes:tcl', 'no:tcl', 'open:ol'];
        const same = expected.length === keys.length && expected.every((k) => keys.includes(k));
        if (!same) console.error(`     ↳ registered: ${keys.join(' · ')}`);
        return same;
    });

    assert('every emitted token routes, through the dispatcher\'s own key logic, to a registered key', () => {
        const unrouted = EMITTED.filter(([, token]) => {
            const parsed = parseBotActionId(token);
            return !parsed || !keys.includes(actionKeyOf(parsed).key);
        });
        if (unrouted.length) console.error(`     ↳ ${unrouted.map(([l]) => l).join(', ')}`);
        return unrouted.length === 0;
    });

    assert('⚠ every emitted token fits Telegram\'s callback cap, with realistic ids', () => {
        const over = EMITTED.filter(([, t]) => Buffer.byteLength(t, 'utf8') > __CALLBACK_DATA_BYTES);
        if (over.length) console.error(`     ↳ ${over.map(([l]) => l).join(', ')}`);
        return over.length === 0;
    });

    assert('⚠ the controller builds no token by hand — every id comes from a builder', () => {
        const code = stripComments(CONTROLLER);
        return !/id:\s*[`'"](?:ord|shp|code|track|tkt|yes|no|open):/.test(code);
    });

    assert('every builder the controller calls appears in the list above', () => {
        const code = stripComments(CONTROLLER);
        const used = [...code.matchAll(/\b([a-z][A-Za-z]*ActionId)\(/g)].map((m) => m[1]);
        const covered = [
            'orderActionId', 'orderShipmentsActionId', 'orderCancelActionId', 'supportTopicActionId',
            'confirmActionId', 'declineActionId', 'shipmentActionId', 'codCodeActionId',
            'trackActionId', 'openSurfaceActionId', 'supportTopicActionId', 'orderCancelConfirmActionId',
            'orderCancelDeclineActionId',
        ];
        const missing = [...new Set(used)].filter((b) => !covered.includes(b));
        if (missing.length) console.error(`     ↳ add to EMITTED: ${missing.join(', ')}`);
        return missing.length === 0;
    });

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n══ § 2 · Taps can never swallow an error ══');

    /** Tap handlers in the ORDER controller. */
    const TAP_HANDLERS = [
        'orderTap', 'shipmentTap', 'codCodeTap', 'trackTap', 'confirmDeliveryTap',
        'declineDeliveryTap', 'confirmCancelTap', 'declineCancelTap', 'orderHistoryTap',
    ];

    /**
     * Tap handlers in the SUPPORT controller, which the same rules bind.
     *
     * ⚠ **Listed separately and asserted to be in the other file**, so the day one of them moves back
     * the suite fails instead of quietly checking nothing — the vacuous-scan shape that has already
     * cost this effort a working guard.
     */
    const TICKET_TAP_HANDLERS = [
        'ticketTap', 'askForReply', 'askForPhoto', 'askToClose', 'confirmTicketCloseTap',
        'declineTicketCloseTap', 'openSupportForm',
    ];

    /**
     * ⛔ **The failure this whole section exists for.** A route static is wrapped in `asyncHandler`,
     * which returns before its work finishes and routes its own errors into `next`. A tap awaiting
     * one resolves early and swallows every refusal: no response, the automation layer times out,
     * and Telegram reports nothing for a callback that produced no message. It happened once here.
     */
    const noStaticInRegions = (source: string, names: readonly string[], statics: RegExp): boolean =>
        names.every((name) => {
            const region = regionOf(source, name);
            return region !== null && !statics.test(region) && !/\bnext\b/.test(region);
        });

    const noTapCallsAStatic = (source: string): boolean =>
        noStaticInRegions(source, TAP_HANDLERS, /BotOrderController\./);

    assertBites(
        '⛔ no tap handler awaits a route static or touches `next`',
        noTapCallsAStatic,
        (src) => src.replace(
            'await showOrderCard(req, res, orderId);\n}',
            'await BotOrderController.getOrder(req, res, () => undefined);\n}',
        ),
    );

    assert('every tap handler exists as a plain function', () =>
        TAP_HANDLERS.every((name) => regionOf(CONTROLLER, name) !== null));

    /**
     * ⚠ **The support handlers are asserted to be in the SUPPORT file, and absent from this one.**
     * Both halves matter: the first proves the scan below has something to read, the second proves
     * this file's own scans are not silently covering code that has left it.
     */
    assert('every support tap handler exists as a plain function, in the support controller', () => {
        const here = TICKET_TAP_HANDLERS.filter((name) => regionOf(CONTROLLER, name) !== null);
        if (here.length) console.error(`     ↳ still in the ORDER controller: ${here.join(', ')}`);
        const missing = TICKET_TAP_HANDLERS.filter((name) => regionOf(TICKET_CONTROLLER, name) === null);
        if (missing.length) console.error(`     ↳ not found in the support controller: ${missing.join(', ')}`);
        return here.length === 0 && missing.length === 0;
    });

    assertBitesIn(
        TICKET_CONTROLLER,
        '⛔ no SUPPORT tap handler awaits a route static or touches `next`',
        (source) => noStaticInRegions(source, TICKET_TAP_HANDLERS, /BotTicketController\./),
        (src) => src.replace(
            '            await listOwnRequests(req, res, BotTicketListSchema.parse({}));',
            '            await BotTicketController.list(req, res, () => undefined);',
        ),
    );

    assertBites(
        'a malformed argument is refused with the dispatcher\'s ONE refusal, not a home-made one',
        (source) => {
            const code = stripComments(source);
            return code.includes('throw unknownBotAction()') && !code.includes('BOT_ACTION_TOKEN_UNKNOWN');
        },
        (src) => src.replace(
            '        throw unknownBotAction();\n    }\n    return parts;',
            "        throw createAppError(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, 422);\n    }\n    return parts;",
        ).replace(/throw unknownBotAction\(\)/g, 'throw createAppError(ERROR_CODES.BOT_ACTION_TOKEN_UNKNOWN, 422)'),
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n══ § 3 · The owner\'s decisions, pinned where they are enforced ══');

    assertBites(
        '⛔ the delivery code has NO resend button — nothing on a card reaches the resend route',
        (source) => {
            const code = stripComments(source);
            const rendering = ['setShipmentCardReply', 'setOrderCardReply', 'failedDeliveryActions', 'codCodeTap']
                .map((name) => regionOf(source, name) ?? '');
            return rendering.every((r) => r.length > 0 && !/resend/i.test(r))
                && !/resendDeliveryCode|resendCod.*ActionId/.test(code);
        },
        (src) => src.replace(
            "{ id: codCodeActionId(orderId, shipment.id), label: botChrome('getCodeButton', language) },",
            "{ id: codCodeActionId(orderId, shipment.id), label: botChrome('getCodeButton', language) },\n                { id: 'resend', label: 'Resend' },",
        ),
    );

    assertBites(
        'Cancel is offered only when it can succeed, by the SAME states `assertCancellable` uses',
        (source) => {
            const card = regionOf(source, 'setOrderCardReply') ?? '';
            const gate = regionOf(source, 'isCancellableFromChat') ?? '';
            const guarded = /if \(isCancellableFromChat\(order\)\) \{[^}]*orderCancelActionId/.test(card);
            return guarded
                && gate.includes('CANCELLABLE_FULFILLMENT_STATES.includes(')
                && !/'pending'\s*&&|'processing'\s*&&|!== 'pending' && [^\n]*!== 'processing'/.test(gate);
        },
        (src) => src.replace('    if (isCancellableFromChat(order)) {\n', '    if (true) {\n'),
    );

    assertBites(
        'confirm-delivery is offered only on a PREPAID parcel at the door — the service refuses the rest',
        (source) => {
            const card = regionOf(source, 'setShipmentCardReply') ?? '';
            return /shipment\.status === 'out_for_delivery'\s*&& order\.payment_method !== 'cash_on_delivery'/.test(card)
                && !/status === 'delivered'/.test(card.slice(card.indexOf('awaitingConfirmation')));
        },
        (src) => src.replace(
            "        shipment.status === 'out_for_delivery'\n        && order.payment_method !== 'cash_on_delivery';",
            "        (shipment.status === 'out_for_delivery' || shipment.status === 'delivered')\n        && order.payment_method !== 'cash_on_delivery';",
        ),
    );

    assertBites(
        'the two failed-delivery asks open SUPPORT — there is no reschedule or re-address feature to call',
        (source) => {
            const actions = regionOf(source, 'failedDeliveryActions') ?? '';
            const asks = [...actions.matchAll(/id:\s*([a-zA-Z]+)\(/g)].map((m) => m[1]);
            return asks.length >= 2 && asks.every((builder) => builder === 'supportTopicActionId');
        },
        (src) => src.replace(
            "id: supportTopicActionId('rd', orderId),",
            'id: trackActionId(orderId),',
        ),
    );

    assertBites(
        '⛔ "Yes, cancel" is SIGNED for purpose `cancel` and scoped to the order it names',
        (source) => {
            const tap = regionOf(source, 'confirmCancelTap') ?? '';
            const ask = regionOf(source, 'askToCancel') ?? '';
            /**
             * ⚠ **Read the CALL's own arguments, never a span across the whole handler.** A
             * `[\s\S]*split\.id,` reaching past the verify call matches the `cancelOwnedOrder(req,
             * res, split.id, undefined)` line below it, so dropping the scope from the verify call
             * left the guard green — measured, not imagined: that is how this guard first failed its
             * own bite-proof.
             */
            const verify = callArguments(tap, 'verifyConfirmationRef');
            const mint = callArguments(ask, 'mintConfirmationRef');
            const signedForThisOrder = verify.includes("'cancel'") && verify.includes('split.id');
            const mintedForThisOrder = mint.includes("'cancel'") && mint.includes('orderId');
            return signedForThisOrder
                && mintedForThisOrder
                && tap.includes('splitConfirmArgument(action.argument)')
                && tap.includes("verdict !== 'valid'");
        },
        /**
         * Drop the SCOPE the reference is verified against: a confirmation minted for one order would
         * then be accepted for cancelling ANY of that customer's orders, which is the whole reason the
         * scope exists.
         */
        (src) => src.replace("        'cancel',\n        { userId: caller.userId, channel: caller.channel },\n        split.id,", "        'cancel',\n        { userId: caller.userId, channel: caller.channel },\n        '',"),
    );

    assertBites(
        'the cancellation REASON is typed: a tap cancels with no reason and the reply asks for one',
        (source) => {
            const tap = regionOf(source, 'confirmCancelTap') ?? '';
            const work = regionOf(source, 'cancelOwnedOrder') ?? '';
            return tap.includes('cancelOwnedOrder(req, res, split.id, undefined)')
                && /reason\s*\?\s*null\s*:\s*\{ kind: 'text', text: botChrome\('cancelReasonPrompt'/.test(work);
        },
        (src) => src.replace("botChrome('cancelReasonPrompt'", "botChrome('confirmButton'"),
    );

    assertBites(
        '⚠ an internal value chooses buttons and never reaches a body — no failure reason is sent',
        (source) => {
            const helper = regionOf(source, 'latestFailureReason') ?? '';
            const actions = regionOf(source, 'failedDeliveryActions') ?? '';
            return helper.includes('delivery_failures')
                && !/sendSuccess|setBotReply/.test(helper)
                && !/text:\s*[^,\n]*reason/.test(actions);
        },
        (src) => src.replace(
            "    return failures.length > 0 ? (failures[failures.length - 1].reason ?? null) : null;",
            "    return failures.length > 0 ? (failures[failures.length - 1].reason ?? null) : null;\n    sendSuccess(undefined as never, failures);",
        ),
    );

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n══ § 4 · The shared status table — the parts only this stream reads ══');

    assert('no string too long for its control (the boot assertion does not throw)', () => {
        assertOrderStatusCopyComplete();
        return true;
    });

    /**
     * ⚠ **"Cash on delivery" replaces "Awaiting payment" and nothing else.** A customer who owes
     * nothing until the door must not read as behind on a payment — but a PAID or REFUNDED order that
     * happened to be cash on delivery must still say so.
     */
    const cashOnDeliveryIsNarrow = (
        label: (state: Parameters<typeof botPaymentStateLabel>[0], lang: string, cod: boolean) => string,
    ): boolean =>
        BOT_COPY_LANGUAGES.every((lang) =>
            label('awaiting_payment', lang, true) === ORDER_CASH_ON_DELIVERY_COPY[lang]
            && label('awaiting_payment', lang, false) === ORDER_PAYMENT_COPY.awaiting_payment[lang]
            && (['paid', 'refunded', 'failed', 'partially_paid', 'disputed', 'mixed'] as const).every(
                (state) => label(state, lang, true) === ORDER_PAYMENT_COPY[state][lang],
            ));

    assert('"Cash on delivery" replaces ONLY "Awaiting payment", and only when asked to', () => {
        const real = cashOnDeliveryIsNarrow((s, l, cod) => botPaymentStateLabel(s, l, { cashOnDelivery: cod }));
        // Bite: a label that says "cash on delivery" for every COD order, whatever its state.
        const broken = cashOnDeliveryIsNarrow((s, l, cod) =>
            cod ? ORDER_CASH_ON_DELIVERY_COPY[l as keyof typeof ORDER_CASH_ON_DELIVERY_COPY]
                : botPaymentStateLabel(s, l));
        if (broken) console.error('     ↳ the check passes a broken label — it is vacuous');
        return real && !broken;
    });

    assertBites(
        '⚠ the chat decides "cash on delivery" per ORDER, from that order\'s own payment method',
        (source) => {
            const code = stripComments(source);
            const sites = code.match(/cashOnDelivery: order\.paymentMethod === 'cash_on_delivery'/g) ?? [];
            const calls = code.match(/botPaymentStateLabel\(/g) ?? [];
            return sites.length === 2 && calls.length === 2;
        },
        (src) => src.replace(
            "cashOnDelivery: order.paymentMethod === 'cash_on_delivery',",
            'cashOnDelivery: true,',
        ),
    );

    /**
     * ⛔ **An unrecognised status never reaches the customer as its raw token.** An earlier version of
     * the table returned the token itself, so a customer would have read `partially_shipped`.
     */
    const RAW = 'teleported_by_owl';
    const floorHolds = (fulfilment: (s: string, l: string) => string, payment: (s: string, l: string) => string) =>
        BOT_COPY_LANGUAGES.every((lang) =>
            fulfilment(RAW, lang) === ORDER_STATUS_UNAVAILABLE_COPY[lang]
            && payment(RAW, lang) === ORDER_STATUS_UNAVAILABLE_COPY[lang]
            && !fulfilment(RAW, lang).includes(RAW)
            && !payment(RAW, lang).includes(RAW));

    assert('⛔ an unknown fulfilment OR payment status reads "Status not available", never the raw token', () => {
        const real = floorHolds(
            (s, l) => botFulfillmentStateLabel(s, l),
            (s, l) => botPaymentStateLabel(toBotOrderPaymentState(s), l),
        );
        // Bite: the old defect — the fulfilment floor returning the token it was given.
        const brokenFulfilment = floorHolds(
            (s) => s,
            (s, l) => botPaymentStateLabel(toBotOrderPaymentState(s), l),
        );
        // Bite: an unknown payment state defaulting to something reassuring.
        const brokenPayment = floorHolds(
            (s, l) => botFulfillmentStateLabel(s, l),
            (_s, l) => botPaymentStateLabel('paid', l),
        );
        if (brokenFulfilment || brokenPayment) console.error('     ↳ the floor check passes a broken copy — vacuous');
        return real && !brokenFulfilment && !brokenPayment;
    });

    assert('an empty or missing status takes the same floor, rather than throwing', () =>
        BOT_COPY_LANGUAGES.every((lang) =>
            botFulfillmentStateLabel(null, lang) === ORDER_STATUS_UNAVAILABLE_COPY[lang]
            && botFulfillmentStateLabel('', lang) === ORDER_STATUS_UNAVAILABLE_COPY[lang]
            && toBotOrderPaymentState(undefined) === 'unknown'));

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n────────────────────────────────────────────────────────────────────────────');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('────────────────────────────────────────────────────────────────────────────\n');
    process.exit(failed === 0 ? 0 : 1);
}

main();
