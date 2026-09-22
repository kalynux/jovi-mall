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
import ts from 'typescript';
import {
    BOT_ACTION_VERBS,
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
import { judgeCancellationReason } from '../../src/modules/bot-surface/domain/bot-cancellation-reason';
import {
    attachToTicketActionId,
    longestConfirmationRefLength,
    parseTicketTap,
    ticketTokenBudgetProblems,
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
import {
    FLOW_OPTION_TITLE_MAX,
    assertTicketCopyComplete,
    botTicketReplyButton,
    botTicketStateLabel,
    ticketAcceptsWriting,
} from '../../src/modules/bot-surface/domain/bot-ticket-copy';
import {
    buildContacts,
    buildTicketFormView,
    subjectKeyOfTopic,
    ticketFormChoices,
    ticketSubjectFor,
    ticketTypeFor,
} from '../../src/modules/bot-surface/miniapp/surfaces/ticket-form.view';
import {
    requestRow,
    shortRequestReference,
} from '../../src/modules/bot-surface/domain/bot-ticket-rows';
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

/**
 * The support form's I/O half, scanned as a THIRD span.
 *
 * ⚠ It reaches the ticket service and — through the support ladder — `orders/`, so importing it would
 * hang this suite with no output. Its PURE half (`ticket-form.view.ts`) is imported instead, which is
 * the whole reason the form is split across two files.
 */
const FORM_READ_PATH = path.join(
    __dirname,
    '../../src/modules/bot-surface/miniapp/surfaces/ticket-form.read.ts',
);

const FORM_READ = fs.readFileSync(FORM_READ_PATH, 'utf8').replace(/\r\n/g, '\n');

/** The route table, read as text so § 9's pin on the published tool name can prove it bites. */
const ROUTE_TABLE = fs.readFileSync(
    path.join(__dirname, '../../src/modules/bot-surface/domain/bot-route-table.ts'),
    'utf8',
).replace(/\r\n/g, '\n');

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

/** A realistic id, for substituting into another stream's token templates (§ 8). */
const ID = O;

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

    supportSection();
    cancellationReasonSection();
    crossStreamSection();
    automationContractSection();
    tokenContainmentSection();

    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n────────────────────────────────────────────────────────────────────────────');
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log('────────────────────────────────────────────────────────────────────────────\n');
    process.exit(failed === 0 ? 0 : 1);
}

main();

// ─────────────────────────────────────────────────────────────────────────────
//  § 6 · Support requests — the grammar, the wording, and the form's projection
//
//  ⚠ **The ticket controller and the form's I/O half are SCANNED, never imported**: both reach
//  `tickets/` and, through the support ladder, `orders/` — which do work at import and hang bare
//  `ts-node` with no output at all. The pure halves (`bot-ticket-actions`, `bot-ticket-copy`,
//  `ticket-form.view`) are imported, because that is what they exist for.
// ─────────────────────────────────────────────────────────────────────────────

function supportSection(): void {
    console.log('\n══ § 6 · Support requests ══');

    // ── The tap grammar ──────────────────────────────────────────────────────

    assert('every shape of the `tkt` argument parses to what it means', () => {
        const table: Array<readonly [argument: string, kind: string]> = [
            [O, 'show'],
            [`${O}:rp`, 'reply'],
            [`${O}:ph`, 'photo'],
            [`${O}:cl`, 'close'],
            [`${O}:${HANDLE}`, 'attach'],
            ['list', 'list'],
            ['new', 'new'],
            [`new:${HANDLE}`, 'new'],
            [`new:rd:${O}`, 'new'],
            [`new:ad:${O}`, 'new'],
            [`new:hp:${O}`, 'new'],
        ];
        const wrong = table.filter(([argument, kind]) => (parseTicketTap(argument)?.kind ?? null) !== kind);
        if (wrong.length) console.error(`     ↳ ${wrong.map(([a]) => a).join(', ')}`);
        return wrong.length === 0;
    });

    assert('a delivery topic keeps its order and its code; a file row keeps its handle', () => {
        const topic = parseTicketTap(`new:ad:${O}`);
        const file = parseTicketTap(`${O}:${HANDLE}`);
        const carried = parseTicketTap(`new:${HANDLE}`);
        return topic?.kind === 'new' && topic.topic === 'ad' && topic.orderId === O
            && file?.kind === 'attach' && file.ticketId === O && file.attachmentRef === HANDLE
            && carried?.kind === 'new' && carried.attachmentRef === HANDLE && carried.orderId === null;
    });

    /**
     * ⚠ **The shape a TEMPLATE produces when its order id is missing**, reported by the notifications
     * stream: `renderTemplate` fills an unsupplied placeholder with an empty string, so
     * `tkt:new:rd:{{orderId}}` with no id becomes `tkt:new:rd:` — a well-formed token pointing at
     * nothing, which arrives here as a two-segment argument. Their renderer drops such a button
     * before it is sent; this is the second line, and it must refuse rather than open a form about
     * no order.
     */
    assert('⛔ a delivery topic with no order id is refused, not opened against nothing', () =>
        parseTicketTap('new:rd:') === null
            && parseTicketTap('new:rd') === null
            && parseTicketTap('new:ad:') === null);

    assert('⛔ a malformed argument is null — never a guess', () => {
        const refused = [
            '',
            'list:x',
            `${O}:xx`,
            `${O}:rp:extra`,
            `new:zz:${O}`,
            'new:rd:not-an-order',
            `${O}:att_has:colon`,
            'newish',
            O.slice(0, 20),
        ];
        const accepted = refused.filter((argument) => parseTicketTap(argument) !== null);
        if (accepted.length) console.error(`     ↳ accepted: ${accepted.join(', ')}`);
        return accepted.length === 0;
    });

    // ── The byte budget ──────────────────────────────────────────────────────

    assert('the byte budget holds for the handles and references this service mints', () =>
        ticketTokenBudgetProblems({
            handleLength: INBOUND_FILE_HANDLE_LENGTH,
            confirmationRefLength: longestConfirmationRefLength(),
        }).length === 0);

    /**
     * ⚠ **The bite-proof for the reason the handle was shortened at all.** At the old 32-byte handle
     * (47 characters) a "which request is this file for?" row is 76 bytes, and Telegram truncates an
     * oversized `callback_data` in SILENCE — the button simply does nothing, forever, with no error on
     * either side. So this is the guard that must fail if anybody raises `HANDLE_BYTES` back.
     */
    assert('⛔ it BITES: the old 47-character handle is named as too long for a `tkt` row', () => {
        const problems = ticketTokenBudgetProblems({
            handleLength: 47,
            confirmationRefLength: longestConfirmationRefLength(),
        });
        const named = problems.some((line) => line.includes('tkt:<ticketId>:<att_>') && line.includes('76 bytes'));
        if (!named) console.error(`     ↳ reported instead: ${problems.join('; ') || '(nothing)'}`);
        return named;
    });

    assert('⛔ it BITES: a confirmation reference twice its length is named too', () => {
        const problems = ticketTokenBudgetProblems({
            handleLength: INBOUND_FILE_HANDLE_LENGTH,
            confirmationRefLength: longestConfirmationRefLength() * 2,
        });
        return problems.some((line) => line.includes('yes:tcl')) && problems.some((line) => line.includes('yes:cnc'));
    });

    // ── The wording ──────────────────────────────────────────────────────────

    /**
     * ⭐ **The rule this section exists for.** Four internal waiting states must be indistinguishable
     * to a customer: telling somebody their complaint is "waiting on the agency" invites them to chase
     * a party about a conversation they cannot see, and discloses how the platform is organised. Same
     * rule as `handing_over` on the order side.
     */
    assert('⛔ which desk holds a request never reaches the customer — four states read alike', () => {
        const holders = ['waiting_on_admin', 'waiting_on_vendor', 'waiting_on_agency', 'waiting_on_agent'];
        return BOT_COPY_LANGUAGES.every((language) => {
            const inProgress = botTicketStateLabel('in_progress', language);
            return holders.every((status) => botTicketStateLabel(status, language) === inProgress);
        });
    });

    assert('⚠ an unknown status reads as the neutral sentence, never as the raw token', () =>
        BOT_COPY_LANGUAGES.every((language) => {
            const label = botTicketStateLabel('teleported', language);
            return label === ORDER_STATUS_UNAVAILABLE_COPY[language] && !label.includes('teleported');
        }));

    assert('the one state a customer can act on says so, and changes the button', () =>
        BOT_COPY_LANGUAGES.every((language) =>
            botTicketReplyButton('waiting_on_customer', language)
                !== botTicketReplyButton('open', language)));

    assert('a CLOSED request accepts no writing; every other state does', () =>
        ticketAcceptsWriting('closed') === false
            && ['open', 'in_progress', 'waiting_on_customer', 'waiting_on_admin', 'resolved']
                .every((status) => ticketAcceptsWriting(status)));

    assert('every capped support string fits its control, in all five languages', () => {
        assertTicketCopyComplete();
        return true;
    });

    /**
     * ⚠ **Meta's cap, not ours.** The eight subjects are drawn as a WhatsApp Flow
     * `RadioButtonsGroup`, whose option title is cut at 30 characters — invisible on the Telegram
     * page we develop against, and first seen by a WhatsApp customer as a half-word.
     */
    assert('⚠ every subject label fits a WhatsApp Flow option title', () => {
        const over = ticketFormChoices(null).length === 0;
        const long = BOT_COPY_LANGUAGES.flatMap((language) =>
            ticketFormChoices(language).filter((choice) => choice.label.length > FLOW_OPTION_TITLE_MAX));
        if (long.length) console.error(`     ↳ ${long.map((c) => c.label).join(', ')}`);
        return !over && long.length === 0;
    });

    // ── What a submission becomes ────────────────────────────────────────────

    assert('a delivery topic refines the ticket type, and only while the subject stays delivery', () =>
        ticketTypeFor('delivery', 'rd') === 'DELIVERY_DELAY'
            && ticketTypeFor('delivery', 'ad') === 'ADDRESS_CHANGE'
            && ticketTypeFor('delivery', 'hp') === 'SHIPPING_ISSUE'
            && ticketTypeFor('delivery', null) === 'SHIPPING_ISSUE'
            // The customer changed the subject: the topic must not survive it.
            && ticketTypeFor('payment', 'rd') === 'PAYMENT_ISSUE');

    assert('the subject line names the subject and what it is about, and fits the column', () => {
        const withOrder = ticketSubjectFor('delivery', 'rd', 'ORD-2026-000123 — Maison Bella', 'en');
        const without = ticketSubjectFor('other', null, null, 'en');
        const huge = ticketSubjectFor('order', null, 'x'.repeat(400), 'en');
        return withOrder.includes('ORD-2026-000123')
            && without.length > 0
            && !without.includes('null')
            && huge.length <= 200;
    });

    // ── The form's projection ────────────────────────────────────────────────

    /**
     * ⛔ **A LEAK assertion, and the pin the coordinator asked for.** The form may show only what the
     * support ladder already returns to a customer: a party's name and the contact details that party
     * published. A shop's ship-from address is private — the store screens show a city and no more —
     * and a support form is exactly the screen where somebody would helpfully add one. So the ladder
     * answer below carries fields the form must drop, and the serialised view is asserted to contain
     * none of them.
     */
    assert('⛔ the form projects the ladder\'s contacts and NOTHING else — no ids, no address', () => {
        const contacts = buildContacts({
            vendor: {
                name: 'Maison Bella',
                supportWhatsapp: '+237600000001',
                supportPhone: null,
                supportEmail: 'help@maisonbella.example',
                // Everything below is on the real ladder answer or on the store, and must not travel.
                storeSlug: 'maison-bella',
                vendorId: '64vendor0000000000000001',
                shipFromAddress: 'PRIVATE ship-from line, Akwa, Douala',
            } as unknown as Parameters<typeof buildContacts>[0]['vendor'],
            agency: {
                name: 'Douala Express',
                supportWhatsapp: null,
                supportPhone: '+237600000002',
                supportEmail: null,
                id: '64agency0000000000000001',
            } as unknown as Parameters<typeof buildContacts>[0]['agency'],
        });

        const serialised = JSON.stringify(
            buildTicketFormView({
                language: 'fr',
                about: 'ORD-2026-000123 — Maison Bella',
                contacts,
                topic: 'rd',
                hasAttachment: true,
            }),
        );

        const leaked = ['maison-bella', '64vendor', '64agency', 'PRIVATE ship-from', 'shipFromAddress']
            .filter((needle) => serialised.includes(needle));
        if (leaked.length) console.error(`     ↳ leaked: ${leaked.join(', ')}`);

        const keys = contacts.flatMap((contact) => Object.keys(contact)).sort();
        const allowed = ['email', 'name', 'party', 'phone', 'whatsapp'];
        const extra = [...new Set(keys)].filter((key) => !allowed.includes(key));
        if (extra.length) console.error(`     ↳ extra keys: ${extra.join(', ')}`);

        return leaked.length === 0 && extra.length === 0 && contacts.length === 2;
    });

    assert('a party that published no way to reach it is left out, not drawn empty', () => {
        const contacts = buildContacts({
            vendor: { name: 'Silent Shop', supportWhatsapp: null, supportPhone: null, supportEmail: null },
            agency: { name: 'Douala Express', supportWhatsapp: null, supportPhone: '+237600000002', supportEmail: null },
        });
        return contacts.length === 1 && contacts[0].party === 'carrier';
    });

    assert('the form pre-selects a subject only when a topic opened it', () => {
        const prefilled = buildTicketFormView({
            language: 'en', about: null, contacts: [], topic: 'ad', hasAttachment: false,
        });
        const bare = buildTicketFormView({
            language: 'en', about: null, contacts: [], topic: null, hasAttachment: false,
        });
        return prefilled.selectedKey === 'delivery'
            && bare.selectedKey === null
            && subjectKeyOfTopic(null) === null;
    });

    /**
     * ⚠ **The file is reported as present and NOT described.** A WhatsApp Flow can only carry an image
     * as base64 in its response, and the handle is single-use — so naming the file would mean spending
     * it to read its name. The customer sent the photo one message ago.
     */
    assert('⚠ a carried file is reported as present, with nothing about the file', () => {
        const view = buildTicketFormView({
            language: 'en', about: null, contacts: [], topic: null, hasAttachment: true,
        });
        const serialised = JSON.stringify(view.attachment);
        return view.attachment !== null
            && !/att_|fileName|url|mime/i.test(serialised)
            && buildTicketFormView({
                language: 'en', about: null, contacts: [], topic: null, hasAttachment: false,
            }).attachment === null;
    });

    // ── The support controller and the form's I/O, scanned ───────────────────

    assertBitesIn(
        TICKET_CONTROLLER,
        '⛔ Reply sets NO reply and hands the turn over — the assistant files the next message',
        (source) => {
            const region = regionOf(source, 'askForReply') ?? '';
            return region.includes('setBotReply(req, null)')
                && region.includes('awaitingReply: true')
                && !/kind: 'text'/.test(region);
        },
        (src) => src.replace(
            '    setBotReply(req, null);\n    sendSuccess(res, {\n        ticketId,',
            "    setBotReply(req, { kind: 'text', text: 'Type your reply' });\n    sendSuccess(res, {\n        ticketId,",
        ),
    );

    assertBitesIn(
        TICKET_CONTROLLER,
        '⛔ the follower check runs BEFORE the handle is spent, and a failed attach restores it',
        (source) => {
            const attach = regionOf(source, 'attachInboundFile') ?? '';
            const restore = regionOf(source, 'attachOrRestore') ?? '';
            const checkAt = attach.indexOf('loadOwnRequest');
            const consumeAt = attach.indexOf('inboundFileStore.consume');
            return checkAt >= 0 && consumeAt > checkAt && restore.includes('inboundFileStore.restore');
        },
        // Spend the handle first: a wrong request id would then also cost the customer their photo.
        (src) => src.replace(
            '    await loadOwnRequest(ticketId, caller.userId);\n\n    const file = await inboundFileStore.consume(caller.userId, ref);',
            '    const file = await inboundFileStore.consume(caller.userId, ref);\n    await loadOwnRequest(ticketId, caller.userId);',
        ),
    );

    assertBitesIn(
        TICKET_CONTROLLER,
        '⛔ closing is confirmed for THIS request — the reference is verified against its own id',
        (source) => {
            const tap = regionOf(source, 'confirmTicketCloseTap') ?? '';
            const ask = regionOf(source, 'askToClose') ?? '';
            const verify = callArguments(tap, 'verifyConfirmationRef');
            const mint = callArguments(ask, 'mintConfirmationRef');
            return verify.includes("'ticket-close'") && verify.includes('split.id')
                && mint.includes("'ticket-close'") && mint.includes('ticketId')
                && tap.includes("verdict !== 'valid'");
        },
        (src) => src.replace(
            "        'ticket-close',\n        { userId: caller.userId, channel: caller.channel },\n        split.id,",
            "        'ticket-close',\n        { userId: caller.userId, channel: caller.channel },\n        '',",
        ),
    );

    assertBitesIn(
        TICKET_CONTROLLER,
        '⚠ the file picker never offers a CLOSED request — a row that could only refuse',
        (source) => {
            const region = regionOf(source, 'whichRequestForFileReply') ?? '';
            return region.includes('ticketAcceptsWriting') && region.includes('slice(0, 4)');
        },
        (src) => src.replace(
            'const open = tickets.filter((ticket) => ticketAcceptsWriting(textOf(ticket.status))).slice(0, 4);',
            'const open = tickets.slice(0, 4);',
        ),
    );

    assertBitesIn(
        FORM_READ,
        '⛔ the form SPENDS its handle on submit and only READS it to draw — one request per form',
        (source) => {
            const submit = regionOf(source, 'submitTicketForm') ?? '';
            const read = regionOf(source, 'readSession') ?? '';
            return submit.includes("inAppSurfaceStore.consume('tf'")
                && !submit.includes("inAppSurfaceStore.read('tf'")
                && read.includes("inAppSurfaceStore.read('tf'");
        },
        (src) => src.replace("inAppSurfaceStore.consume('tf'", "inAppSurfaceStore.read('tf'"),
    );

    /**
     * ⚠ **After the handle is spent, naming the subject may not throw.** The customer has just typed
     * their problem; losing it to a lookup that decorates a subject line would send them back to the
     * chat to retype it. The READ path deliberately does throw, which is why this reads the submit
     * path's own helper.
     */
    assertBitesIn(
        FORM_READ,
        '⛔ a failed subject lookup degrades after the spend — it never costs the customer their words',
        (source) => {
            const helper = regionOf(source, 'aboutForSubject') ?? '';
            const submit = regionOf(source, 'submitTicketForm') ?? '';
            return helper.includes('try {')
                && helper.includes('catch')
                && helper.includes('return null')
                && submit.includes('aboutForSubject(session)')
                // The ladder itself is still called unguarded on the READ path.
                && !submit.includes('resolveSubject(session)');
        },
        (src) => src.replace('        const about = await aboutForSubject(session);', '        const about = (await resolveSubject(session)).about;'),
    );

    assertBitesIn(
        FORM_READ,
        '⚠ what a request is ABOUT comes from the session\'s own order, never from the ladder\'s guess',
        (source) => {
            const region = regionOf(source, 'resolveSubject') ?? '';
            return /about: session\.form\.orderId \? context\.subject\.label : null/.test(region);
        },
        (src) => src.replace(
            'about: session.form.orderId ? context.subject.label : null,',
            'about: context.subject.label,',
        ),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  § 7 · The typed cancellation reason
//
//  ⚠ **The rule is pure, which is the only reason these three refusals are testable at all**: each
//  needs a cancelled order, a timeline and a clock, and nobody reproduces that combination by hand.
// ─────────────────────────────────────────────────────────────────────────────

function cancellationReasonSection(): void {
    console.log('\n══ § 7 · The typed cancellation reason ══');

    const CANCELLED_AT = new Date('2026-09-20T10:00:00.000Z');
    const cancellation = {
        eventType: 'fulfillment.updated',
        metadata: { newStatus: 'cancelled', reason: 'Cancelled by customer' },
        actorType: 'customer',
        createdAt: CANCELLED_AT,
    };
    const reasonNote = {
        eventType: 'note.added',
        metadata: { cancellationReason: true },
        actorType: 'customer',
        createdAt: new Date(CANCELLED_AT.getTime() + 60_000),
    };

    const judge = (input: Partial<Parameters<typeof judgeCancellationReason>[0]>) =>
        judgeCancellationReason({
            fulfillmentStatus: 'cancelled',
            events: [cancellation],
            fallbackAt: CANCELLED_AT,
            now: new Date(CANCELLED_AT.getTime() + 60_000),
            ...input,
        });

    assert('a cancelled order with nothing recorded accepts the words, dated from the cancellation', () => {
        const verdict = judge({});
        return verdict.ok === true && verdict.cancelledAt.getTime() === CANCELLED_AT.getTime();
    });

    assert('⛔ an order that is NOT cancelled is refused — there is no cancellation to explain', () =>
        ['pending', 'processing', 'shipped', 'delivered', 'fulfilled', 'returned'].every((status) => {
            const verdict = judge({ fulfillmentStatus: status });
            return verdict.ok === false && verdict.refusal === 'not_cancelled';
        }));

    /**
     * ⚠ **One reason per cancellation.** The assistant may retry, a tap may be replayed, and a thread
     * of contradictory sentences in an order's history is worse than one sentence.
     */
    assert('⛔ a second reason is refused, not appended', () => {
        const verdict = judge({ events: [cancellation, reasonNote] });
        return verdict.ok === false && verdict.refusal === 'already_recorded';
    });

    assert('⛔ words typed more than a day later are refused — a chat thread lives forever', () => {
        const late = judge({ now: new Date(CANCELLED_AT.getTime() + 25 * 60 * 60 * 1000) });
        const justInside = judge({ now: new Date(CANCELLED_AT.getTime() + 23 * 60 * 60 * 1000) });
        return late.ok === false && late.refusal === 'window_closed' && justInside.ok === true;
    });

    /**
     * ⚠ **A note that is not FLAGGED does not count as a reason**, which is what makes the flag
     * load-bearing rather than decorative: without it, any customer note on a cancelled order would
     * block the one this route exists to write.
     */
    assert('an unflagged note on the order does not count as the reason', () => {
        const other = { ...reasonNote, metadata: { note: 'something else' } };
        return judge({ events: [cancellation, other] }).ok === true;
    });

    assert('with no cancellation event in the timeline the clock falls back, and the rule still runs', () => {
        const verdict = judge({ events: [], fallbackAt: CANCELLED_AT });
        const stale = judge({
            events: [],
            fallbackAt: new Date(CANCELLED_AT.getTime() - 48 * 60 * 60 * 1000),
        });
        return verdict.ok === true && stale.ok === false && stale.refusal === 'window_closed';
    });

    assert('a timeline with an unreadable date is refused rather than trusted', () => {
        const broken = { ...cancellation, createdAt: 'not a date' };
        const verdict = judgeCancellationReason({
            fulfillmentStatus: 'cancelled',
            events: [broken],
            fallbackAt: 'also not a date',
            now: new Date(),
        });
        return verdict.ok === false && verdict.refusal === 'not_cancelled';
    });

    /**
     * ⭐ **THE FRENCH CASE, and it is the whole reason this assertion exists.** The row builder's
     * first version titled a row with the customer's own subject, which WhatsApp cuts at 24
     * characters — so two requests read "Ma commande est arrivée…" / "Ma commande est arrivée…" and
     * the customer tapped at random. In English the same two subjects fit and read differently, which
     * is why every check passed.
     *
     * The rule this pins, for any row built from data: **the title must be short and distinguishing,
     * and the case must be French or Arabic.**
     */
    assert('⛔ two long FRENCH subjects are still told apart at WhatsApp\'s 24-character title', () => {
        const rows = [
            { id: '64000000000000000000a1b2', subject: 'Ma commande est arrivée abîmée', status: 'open' },
            { id: '64000000000000000000d4e5', subject: 'Ma commande est arrivée incomplète', status: 'open' },
        ].map((request) => requestRow(request, 'fr'));

        const WA_TITLE = 24;
        const WA_DESCRIPTION = 72;
        const titles = rows.map((row) => (row.shortLabel ?? row.label).slice(0, WA_TITLE));
        const descriptions = rows.map((row) => (row.description ?? '').slice(0, WA_DESCRIPTION));

        if (titles[0] === titles[1]) console.error(`     ↳ both titles read "${titles[0]}"`);
        if (descriptions[0] === descriptions[1]) console.error(`     ↳ both descriptions read "${descriptions[0]}"`);

        return titles[0] !== titles[1]
            && titles.every((title) => title.length <= WA_TITLE)
            // The distinguishing words survive the cut, which is why the state comes second.
            && descriptions[0] !== descriptions[1]
            && descriptions[0].includes('abîmée')
            && descriptions[1].includes('incomplète');
    });

    assert('the reference is the request\'s own id, shortened — stable, and never empty', () =>
        shortRequestReference('64000000000000000000a1b2') === '#00A1B2'
            && shortRequestReference('64000000000000000000d4e5') === '#00D4E5'
            && shortRequestReference('') === '#');

    // ── The handler, scanned ─────────────────────────────────────────────────

    assertBites(
        '⛔ the reason is judged BEFORE it is written — no refusal can leave a note behind',
        (source) => {
            const region = regionOf(source, 'recordCancellationReason') ?? '';
            const judgedAt = region.indexOf('judgeCancellationReason(');
            const refusedAt = region.indexOf('cancellationReasonRefusal(');
            const wroteAt = region.indexOf('timelineRepository.appendEvent(');
            return judgedAt >= 0 && refusedAt > judgedAt && wroteAt > refusedAt;
        },
        /**
         * Delete the refusal altogether: the words would then be written whatever the rule said.
         *
         * ⚠ The first version of this mutation replaced the throw with an unused arrow function that
         * still MENTIONED `cancellationReasonRefusal`, and the guard passed — the same "my scan and my
         * claim are about different spans" failure as the signed-cancel guard, one level up. A guard
         * that reads for a call must be broken by REMOVING the call, not by disarming it.
         */
        (src) => src.replace(
            '        if (!verdict.ok) throw cancellationReasonRefusal(verdict.refusal);\n',
            '',
        ),
    );

    assertBites(
        '⛔ the note is the customer\'s own words, attributed to them, and FLAGGED as a reason',
        (source) => {
            const write = callArguments(regionOf(source, 'recordCancellationReason') ?? '', 'appendEvent');
            return write.includes("eventType: 'note.added'")
                && write.includes('description: reason')
                && write.includes("actorType: 'customer'")
                && write.includes('CANCELLATION_REASON_METADATA_KEY');
        },
        // Summarise instead of recording: the vendor would read the platform's words, not the customer's.
        (src) => src.replace('            description: reason,', "            description: 'Cancelled by customer',"),
    );

    assert('each refusal carries its OWN code and status — none reuses ORDER_ALREADY_CANCELLED', () => {
        const region = regionOf(CONTROLLER, 'cancellationReasonRefusal') ?? '';
        return region.includes('ORDER_CANCELLATION_REASON_ALREADY_RECORDED')
            && region.includes('409')
            && region.includes('ORDER_CANCELLATION_REASON_WINDOW_CLOSED')
            && region.includes('ORDER_CANCELLATION_REASON_NOT_CANCELLED')
            && region.includes('422')
            && !region.includes('ORDER_ALREADY_CANCELLED');
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  § 8 · Buttons ANOTHER stream draws with this stream's verbs
//
//  ⭐ **THE RULE THIS SECTION MECHANISES** (round 2, after a live near-miss): a stream drawing a
//  button whose verb another stream claims cannot detect a mismatch. The notifications stream's
//  token was well-formed, its label was right, its suite was green — and the argument shape was
//  wrong against a parser it does not own. Telegram reports NOTHING for an unhandled callback, so
//  the first evidence would have been a customer tapping "I was not there" on a failed-delivery
//  message and being told "I did not understand that": a silent failure on the message least able
//  to afford one.
//
//  So the CLAIMING stream asserts it, here, against their landed literals — never against what was
//  agreed in a message. If they add a shape, this fails; if the catalogue moves, the emptiness
//  check below fails rather than passing vacuously.
// ─────────────────────────────────────────────────────────────────────────────

function crossStreamSection(): void {
    console.log('\n══ § 8 · Buttons another stream draws with this stream\'s verbs ══');

    const CATALOG_PATH = path.join(
        __dirname,
        '../../src/modules/notifications/catalog/customer-notification-catalog.ts',
    );

    const catalog = fs.readFileSync(CATALOG_PATH, 'utf8').replace(/\r\n/g, '\n');
    const keys = registeredKeys(CONTROLLER);

    /** Every `token: '<literal>'` in their catalogue, whatever verb it carries. */
    const drawn = [...stripComments(catalog).matchAll(/token:\s*'([^']+)'/g)].map((m) => m[1]);

    /** The ones this stream has to route: a verb, or a (verb, sub-key) pair, that I registered. */
    const mine = drawn.filter((token) => {
        const parsed = parseBotActionId(token.replace(/\{\{[^}]+\}\}/g, ID));
        return parsed !== null && keys.includes(actionKeyOf(parsed).key);
    });

    assert('the scan found their catalogue and some of my verbs in it', () => {
        if (drawn.length === 0) console.error('     ↳ no `token:` literals at all — has the catalogue moved?');
        if (mine.length === 0) console.error(`     ↳ ${drawn.length} tokens, none of them mine — check the verbs`);
        return drawn.length > 0 && mine.length > 0;
    });

    /**
     * ⚠ **Every one of their tokens must parse AND reach a handler of mine, with a realistic id.**
     * `parseBotActionId` alone is not enough: a token can be a legal verb with an argument my own
     * grammar refuses, which is exactly the four-segment shape that nearly shipped.
     */
    assert('every button they draw with my verbs parses, routes, and fits Telegram\'s cap', () => {
        const broken = mine.filter((token) => {
            const filled = token.replace(/\{\{[^}]+\}\}/g, ID);
            const parsed = parseBotActionId(filled);
            if (!parsed) return true;

            const { key, action } = actionKeyOf(parsed);
            if (!keys.includes(key)) return true;
            if (Buffer.byteLength(filled, 'utf8') > __CALLBACK_DATA_BYTES) return true;

            // For the verb whose whole grammar is this stream's, the ARGUMENT must read too.
            if (parsed.verb === 'tkt' && parseTicketTap(action.argument) === null) return true;
            return false;
        });

        if (broken.length) console.error(`     ↳ would reach the unknown-action refusal: ${broken.join(', ')}`);
        return broken.length === 0;
    });

    /**
     * ⚠ **An UNSUPPLIED placeholder must be refused, not mis-routed.** `renderTemplate` fills a
     * missing key with an empty string, so `tkt:new:rd:{{orderId}}` with no order becomes
     * `tkt:new:rd:` — a well-formed token pointing at nothing. Their renderer drops such a button
     * before it is sent; this asserts the second line, which is that my parser refuses it rather
     * than opening a form about no order.
     */
    assert('⛔ with its placeholder unfilled, every one of their tokens is REFUSED', () => {
        const withPlaceholders = mine.filter((token) => /\{\{/.test(token));
        if (withPlaceholders.length === 0) {
            console.error('     ↳ none of their tokens carries a placeholder — has the shape changed?');
            return false;
        }

        const accepted = withPlaceholders.filter((token) => {
            const empty = token.replace(/\{\{[^}]+\}\}/g, '');
            const parsed = parseBotActionId(empty);
            if (!parsed) return false;
            if (!keys.includes(actionKeyOf(parsed).key)) return false;
            return parsed.verb !== 'tkt' || parseTicketTap(actionKeyOf(parsed).action.argument) !== null;
        });

        if (accepted.length) console.error(`     ↳ accepted with nothing to act on: ${accepted.join(', ')}`);
        return accepted.length === 0;
    });

    /**
     * ⚠ **The shape that nearly shipped, pinned by name.** Four segments after `tkt:new` is refused,
     * and it must stay refused: the notifications stream has its own pin that no ticket token exceeds
     * three segments, and this is the other half of that pair.
     */
    assert('⛔ the four-segment shape that nearly shipped is still refused', () =>
        parseTicketTap(`new:dlv:${ID}:absent`) === null
            && parseTicketTap(`new:dlv:${ID}:address`) === null);
}

// ─────────────────────────────────────────────────────────────────────────────
//  § 9 · Three literals of mine that another repository's document quotes
//
//  ⭐ **THE HAZARD, AND IT RUNS THE OPPOSITE WAY TO § 8.** There, another stream drew a button my
//  parser had to read. Here, the automation layer keys on strings THIS stream emits — two flag names
//  in a tap's `data` and one tool name — and they are written out in
//  `api-doc/n8n/N8N-DEPLOY-DAY-CHANGES.md`, which another stream owns and n8n is built from.
//
//  **There is no compiler between the halves.** A tidy-up that renames `awaitingCancellationReason`
//  leaves this repository green, leaves that document green, and silently stops the customer's typed
//  cancellation reason from ever being recorded — the failure nobody sees, because an empty column
//  looks exactly like customers who chose not to answer. So the rename has to fail HERE, loudly,
//  where the person doing it is standing.
//
//  ⚠ **The document is asserted as well as the code, and a MISSING document is a FAILURE.** If that
//  file moves or is renamed, this pin has stopped protecting anything, and the only safe way to learn
//  that is to be told rather than to keep passing.
// ─────────────────────────────────────────────────────────────────────────────

function automationContractSection(): void {
    console.log('\n══ § 9 · The literals the automation layer keys on ══');

    /** Emitted by this stream, keyed on by n8n, quoted in a document this stream does not own. */
    const CONTRACT = Object.freeze({
        /** The order-cancel tap's flag: the assistant must file the customer's next message. */
        cancellationFlag: 'awaitingCancellationReason',
        /** The ticket-Reply tap's flag. Same rule, same shape, different situation. */
        replyFlag: 'awaitingReply',
        /** The tool that writes the typed reason onto the order's history. */
        tool: 'orders_record_cancellation_reason',
        /** Its path, which the catalogue publishes to the automation layer. */
        path: '/orders/:orderId/cancellation-reason',
    });

    const DEPLOY_DOC_PATH = path.join(__dirname, '../../api-doc/n8n/N8N-DEPLOY-DAY-CHANGES.md');

    /**
     * ⚠ **Every one of the three is a bite-proof, not a presence check**, because a pin whose whole
     * job is to fail on a rename is worthless if nobody has watched it fail on a rename. Each
     * mutation below is exactly the change a tidy-up would make.
     */
    assertBitesIn(
        CONTROLLER,
        'the order-cancel flag is emitted as a LITERAL key, spelled as the automation layer reads it',
        (source) => stripComments(source).includes(`${CONTRACT.cancellationFlag}:`),
        // The rename that leaves both repositories green and stops the reason being recorded.
        (src) => src.split(CONTRACT.cancellationFlag).join('awaitingReasonText'),
    );

    assertBitesIn(
        TICKET_CONTROLLER,
        'the ticket-Reply flag is emitted as a LITERAL key, spelled as the automation layer reads it',
        (source) => stripComments(source).includes(`${CONTRACT.replyFlag}:`),
        (src) => src.split(CONTRACT.replyFlag).join('awaitsCustomerReply'),
    );

    assertBitesIn(
        ROUTE_TABLE,
        'the tool and its path are exactly what the catalogue publishes to the automation layer',
        (source) => source.includes(`tool: '${CONTRACT.tool}'`) && source.includes(`path: '${CONTRACT.path}'`),
        (src) => src.split(CONTRACT.tool).join('orders_add_cancellation_note'),
    );

    /**
     * ⚠ **The other half of the contract, and the reason a missing file FAILS.** This is the position
     * `test:blog`'s cross-repository fixture list holds: two halves, no shared package, nothing but an
     * assertion in the middle. If the document moves, this pin has stopped protecting anything, and
     * the only safe way to learn that is to be told rather than to keep passing.
     */
    assert('the automation layer\'s own document still exists where this pin looks for it', () => {
        if (fs.existsSync(DEPLOY_DOC_PATH)) return true;
        console.error('     ↳ N8N-DEPLOY-DAY-CHANGES.md is gone from this path — this pin protects NOTHING');
        console.error('     ↳ re-point it at the document that replaced it, or tell the stream that owns it');
        return false;
    });

    assertBitesIn(
        fs.existsSync(DEPLOY_DOC_PATH) ? fs.readFileSync(DEPLOY_DOC_PATH, 'utf8') : '',
        'and that document still names all three, so a rename here cannot leave it stale',
        (source) => [CONTRACT.cancellationFlag, CONTRACT.replyFlag, CONTRACT.tool]
            .every((literal) => source.includes(literal)),
        // A rewording that drops one of them: the two halves must be decided together.
        (src) => src.split(CONTRACT.cancellationFlag).join('the cancellation flag'),
    );
}

// ─────────────────────────────────────────────────────────────────────────────
//  § 10 · Where a tap token may be written by hand
//
//  ⭐ **THE QUESTION THIS ANSWERS: has a NEW producer started hand-writing tokens somewhere nobody
//  parse-tests them?** § 8 checks the producers we know about. Nothing checks for a producer nobody
//  told the claiming stream about — and that is how the four-segment `tkt:new:dlv:…:absent` nearly
//  shipped: a well-formed token, a sensible label, a green suite on the drawing side, and a parser it
//  had never been tried against. Telegram reports nothing for an unhandled callback, so the first
//  evidence is a customer being told "I did not understand that".
//
//  ── ⚠ WHY THIS IS CONTAINMENT AND NOT "ALWAYS CALL A BUILDER" ───────────────
//  The stronger rule was measured and rejected (census session, 2026-09-20) rather than judged:
//    · a text scan is 90% false positives — 345 hits, 311 of them PROSE, because this codebase
//      documents token grammars thoroughly and one docstring alone holds thirteen shapes;
//    · an AST scan sees correctly (comments are not nodes) and cuts that to 34 — but 24 of the 34 are
//      legitimate: registry map KEYS are declarations of what is routed, so flagging them is exactly
//      backwards, and the byte-budget samples exist to be worst cases;
//    · ⛔ and the notification catalogue **structurally cannot comply**: its tokens carry
//      `{{placeholders}}` resolved at render time, so there is no id to hand a builder. "Call the
//      builder instead" asks for an API that cannot exist.
//  A guard that starts life failing on correct code is the shape this repository's own record says
//  teaches the next person to delete it. So: a token literal may appear only in the files below, each
//  with its reason. A NEW file on that list is the whole signal, and the reviewer's question is the
//  entire lesson in one prompt: **is this token parse-tested?**
//
//  ── ⚠ WHAT THIS GUARD CANNOT SEE, SAID PLAINLY ─────────────────────────────
//  It walks `.ts` files under `src/` only. A token hand-written in an in-app page's inline script
//  (`miniapp/public/*.html`) or in the generated `api-doc/n8n/tools/catalog.json` is invisible to it.
//  Neither writes tap tokens today — measured 2026-09-20 — so this is a LIMIT rather than a defect. It
//  is written down because "a token literal may appear only in these files" is a broader sentence than
//  the span that enforces it, and a reader who believes the sentence is the person this guard exists to
//  protect.
//
//  ── ⚠ VACUITY IS GUARDED WITH SENTINELS, NEVER WITH A COUNT ────────────────
//  Taken verbatim from the census session's own slip twenty minutes before this was written: their
//  key-extraction scan broke, reported three live tokens dead, and **their vacuity check did not fire,
//  because it asserted "more than twenty keys found" and the broken regex still produced more than
//  twenty pieces of garbage.** A count proves a scan produced output, not that it produced the right
//  output. So this asserts that specific literals it KNOWS exist are found, and prints what it did
//  extract when they are not.
// ─────────────────────────────────────────────────────────────────────────────

interface TokenLiteral {
    file: string;
    text: string;
    /** A registry map key declares what is ROUTED; anything else is a token being composed. */
    isRegistryKey: boolean;
}


function tokenContainmentSection(): void {
    console.log('\n══ § 10 · Where a tap token may be written by hand ══');

    /**
     * Where a hand-written token is legitimate, and why. Sorted, so a diff to this list reads cleanly.
     *
     * ⚠ **Adding a file here is a DECISION, not a formality.** The question to answer in the same change:
     * is every token this file writes tried against the parser that claims its verb? For the catalogue
     * that answer is § 8; for the builders it is §§ 1 and 6.
     */
    const TOKEN_LITERALS_ALLOWED: Readonly<Record<string, { shape: 'keys-only' | 'composed'; reason: string }>> =
        Object.freeze({
            // The stream registry maps that hold a PAIR key (six since 2026-09-22, when checkout's
            // `yes:co` / `no:co` landed). Their literals are KEYS — `'yes:cd': handler` — which
            // declare what the dispatcher routes. Flagging a declaration would be backwards.
            //
            // ⚠ **`keys-only` is ENFORCED, not descriptive** (the discovery stream's finding 2,
            // 2026-09-20, measured): a per-file allowlist makes an allowlisted file a blind spot, and a
            // controller that starts COMPOSING a token by hand is a new producer hiding inside one —
            // the likeliest hiding place there is, because nobody asks "is this token parse-tested?" of
            // a controller a second time. Every one is 100% keys and 0 composed.
            'modules/bot-surface/controllers/bot-account.controller.ts': { shape: 'keys-only', reason: 'registry keys' },
            'modules/bot-surface/controllers/bot-booking.controller.ts': { shape: 'keys-only', reason: 'registry keys' },
            // `'yes:co'` / `'no:co'` (2026-09-22). The tokens themselves are composed in
            // `domain/bot-checkout-actions.ts` by builders, and parse-tested in test:inapp-checkout § 13.
            'modules/bot-surface/controllers/bot-checkout.controller.ts': { shape: 'keys-only', reason: 'registry keys' },
            'modules/bot-surface/controllers/bot-discovery.controller.ts': { shape: 'keys-only', reason: 'registry keys' },
            'modules/bot-surface/controllers/bot-order.controller.ts': { shape: 'keys-only', reason: 'registry keys' },
            'modules/bot-surface/controllers/bot-purchase.controller.ts': { shape: 'keys-only', reason: 'registry keys' },
            // This stream's builders, plus the byte-budget worst-case samples that exist to be literals.
            'modules/bot-surface/domain/bot-ticket-actions.ts': { shape: 'composed', reason: 'the tkt builders and the budget samples' },
            // One deliberate fallback payload, explained at its call site.
            'modules/bot-surface/domain/channel-reply.ts': { shape: 'composed', reason: 'the `more:none` fallback payload' },
            // ⚠ Cannot comply with a builder rule: its tokens carry `{{placeholders}}` filled at render
            // time. Every one of them is parse-tested from this side instead — see § 8.
            'modules/notifications/catalog/customer-notification-catalog.ts': { shape: 'composed', reason: 'template tokens, parse-tested in § 8' },
        });

    /**
     * Literals this scan must find, or it has stopped working.
     *
     * ⚠ **These are four PLACES, and by node kind only two SHAPES** — three `StringLiteral`s and one
     * `TemplateExpression`. The comment here used to claim three shapes, which was the check and the
     * claim covering different spans, in the comment rather than the code (the discovery stream's
     * finding 1). The walker's third branch has no real literal to point a sentinel at — nothing in
     * `src/` writes a token in plain backticks — so it is exercised by the bite-proof instead.
     */
    const TOKEN_SCAN_SENTINELS: ReadonlyArray<readonly [file: string, text: string]> = Object.freeze([
        ['modules/bot-surface/controllers/bot-order.controller.ts', 'yes:cd'],
        ['modules/bot-surface/domain/bot-ticket-actions.ts', 'tkt:${…}'],
        ['modules/notifications/catalog/customer-notification-catalog.ts', 'tkt:new:rd:{{orderId}}'],
        ['modules/bot-surface/domain/channel-reply.ts', 'more:none'],
    ] as const);

    const SRC_ROOT = path.join(__dirname, '../../src');

    /** The verbs, IMPORTED rather than scanned: the closed set is already exported for this. */
    const verbs = BOT_ACTION_VERBS as readonly string[];

    /**
     * What may follow the colon in a real token: ids, sub-words, `{{placeholders}}`, `<documented>`
     * shapes, `${…}` interpolations — and **never whitespace**.
     *
     * ⚠ **This is the anti-false-positive rule, and without it the guard is the text version again.**
     * Nine of the twenty-five verbs are ordinary English words (`open`, `code`, `add`, `no`, `save`,
     * `deal`, `book`, `more`, `next`), so a bare "starts with a verb and a colon" test flags
     * `'code: 200'`, `'open: true'` and `'Status code: 404'` — a prefix collision of exactly the shape
     * that has already produced a guard going red on correct code twice in this effort. A token never
     * contains a space; a sentence after a colon almost always does.
     */
    const TOKEN_ARGUMENT = /^[A-Za-z0-9_{}<>:.$…-]+$/;

    const isTokenText = (text: string): boolean =>
        verbs.some((verb) => {
            if (!text.startsWith(`${verb}:`)) return false;
            const argument = text.slice(verb.length + 1);
            return argument.length > 0 && TOKEN_ARGUMENT.test(argument);
        });

    /**
     * A template head is the same test with one extra case: `` `tkt:${id}` `` has the head `tkt:` and
     * nothing after it, which is a token being composed rather than a sentence.
     */
    const isTokenHead = (head: string): boolean =>
        verbs.some((verb) => head === `${verb}:`) || isTokenText(head);

    /**
     * Whether a string literal is a registry map KEY — a declaration of what is routed — rather than a
     * token being composed.
     *
     * ⚠ **A COMPUTED key counts too.** `{ ['yes:cd']: handler }` puts a `ComputedPropertyName` between
     * the literal and the property, so the plain parent check classes it as composed — which would fail
     * the `keys-only` rule in a file that is doing nothing wrong (the discovery stream's finding 4).
     * Nothing writes one today; handling it costs two lines and removes a trap from the guard rather
     * than from the code.
     */
    const isRegistryKeyNode = (node: ts.StringLiteral): boolean => {
        const parent = node.parent;
        if (!parent) return false;
        if (ts.isPropertyAssignment(parent)) return parent.name === node;
        if (ts.isComputedPropertyName(parent)) {
            return Boolean(parent.parent) && ts.isPropertyAssignment(parent.parent);
        }
        return false;
    };

    assert('⛔ the matcher reads tokens and NOT ordinary prose that happens to start with a verb', () => {
        const tokens = ['yes:cd', 'tkt:new:rd:{{orderId}}', 'more:none', 'ord:list', 'tkt:<ticketId>:<att_>'];
        const prose = ['code: 200', 'open: true', 'no: thanks', 'Status code: 404', 'book: the blue one', 'add: one more'];

        const missed = tokens.filter((text) => !isTokenText(text));
        const flagged = prose.filter((text) => isTokenText(text));
        if (missed.length) console.error(`     ↳ real tokens it cannot see: ${missed.join(' · ')}`);
        if (flagged.length) console.error(`     ↳ prose it would flag: ${flagged.join(' · ')}`);
        return missed.length === 0 && flagged.length === 0 && isTokenHead('tkt:');
    });

    const found: TokenLiteral[] = [];

    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const at = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(at);
            else if (entry.name.endsWith('.ts')) {
                const rel = path.relative(SRC_ROOT, at).split(path.sep).join('/');
                found.push(...literalsIn(rel, fs.readFileSync(at, 'utf8')));
            }
        }
    };

    /**
     * The walker, over a NAMED source text rather than a path.
     *
     * ⚠ **Text rather than a filename is what makes the bite-proof possible**: the guard can be shown
     * a synthetic new producer without planting a token literal in another stream's file. A guard whose
     * only proof is "it is green against the tree as it stands" is the shape this file exists to refuse.
     */
    const literalsIn = (rel: string, text: string): TokenLiteral[] => {
        const collected: TokenLiteral[] = [];
        const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);

        const visit = (node: ts.Node): void => {
            /**
             * ⚠ **The AST is what makes this workable at all**: a comment is not a node, so the 311
             * prose mentions that sank the text version vanish for free rather than needing an
             * exclusion list that would itself go stale.
             */
            if (ts.isStringLiteral(node) && isTokenText(node.text)) {
                collected.push({ file: rel, text: node.text, isRegistryKey: isRegistryKeyNode(node) });
            }

            /**
             * ⚠ **A token built with `+` writes no complete literal, so nothing else here sees it.**
             * `'tkt:' + id` and `` `tkt:${id}` `` are the same act written two ways, and only the second
             * was caught — and a producer that used `+` exclusively would have been invisible for ever
             * rather than merely on that line, because a bare `tkt:` fails the argument test. Accepted
             * only under a `+`, which measured **zero** hits across `src/` (the discovery stream's
             * finding 3), so it adds no false positives.
             */
            if (
                ts.isStringLiteral(node)
                && isTokenHead(node.text)
                && !isTokenText(node.text)
                && node.parent
                && ts.isBinaryExpression(node.parent)
                && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
            ) {
                collected.push({ file: rel, text: `${node.text} + …`, isRegistryKey: false });
            }
            if (ts.isTemplateExpression(node) && isTokenHead(node.head.text)) {
                collected.push({ file: rel, text: `${node.head.text}\${…}`, isRegistryKey: false });
            }
            if (ts.isNoSubstitutionTemplateLiteral(node) && isTokenText(node.text)) {
                collected.push({ file: rel, text: node.text, isRegistryKey: false });
            }
            ts.forEachChild(node, visit);
        };

        visit(source);
        return collected;
    };

    walk(SRC_ROOT);

    assert('⛔ the scan still works — every sentinel it knows about is found', () => {
        const missing = TOKEN_SCAN_SENTINELS.filter(
            ([file, text]) => !found.some((hit) => hit.file === file && hit.text === text),
        );
        if (missing.length) {
            console.error(`     ↳ the walker no longer sees: ${missing.map(([f, t]) => `${t} in ${f}`).join(' · ')}`);
            console.error(`     ↳ it extracted ${found.length} literals across ${new Set(found.map((h) => h.file)).size} files:`);
            for (const hit of found.slice(0, 12)) console.error(`        ${hit.file}  ${hit.text}`);
            console.error('     ↳ a COUNT would have passed here — that is why this asserts named literals');
        }
        return missing.length === 0;
    });

    /**
     * ⛔ **THE BITE-PROOF, and the guard is worth nothing without it.** A synthetic producer is shown to
     * the same walker, matcher and allowlist comparison the real scan uses — so this proves the whole
     * chain reacts, not merely that the tree happens to be clean today. It plants nothing on disk:
     * writing a token into another stream's file to test my own guard is exactly the kind of "temporary"
     * edit that gets committed.
     */
    assert('⛔ it BITES: a new file writing a token by hand is caught, and its literal is named', () => {
        const strangerFile = 'modules/somewhere/new-producer.ts';
        const hits = literalsIn(
            strangerFile,
            [
                '// A prose mention of tkt:new:rd:<orderId> must NOT count — comments are not nodes.',
                "const quickReply = { token: 'tkt:new:zz:640000000000000000000001', label: 'Help' };",
                'const composed = `ord:${orderId}`;',
                // ⚠ Plain backticks and a `+` — the two branches nothing in `src/` exercises.
                'const backticked = `ord:640000000000000000000001`;',
                "const glued = 'tkt:' + ticketId;",
                "const notAToken = 'code: 200';",
                "const alsoNot = { message: 'Status code: 404' };",
            ].join('\n'),
        );

        const texts = hits.map((hit) => hit.text).sort();
        const expected = [
            'ord:640000000000000000000001',
            'ord:${…}',
            'tkt: + …',
            'tkt:new:zz:640000000000000000000001',
        ].sort();

        const caught = JSON.stringify(texts) === JSON.stringify(expected)
            && !(strangerFile in TOKEN_LITERALS_ALLOWED);

        if (!caught) console.error(`     ↳ the walker saw ${hits.length}: ${texts.join(' · ')}`);
        return caught;
    });

    /**
     * ⛔ **An allowlisted file is otherwise a BLIND SPOT, and this closes it.** A file allowed to hold
     * registry keys may hold ONLY keys: a controller that starts composing a token by hand is a new
     * producer hiding where nobody will ask the question again. Measured when this landed: the five
     * controllers are 100% keys, the other three 100% composed, so the reasons in the allowlist were
     * exactly true — and enforced by nothing. This turns them from documentation into assertions.
     */
    assert('⛔ a file allowlisted for registry KEYS may not compose a token by hand', () => {
        const offenders = found.filter((hit) => {
            const entry = TOKEN_LITERALS_ALLOWED[hit.file];
            return entry?.shape === 'keys-only' && !hit.isRegistryKey;
        });

        if (offenders.length) {
            console.error('     ↳ a file allowlisted only for registry keys now COMPOSES a token:');
            for (const hit of offenders) console.error(`        ${hit.file}  →  ${hit.text}`);
            console.error('     ↳ either build it through a builder, or move the file to `composed` and');
            console.error('        say in the same change where that token is parse-tested.');
        }
        return offenders.length === 0;
    });

    assert('⛔ it BITES: a registry-keys file that composes a token is caught', () => {
        const keysOnlyFile = Object.keys(TOKEN_LITERALS_ALLOWED)
            .find((file) => TOKEN_LITERALS_ALLOWED[file].shape === 'keys-only');
        if (!keysOnlyFile) return false;

        const hits = literalsIn(keysOnlyFile, "const drawn = { id: 'ord:640000000000000000000001' };");
        return hits.length === 1
            && hits[0].isRegistryKey === false
            && TOKEN_LITERALS_ALLOWED[keysOnlyFile].shape === 'keys-only';
    });

    assert('⛔ no NEW file writes a tap token by hand', () => {
        const strangers = [...new Set(found.map((hit) => hit.file))]
            .filter((file) => !(file in TOKEN_LITERALS_ALLOWED))
            .sort();

        if (strangers.length) {
            console.error('     ↳ a token literal appears in a file that is not on the allowlist:');
            for (const file of strangers) {
                const texts = found.filter((hit) => hit.file === file).map((hit) => hit.text);
                console.error(`        ${file}  →  ${texts.join(', ')}`);
            }
            console.error('     ↳ ⚠ ASK, BEFORE ADDING IT: is every token this file writes tried against');
            console.error('        the parser that claims its verb? Nothing on the drawing side can tell.');
        }
        return strangers.length === 0;
    });

    /**
     * ⚠ **The allowlist must not outlive its files.** An entry for a file that no longer holds a token
     * is dead weight that makes the list look more considered than it is — and the next reader trusts
     * it. Reported rather than failed only where the FILE is gone, because a stream may legitimately
     * be mid-move; a file that still exists and no longer needs its entry is a failure.
     */
    assert('every allowlisted file still exists and still needs to be there', () => {
        const stale = Object.keys(TOKEN_LITERALS_ALLOWED).filter((file) => {
            if (!fs.existsSync(path.join(SRC_ROOT, file))) {
                console.log(`     ↳ allowlisted file is gone (a move in flight?): ${file}`);
                return false;
            }
            return !found.some((hit) => hit.file === file);
        });

        if (stale.length) {
            console.error(`     ↳ no longer writes any token, so drop the entry: ${stale.join(', ')}`);
            for (const file of stale) console.error(`        ${file} was allowed for: ${TOKEN_LITERALS_ALLOWED[file].reason}`);
        }
        return stale.length === 0;
    });
}
