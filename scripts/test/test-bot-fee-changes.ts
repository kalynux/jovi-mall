/**
 * Test: the chat's side of a delivery-fee change after checkout (ADR-A11 § Fee changes after
 * checkout, W-H) — the tools, the buttons, the copy and the boundary that keeps money off the model.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework). DB-free.
 * It deliberately imports NO controller and NO service: those reach `orders/` and `payments/`,
 * which do work at import and hang a bare ts-node run. What they must do is pinned by SOURCE SCAN
 * (comments stripped first), and the pure halves — the token grammar, the renderer, the copy — are
 * driven directly.
 *
 * Run: npm run test:bot-fee-changes
 */
import fs from 'fs';
import path from 'path';
import {
    __CALLBACK_DATA_BYTES,
    DELIVERY_FEE_CONFIRM_CONTEXT,
    deliveryFeeAcceptActionId,
    deliveryFeeDeclineActionId,
    deliveryFeeListActionId,
    deliveryFeeOrderActionId,
    deliveryFeePayActionId,
    deliveryFeeProposalActionId,
    parseBotActionId,
    parseDeliveryFeeArgument,
    parseDeliveryFeeConfirmArgument,
} from '../../src/modules/bot-surface/domain/bot-action-id';
import { actionKeyOf } from '../../src/modules/bot-surface/domain/bot-action-dispatch';
import {
    __FEE_COPY_TABLE,
    __FEE_COPY_TEMPLATES,
    botFeeChangeCopyGaps,
} from '../../src/modules/bot-surface/domain/bot-fee-change-copy';
import { botChromeCopyGaps } from '../../src/modules/bot-surface/domain/bot-chrome-copy';
import { __BOT_ERROR_COPY, BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import {
    BotFeeChangeView,
    FEE_CHANGE_CHOICE_MAX,
    feeChangeAcceptedReply,
    feeChangeDeclinedReply,
    feeChangeListReply,
    feeChangeQuestion,
    feeChangeRow,
    feeTopupChargeReply,
    toBotFeeChangeProjection,
} from '../../src/modules/bot-surface/domain/fee-change-chat-reply';
import { pendingQuestionDecisionFor } from '../../src/modules/bot-surface/domain/bot-pending-question';
import { renderBotReply, BotReplyIntent } from '../../src/modules/bot-surface/domain/channel-reply';
import { BOT_ROUTES } from '../../src/modules/bot-surface/domain/bot-route-table';
import {
    BotCombinedCreateSchema,
    BotDeliveryFeeApproveSchema,
    BotDeliveryFeePaySchema,
    BotDeliveryFeeRejectSchema,
} from '../../src/modules/bot-surface/validators/bot.validators';
import { readCatalog, selectMcpTools } from '../gen-mcp-workflow';
import {
    CUSTOMER_NOTIFICATION_CATALOG,
    customerTemplateQuickReplyLabels,
    renderCustomerQuickReplies,
    renderCustomerTemplateQuickReplies,
} from '../../src/modules/notifications/catalog/customer-notification-catalog';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (error) {
        console.error(`  ❌ THROW: ${name} — ${(error as Error).message}`);
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

function section(title: string): void {
    console.log(`\n── ${title} ──`);
}

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const ORDER = 'a'.repeat(24);
const PROPOSAL = 'b'.repeat(24);
const SHIPMENT = 'c'.repeat(24);

function view(over: Partial<BotFeeChangeView> = {}): BotFeeChangeView {
    return {
        proposalId: PROPOSAL,
        orderId: ORDER,
        orderNumber: 'WM-2026-000123',
        shipmentId: SHIPMENT,
        version: 2,
        origin: 'agency',
        paymentMode: 'cod',
        state: 'awaiting_answer',
        currency: 'XAF',
        feeBefore: 1500,
        proposedFee: 2000,
        // Deliberately NOT proposedFee − feeBefore (500): the shop bore part of the old fee.
        customerPays: 300,
        reason: 'Bulky parcel, needs a car',
        availableActions: ['approve', 'reject'],
        ...over,
    };
}

const PAYER = { payerMasked: '+2376••••4567', storefrontOrderUrl: 'https://wi-mall.com/en/shop/account/orders/detail/x' };
const textOf = (intent: BotReplyIntent): string => ('text' in intent ? intent.text : '');
const idsOf = (intent: BotReplyIntent): string[] =>
    intent.kind === 'text' ? (intent.actions ?? []).map((a) => a.id) : intent.kind === 'choice' ? intent.options.map((o) => o.id) : [];

function main(): void {
    console.log('\n═══ test:bot-fee-changes ═══════════════════════════════════════════════════');

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · The tokens — built by the builders, read back by the parsers');
    // ═════════════════════════════════════════════════════════════════════════

    assert('the builders emit the documented shapes', () =>
        deliveryFeeListActionId() === 'dfee:list'
        && deliveryFeeOrderActionId(ORDER) === `dfee:${ORDER}`
        && deliveryFeeProposalActionId(ORDER, PROPOSAL) === `dfee:${ORDER}:${PROPOSAL}`
        && deliveryFeePayActionId(PROPOSAL) === `dfee:pay:${PROPOSAL}`
        && deliveryFeeAcceptActionId(PROPOSAL, 2) === `yes:dfc:${PROPOSAL}:2`
        && deliveryFeeDeclineActionId(PROPOSAL, 2) === `no:dfc:${PROPOSAL}:2`
        && DELIVERY_FEE_CONFIRM_CONTEXT === 'dfc');

    assert('every shape fits Telegram\'s 64 bytes at its worst case (two ids; a nine-digit version)', () =>
        [
            deliveryFeeProposalActionId(ORDER, PROPOSAL),
            deliveryFeePayActionId(PROPOSAL),
            deliveryFeeAcceptActionId(PROPOSAL, 999_999_999),
            deliveryFeeDeclineActionId(PROPOSAL, 999_999_999),
        ].every((t) => Buffer.byteLength(t, 'utf8') <= __CALLBACK_DATA_BYTES));

    assert('ROUND TRIP: every dfee token parses back to what built it', () => {
        const parse = (t: string) => parseDeliveryFeeArgument(parseBotActionId(t)!.argument);
        const list = parse(deliveryFeeListActionId());
        const order = parse(deliveryFeeOrderActionId(ORDER));
        const one = parse(deliveryFeeProposalActionId(ORDER, PROPOSAL));
        const pay = parse(deliveryFeePayActionId(PROPOSAL));
        return list?.kind === 'list'
            && order?.kind === 'order' && order.orderId === ORDER
            && one?.kind === 'proposal' && one.orderId === ORDER && one.proposalId === PROPOSAL
            && pay?.kind === 'pay' && pay.proposalId === PROPOSAL;
    });

    assert('ROUND TRIP: Accept / Decline route to yes:dfc / no:dfc and carry the version as a number', () => {
        const yes = actionKeyOf(parseBotActionId(deliveryFeeAcceptActionId(PROPOSAL, 7))!);
        const no = actionKeyOf(parseBotActionId(deliveryFeeDeclineActionId(PROPOSAL, 7))!);
        const parsed = parseDeliveryFeeConfirmArgument(yes.action.argument);
        return yes.key === 'yes:dfc' && no.key === 'no:dfc' && parsed?.proposalId === PROPOSAL && parsed.version === 7;
    });

    assert('dfee routes by the verb alone (one owner, never sub-dispatched)', () =>
        actionKeyOf(parseBotActionId(deliveryFeeOrderActionId(ORDER))!).key === 'dfee');

    assert('the parsers REFUSE what this service could not have drawn', () =>
        [
            '', 'LIST', 'pay:', `pay:${'B'.repeat(24)}`, `${ORDER}:`, `${ORDER}:${PROPOSAL}:x`, 'x'.repeat(24),
            `pay:${PROPOSAL}:1`, `${ORDER.slice(1)}`,
        ].every((a) => parseDeliveryFeeArgument(a) === null)
        && [`${PROPOSAL}`, `${PROPOSAL}:0`, `${PROPOSAL}:-1`, `${PROPOSAL}:1.5`, `${PROPOSAL}:01`, `${PROPOSAL}:1234567890`, `x:1`]
            .every((a) => parseDeliveryFeeConfirmArgument(a) === null));

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · The keys are registered, and the handler map holds exactly them');
    // ═════════════════════════════════════════════════════════════════════════

    const dispatcher = stripComments(read('src/modules/bot-surface/controllers/bot-action.controller.ts'));
    const controller = stripComments(read('src/modules/bot-surface/controllers/bot-delivery-fee.controller.ts'));

    assert('the dispatcher merges the fees stream', () =>
        /\[\s*'fees'\s*,\s*DELIVERY_FEE_ACTION_HANDLERS\s*\]/.test(dispatcher)
        && /import\s*\{\s*DELIVERY_FEE_ACTION_HANDLERS\s*\}\s*from\s*'\.\/bot-delivery-fee\.controller'/.test(dispatcher));

    assert('DELIVERY_FEE_ACTION_HANDLERS = { dfee, yes:dfc, no:dfc } — nothing else', () => {
        const at = controller.indexOf('export const DELIVERY_FEE_ACTION_HANDLERS');
        const body = controller.slice(at, controller.indexOf('});', at));
        const keys = [...body.matchAll(/^\s*'?([a-z]+(?::[a-z]+)?)'?\s*:/gm)].map((m) => m[1]).sort();
        return JSON.stringify(keys) === JSON.stringify(['dfee', 'no:dfc', 'yes:dfc']);
    });

    assert('every tap parses through the builders\' parsers, never a hand-rolled split', () =>
        controller.includes('parseDeliveryFeeArgument(action.argument)')
        && (controller.match(/parseDeliveryFeeConfirmArgument\(action\.argument\)/g) ?? []).length === 2
        && !/argument\.split\(/.test(controller));

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · The notification buttons — order-scoped, parsed by the same grammar');
    // ═════════════════════════════════════════════════════════════════════════

    const FEE_SITUATIONS = [
        'order.delivery_fee.approval_needed',
        'order.delivery_fee.topup_due',
        'order.delivery_fee.topup_failed',
    ] as const;

    assert('the three situations each carry ONE quick reply: dfee:{{orderId}}, falling back to dfee:list', () =>
        FEE_SITUATIONS.every((s) => {
            const actions = CUSTOMER_NOTIFICATION_CATALOG[s].actions ?? [];
            return actions.length === 1
                && actions[0].token === 'dfee:{{orderId}}'
                && actions[0].templateFallback === 'dfee:list';
        }));

    assert('the catalogue literals parse with parseDeliveryFeeArgument (placeholder expanded)', () =>
        FEE_SITUATIONS.every((s) => {
            const action = CUSTOMER_NOTIFICATION_CATALOG[s].actions![0];
            const filled = parseBotActionId(action.token.replace('{{orderId}}', ORDER));
            const fallback = parseBotActionId(action.templateFallback!);
            return filled !== null && actionKeyOf(filled).key === 'dfee'
                && parseDeliveryFeeArgument(filled.argument)?.kind === 'order'
                && fallback !== null && parseDeliveryFeeArgument(fallback.argument)?.kind === 'list';
        }));

    assert('in a chat the button renders with the order filled; with no order it is dropped', () =>
        FEE_SITUATIONS.every((s) =>
            JSON.stringify(renderCustomerQuickReplies(s, 'en', { orderId: ORDER }).map((a) => a.token)) === JSON.stringify([`dfee:${ORDER}`])
            && renderCustomerQuickReplies(s, 'en', {}).length === 0));

    assert('out of window the template sends the order token, or dfee:list when it cannot be filled', () =>
        FEE_SITUATIONS.every((s) =>
            JSON.stringify(renderCustomerTemplateQuickReplies(s, { orderId: ORDER })) === JSON.stringify([`dfee:${ORDER}`])
            && JSON.stringify(renderCustomerTemplateQuickReplies(s, {})) === JSON.stringify(['dfee:list'])));

    assert('labels fit WhatsApp\'s 20 in all five languages', () =>
        FEE_SITUATIONS.every((s) => customerTemplateQuickReplyLabels(s).every((label) =>
            BOT_COPY_LANGUAGES.every((lang) => typeof label[lang] === 'string' && label[lang].length > 0 && label[lang].length <= 20))));

    assert('the committed template payloads carry the matching QUICK_REPLY (en, fr)', () => {
        const payloads = JSON.parse(read('api-doc/notifications/whatsapp-template-payloads.json')) as {
            payloads: Array<{ name: string; language: string; components: Array<{ type: string; buttons?: Array<{ type: string; text: string }> }> }>;
        };
        return FEE_SITUATIONS.every((s) => {
            const name = CUSTOMER_NOTIFICATION_CATALOG[s].whatsapp.template!.name;
            const labels = customerTemplateQuickReplyLabels(s);
            return (['en', 'fr'] as const).every((lang) => {
                const p = payloads.payloads.find((x) => x.name === name && x.language === lang);
                const qr = (p?.components.find((c) => c.type === 'BUTTONS')?.buttons ?? []).filter((b) => b.type === 'QUICK_REPLY').map((b) => b.text);
                return JSON.stringify(qr) === JSON.stringify(labels.map((l) => l[lang]));
            });
        });
    });

    assert('the boot assert pins the literals to the builders', () => {
        const catalogue = stripComments(read('src/modules/notifications/catalog/customer-notification-catalog.ts'));
        return catalogue.includes("deliveryFeeOrderActionId('{{orderId}}')") && catalogue.includes('deliveryFeeListActionId()');
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · The copy — five languages, caps, placeholders, and the guard bites');
    // ═════════════════════════════════════════════════════════════════════════

    assert('the table is complete and fits (botChromeCopyGaps finds nothing)', () => {
        const gaps = botFeeChangeCopyGaps();
        gaps.forEach((g) => console.error(`     ↳ ${g}`));
        return gaps.length === 0;
    });

    assert('every key has all five languages', () =>
        Object.values(__FEE_COPY_TABLE).every(({ copy }) => BOT_COPY_LANGUAGES.every((lang) => (copy as Record<string, string>)[lang]?.trim().length > 0)));

    assert('the two buttons fit 20 and the list heading 24, in every language', () =>
        (['acceptButton', 'declineButton', 'listButton'] as const).every((k) => __FEE_COPY_TABLE[k].cap === 20)
        && __FEE_COPY_TABLE.sectionTitle.cap === 24);

    assert('BITE: a dropped placeholder and an over-long button are both reported, by key and language', () => {
        const mutated = JSON.parse(JSON.stringify(__FEE_COPY_TABLE)) as Record<string, { copy: Record<string, string>; cap: number | null }>;
        mutated.ifAcceptCod.copy.fr = 'Si vous acceptez, vous paierez plus.';
        mutated.acceptButton.copy.pt = 'Aceitar a nova taxa de entrega';
        const gaps = botChromeCopyGaps(mutated as never, __FEE_COPY_TEMPLATES as never);
        return gaps.some((g) => g.startsWith('ifAcceptCod:fr carries {amount} 0 times'))
            && gaps.some((g) => g.startsWith('acceptButton:pt is'));
    });

    assert('lifecycle.ts refuses to boot on a broken table', () =>
        /assertBotFeeChangeCopyFits\(\);/.test(stripComments(read('src/lifecycle.ts'))));

    /**
     * The refusals a customer can actually meet on these routes, each with copy that says what to
     * DO. The category fallback for a 409 ("let me check and try again") would invite a retry that
     * can never succeed on STALE / NOT_OPEN, so those carry their own sentence.
     */
    assert('every fee-change refusal a customer can reach has its own five-language customerMessage', () => {
        const codes = [
            'DELIVERY_FEE_TOPUP_IN_PROGRESS', 'DELIVERY_FEE_TOPUP_NOT_DUE', 'DELIVERY_FEE_PROPOSAL_STALE',
            'DELIVERY_FEE_PROPOSAL_ORDER_NOT_PAID', 'COMBINED_DELIVERY_REQUEST_INELIGIBLE',
            'COMBINED_DELIVERY_REQUEST_ALREADY_OPEN', 'COMBINED_DELIVERY_REQUEST_NOT_OPEN',
        ];
        const table = __BOT_ERROR_COPY.CODE_COPY as Record<string, Record<string, string> | undefined>;
        const missing = codes.filter((c) => !table[c] || !BOT_COPY_LANGUAGES.every((l) => (table[c]![l] ?? '').trim().length > 0));
        missing.forEach((c) => console.error(`     ↳ ${c}`));
        return missing.length === 0;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · The question — server-drawn, backend figures, buttons only for offered actions');
    // ═════════════════════════════════════════════════════════════════════════

    const cod = feeChangeQuestion(view(), 'en', PAYER);
    assert('COD: the two fees, the reason, and what accepting costs — the BACKEND figure, not a subtraction', () => {
        const text = textOf(cod);
        return text.includes('2 000 XAF') && text.includes('1 500 XAF') && text.includes('Bulky parcel')
            && text.includes('300 XAF more in cash') && !text.includes('500 XAF more');
    });

    assert('COD: Accept · Decline carrying the proposal and the version shown', () =>
        JSON.stringify(idsOf(cod)) === JSON.stringify([`yes:dfc:${PROPOSAL}:2`, `no:dfc:${PROPOSAL}:2`]));

    assert('online, awaiting an answer: "pay the difference … before your parcel is collected"', () =>
        textOf(feeChangeQuestion(view({ paymentMode: 'online' }), 'en', PAYER)).includes('difference of 300 XAF before'));

    assert('a moved parcel says the shop pays on decline, and quotes no agency reason', () => {
        const text = textOf(feeChangeQuestion(view({ origin: 'change_agency' }), 'en', PAYER));
        return text.includes('moved to another delivery company') && text.includes('the shop pays the difference')
            && !text.includes('Bulky parcel');
    });

    assert('only the actions the proposal OFFERS are drawn (reject-only → Decline alone)', () =>
        JSON.stringify(idsOf(feeChangeQuestion(view({ availableActions: ['reject'] }), 'en', PAYER)))
            === JSON.stringify([`no:dfc:${PROPOSAL}:2`]));

    const due = view({ paymentMode: 'online', state: 'awaiting_payment', availableActions: ['pay', 'reject'] });
    assert('approved online: Pay now · Decline, the masked wallet, the FROZEN amount', () => {
        const q = feeChangeQuestion(due, 'en', PAYER);
        return JSON.stringify(idsOf(q)) === JSON.stringify([`dfee:pay:${PROPOSAL}`, `no:dfc:${PROPOSAL}:2`])
            && textOf(q).includes('+2376••••4567') && textOf(q).includes('difference of 300 XAF');
    });

    assert('no wallet on the account: the order page (a link), never a Pay button', () => {
        const q = feeChangeQuestion(due, 'en', { payerMasked: null, storefrontOrderUrl: PAYER.storefrontOrderUrl });
        const bare = feeChangeQuestion(due, 'en', { payerMasked: null, storefrontOrderUrl: null });
        return q.kind === 'link' && q.url === PAYER.storefrontOrderUrl
            && !idsOf(bare).some((id) => id.startsWith('dfee:pay:'));
    });

    assert('a stale tap\'s fresh question leads with the note', () =>
        textOf(feeChangeQuestion(view(), 'en', PAYER, 'NOTE')).startsWith('NOTE'));

    assert('it renders on both channels; on WhatsApp the two buttons are reply buttons', () => {
        const tg = renderBotReply(cod, 'telegram', '900000881');
        const wa = renderBotReply(cod, 'whatsapp', '237600000771');
        const waBody = JSON.stringify(wa.body);
        return JSON.stringify(tg.body).includes(`yes:dfc:${PROPOSAL}:2`) && waBody.includes('"type":"button"') && waBody.includes(`no:dfc:${PROPOSAL}:2`);
    });

    assert('French copy, same tokens (the label is translated, the id is not)', () => {
        const fr = feeChangeQuestion(view(), 'fr', PAYER);
        return textOf(fr).includes('300 XAF de plus en espèces')
            && JSON.stringify(idsOf(fr)) === JSON.stringify(idsOf(cod))
            && fr.kind === 'text' && fr.actions![0].label === 'Accepter';
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('6 · The list, the answers and the payment');
    // ═════════════════════════════════════════════════════════════════════════

    assert('none waiting → one sentence; one → its question', () =>
        textOf(feeChangeListReply([], 'en', PAYER)).includes('No delivery fee change')
        && idsOf(feeChangeListReply([view()], 'en', PAYER)).includes(`yes:dfc:${PROPOSAL}:2`));

    assert('several → a choice capped at five, then the order-history row', () => {
        const many = Array.from({ length: 7 }, (_, i) => view({ proposalId: i.toString(16).padStart(24, '0') }));
        const reply = feeChangeListReply(many, 'en', PAYER);
        const ids = idsOf(reply);
        return reply.kind === 'choice' && ids.length === FEE_CHANGE_CHOICE_MAX + 1 && ids[ids.length - 1] === 'open:ol'
            && ids.slice(0, 5).every((id) => parseDeliveryFeeArgument(parseBotActionId(id)!.argument)?.kind === 'proposal');
    });

    assert('a row: title = the order number (≤ 24), description ≤ 72 in every language', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const answer = feeChangeRow(view({ feeBefore: 1_500_000, proposedFee: 2_000_000 }), lang);
            const pay = feeChangeRow(view({ state: 'awaiting_payment', customerPays: 1_500_000 }), lang);
            return (answer.shortLabel ?? '').length <= 24 && (answer.description ?? '').length <= 72 && (pay.description ?? '').length <= 72;
        }));

    assert('the question supersedes a waiting one and is NOT answerable in words (dfc is button-only)', () => {
        const decision = pendingQuestionDecisionFor(cod, new Date());
        return decision.kind === 'supersede';
    });

    assert('accepted COD names the extra cash; accepted with nothing to pay says so; declines differ by origin', () =>
        textOf(feeChangeAcceptedReply(view(), 'en')).includes('300 XAF more in cash')
        && textOf(feeChangeAcceptedReply(view({ customerPays: 0 }), 'en')).includes('nothing more to pay')
        && textOf(feeChangeDeclinedReply(view({ origin: 'change_agency' }), 'en')).includes('the shop pays the difference')
        && textOf(feeChangeDeclinedReply(view(), 'en')).includes('keeps the old price'));

    assert('the charge reply: amount + masked wallet; a refused opening offers Try again on the SAME proposal; no Check status', () => {
        const waiting = feeTopupChargeReply({ proposalId: PROPOSAL, state: 'waiting', amountText: '300 XAF', payerMasked: '+2376••••4567', instructions: null }, 'en');
        const refused = feeTopupChargeReply({ proposalId: PROPOSAL, state: 'failed', amountText: '300 XAF', payerMasked: 'x', instructions: null }, 'en');
        return textOf(waiting).includes('300 XAF') && textOf(waiting).includes('+2376••••4567') && idsOf(waiting).length === 0
            && JSON.stringify(idsOf(refused)) === JSON.stringify([`dfee:pay:${PROPOSAL}`]);
    });

    assert('the projection carries the amounts AND the text to quote, and the version as data', () => {
        const p = toBotFeeChangeProjection(view());
        return p.version === 2 && p.customerPays === 300 && p.customerPaysText === '300 XAF'
            && p.proposedFeeText === '2 000 XAF' && p.feeBeforeText === '1 500 XAF';
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('7 · No arithmetic on money in the chat layer');
    // ═════════════════════════════════════════════════════════════════════════

    const renderer = stripComments(read('src/modules/bot-surface/domain/fee-change-chat-reply.ts'));
    const service = stripComments(read('src/modules/bot-surface/services/bot-delivery-fee.service.ts'));
    const SUBTRACT = /(proposed_?[Ff]ee|fee_?[Bb]efore|customerPays|topup[^\n]*amount|feeAfter|fee_after)\s*-|-\s*(?:[\w!]+\.)*(proposed_?[Ff]ee|fee_?[Bb]efore|customerPays|feeAfter|fee_after)\b/;

    assert('BITE: the subtraction scan catches the shapes a regression would take, and not a plain read', () =>
        ['view.proposedFee - view.feeBefore', 'p.proposed_fee - p.fee_before', 'fee - view.feeBefore', 'proposal.topup!.amount - paid']
            .every((code) => SUBTRACT.test(code))
        && !SUBTRACT.test('formatBotPrice(view.feeBefore, view.currency)'));
    assert('the renderer subtracts no fee from another', () => !SUBTRACT.test(renderer));
    assert('the read service subtracts no fee either — customerPays comes from W-E\'s plan or the frozen top-up', () =>
        !SUBTRACT.test(service)
        && service.includes('planCustomerApprovedIncrease(')
        && service.includes('customerFeeApplicationService.stateOf(')
        && service.includes('proposal.topup!.amount'));
    assert('the controller composes no figure (no subtraction of fees)', () => !SUBTRACT.test(controller));

    // ═════════════════════════════════════════════════════════════════════════
    section('8 · The writes are W-E\'s own, owner-scoped, and the charge is told in this chat');
    // ═════════════════════════════════════════════════════════════════════════

    assert('approve / reject / pay call DeliveryFeeProposalService\'s customer methods', () =>
        controller.includes('deliveryFeeProposalService.customerApprove(')
        && controller.includes('deliveryFeeProposalService.customerReject(')
        && controller.includes('deliveryFeeProposalService.customerPay('));

    assert('combined requests call CombinedDeliveryRequestService.create / cancel / listForCustomer', () =>
        controller.includes('combinedDeliveryRequestService.create(')
        && controller.includes('combinedDeliveryRequestService.cancel(')
        && controller.includes('combinedDeliveryRequestService.listForCustomer('));

    assert('the charge passes originChat, so its outcome reaches THIS conversation', () =>
        /customerPay\([\s\S]*?originChat:\s*req\.bot!\.envelope\.channel/.test(controller));

    assert('the amount is never read from a request — no `amount` in any fee schema', () => {
        const validators = stripComments(read('src/modules/bot-surface/validators/bot.validators.ts'));
        const at = validators.indexOf('BotDeliveryFeePendingSchema');
        const block = validators.slice(at, validators.indexOf('BotCombinedParamSchema', at));
        return at > 0 && !/\bamount\s*:/.test(block);
    });

    assert('every proposal read is owner-scoped on customer_id (404 otherwise)', () =>
        /proposal\.customer_id\.toString\(\) !== customerId/.test(service)
        && /customer_id: new Types\.ObjectId\(customerId\)/.test(service));

    assert('no controller is imported by the read service (it must stay a service)', () =>
        !/from '\.\.\/controllers\//.test(service));

    // ═════════════════════════════════════════════════════════════════════════
    section('9 · Validators');
    // ═════════════════════════════════════════════════════════════════════════

    assert('approve needs a positive integer version and nothing else', () =>
        BotDeliveryFeeApproveSchema.safeParse({ version: 3 }).success
        && !BotDeliveryFeeApproveSchema.safeParse({}).success
        && !BotDeliveryFeeApproveSchema.safeParse({ version: 0 }).success
        && !BotDeliveryFeeApproveSchema.safeParse({ version: '3' }).success
        && !BotDeliveryFeeApproveSchema.safeParse({ version: 3, amount: 100 }).success);

    assert('reject takes an optional note; pay takes an optional phone and refuses an amount', () =>
        BotDeliveryFeeRejectSchema.safeParse({ version: 1, note: 'too expensive' }).success
        && BotDeliveryFeeRejectSchema.safeParse({ version: 1 }).success
        && BotDeliveryFeePaySchema.safeParse({}).success
        && BotDeliveryFeePaySchema.safeParse({ phone: '672745831' }).success
        && !BotDeliveryFeePaySchema.safeParse({ amount: 300 }).success);

    assert('a combined request needs ids and at least two parcels when it names any', () =>
        BotCombinedCreateSchema.safeParse({ cartId: ORDER, agencyId: PROPOSAL }).success
        && !BotCombinedCreateSchema.safeParse({ cartId: ORDER, agencyId: PROPOSAL, shipmentIds: [SHIPMENT] }).success
        && !BotCombinedCreateSchema.safeParse({ cartId: 'x', agencyId: PROPOSAL }).success);

    // ═════════════════════════════════════════════════════════════════════════
    section('10 · The catalogue, the route table and the generator');
    // ═════════════════════════════════════════════════════════════════════════

    const catalog = readCatalog();
    const TIERS: Record<string, string> = {
        delivery_fees_list_pending: 'core',
        delivery_fees_reject: 'core',
        delivery_fees_approve: 'flow_only',
        delivery_fees_pay: 'flow_only',
        combined_delivery_eligible: 'core',
        combined_delivery_request: 'core',
        combined_delivery_list: 'extended',
        combined_delivery_cancel: 'extended',
    };

    assert('all eight rows are catalogued with their tiers', () =>
        Object.entries(TIERS).every(([name, tier]) => catalog.tools.find((t) => t.name === name)?.tier === tier));

    assert('⛔ the money-moving pair is flow_only and the generator never emits it; the other six it does', () => {
        const emitted = new Set(selectMcpTools(catalog).map((t) => t.name));
        return !emitted.has('delivery_fees_approve') && !emitted.has('delivery_fees_pay')
            && Object.keys(TIERS).filter((n) => TIERS[n] !== 'flow_only').every((n) => emitted.has(n));
    });

    assert('every row is mounted with the catalogue\'s method, path and mutating flag', () =>
        Object.keys(TIERS).every((name) => {
            const tool = catalog.tools.find((t) => t.name === name)!;
            const route = BOT_ROUTES.find((r) => r.tool === name);
            const expected = tool.operation.path.replace('/api/internal/bot', '').replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
            return !!route && route.method === tool.operation.method && route.path === expected && route.mutating === tool.mutating;
        }));

    assert('the model is told: quote the *Text fields, never compute, pass the version as data', () => {
        const list = catalog.tools.find((t) => t.name === 'delivery_fees_list_pending')!;
        const reject = catalog.tools.find((t) => t.name === 'delivery_fees_reject')!;
        const notes = `${list.platform_notes?.whatsapp ?? ''} ${list.description} ${list.when_not_to_use ?? ''}`;
        return /\*Text fields/.test(notes) && /never compute/i.test(notes) && /proposalId and version as data/.test(notes)
            && /verbatim/.test(reject.parameters.properties?.version?.description ?? '');
    });

    assert('no catalogue row lets the model send an amount', () =>
        Object.keys(TIERS).every((name) => !('amount' in (catalog.tools.find((t) => t.name === name)!.parameters.properties ?? {}))));

    assert('bot-surface.md documents every token in § 14.9 and the eight routes', () => {
        const doc = read('api-doc/n8n/bot-surface.md');
        const s149 = doc.slice(doc.indexOf('### 14.9'), doc.indexOf('## 15 ·'));
        return ['`dfee:list`', '`dfee:<orderId>`', '`dfee:<orderId>:<proposalId>`', '`dfee:pay:<proposalId>`',
            '`yes:dfc:<proposalId>:<version>`', '`no:dfc:<proposalId>:<version>`'].every((t) => s149.includes(`| ${t} |`))
            && Object.keys(TIERS).every((n) => doc.includes(`| \`${n}\` |`));
    });

    console.log(`\n${'─'.repeat(76)}`);
    console.log(`  ${passed} passed, ${failed} failed`);
    console.log(`${'─'.repeat(76)}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
