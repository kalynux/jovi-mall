/**
 * Test: the delivery company's REASON is shown in bold (owner, 2026-10-25), and the chat's answer
 * when a customer tries to propose a fee on a parcel the SHOP pays for.
 *
 * Three layers, each driven directly:
 *   1. `core/richtext` `strong()` — the channel-neutral mark and its four resolutions;
 *   2. the chat question (`feeChangeQuestion` → `renderBotReply`) on WhatsApp and Telegram;
 *   3. the notification (`order.delivery_fee.approval_needed`) on every channel it reaches,
 *      plus the template switch that must stay OFF until Meta approves v2.
 *
 * ⚠ The failure this guards is VISIBLE, not silent: a mark that escapes to a screen draws as a
 * box. So every non-chat output is asserted free of the two private-use code points.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework). DB-free.
 *
 * Run: npm run test:fee-reason-bold
 */
import fs from 'fs';
import path from 'path';
import {
    STRONG_CLOSE,
    STRONG_OPEN,
    strong,
    stripStrong,
    strongToTelegramEntities,
    strongToTelegramHtml,
    strongToWhatsApp,
    escapeTelegramHtml,
} from '../../src/core/richtext';
import { BotFeeChangeView, feeChangeQuestion } from '../../src/modules/bot-surface/domain/fee-change-chat-reply';
import { renderBotReply } from '../../src/modules/bot-surface/domain/channel-reply';
import { compactSentText } from '../../src/modules/bot-surface/domain/bot-recently-sent';
import { BOT_COPY_LANGUAGES, customerMessageFor } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { customerFeeLine } from '../../src/modules/delivery-fee-proposals/services/customer-fee-notifier';
import {
    customerWhatsAppTemplateName,
    renderCustomerChannelText,
    renderCustomerInApp,
    renderCustomerWhatsAppTemplateParams,
} from '../../src/modules/notifications/catalog/customer-notification-catalog';
import { toTelegramNotificationBody, toWhatsAppNotificationBody } from '../../src/modules/notifications/catalog/message-renderer';
import { ERROR_CODES } from '../../src/core/error-codes';
import { ERROR_CATEGORIES } from '../../src/core/error-category';

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
const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const noMarks = (text: string): boolean => !text.includes(STRONG_OPEN) && !text.includes(STRONG_CLOSE);

const REASON = 'Bulky parcel, needs a car';

function view(over: Partial<BotFeeChangeView> = {}): BotFeeChangeView {
    return {
        proposalId: 'b'.repeat(24),
        orderId: 'a'.repeat(24),
        orderNumber: 'WM-2026-000123',
        shipmentId: 'c'.repeat(24),
        version: 2,
        origin: 'agency',
        paymentMode: 'cod',
        state: 'awaiting_answer',
        currency: 'XAF',
        feeBefore: 1500,
        proposedFee: 2000,
        customerPays: 500,
        reason: REASON,
        availableActions: ['approve', 'reject'],
        ...over,
    };
}
const PAYER = { payerMasked: '+2376••••4567', storefrontOrderUrl: null };

function main(): void {
    console.log('\n═══ test:fee-reason-bold ═══════════════════════════════════════════════════');

    // ═════════════════════════════════════════════════════════════════════════
    section('1 · strong() and its four resolutions');
    // ═════════════════════════════════════════════════════════════════════════

    assert('strong() wraps; an empty phrase stays empty (an absent line adds nothing)', () =>
        strong('Hi') === `${STRONG_OPEN}Hi${STRONG_CLOSE}` && strong('') === '' && strong('  ') === '  ');

    assert('strong() never nests a mark inside a mark', () =>
        strong(strong('Hi')) === strong('Hi'));

    assert('stripStrong removes every mark, balanced or not', () =>
        stripStrong(`a ${strong('b')} c${STRONG_OPEN}`) === 'a b c');

    assert('WhatsApp: *run*, with edge spaces moved OUTSIDE the markers', () =>
        strongToWhatsApp(`x ${STRONG_OPEN} Reason: car. ${STRONG_CLOSE}y`) === 'x  *Reason: car.* y');

    assert('WhatsApp: a run containing a WhatsApp marker is sent UNBOLDED and unedited', () =>
        strongToWhatsApp(strong('Fee 5*7 needed')) === 'Fee 5*7 needed'
        && strongToWhatsApp(strong('snake_case')) === 'snake_case');

    assert('Telegram HTML: <b> added AFTER escaping, and the escaping survives', () =>
        strongToTelegramHtml(escapeTelegramHtml(`a < ${strong('b & c')}`)) === 'a &lt; <b>b &amp; c</b>');

    assert('Telegram entities: plain text, one bold entity at the UTF-16 offset (emoji before it)', () => {
        const { text, entities } = strongToTelegramEntities(`🚚 Hi\n${strong('Reason given: car.')}\nBye`);
        const e = entities[0];
        return text === '🚚 Hi\nReason given: car.\nBye'
            && entities.length === 1
            && text.slice(e.offset, e.offset + e.length) === 'Reason given: car.';
    });

    assert('Telegram entities: no mark → no entity and the text unchanged', () => {
        const { text, entities } = strongToTelegramEntities('plain');
        return text === 'plain' && entities.length === 0;
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('2 · The chat question (Accept · Decline) — the reason is bold on both chats');
    // ═════════════════════════════════════════════════════════════════════════

    const question = feeChangeQuestion(view(), 'en', PAYER);
    const wa = renderBotReply(question, 'whatsapp', '237600000000');
    const waJson = JSON.stringify(wa.body);
    assert('WhatsApp: the reason line arrives as *Reason given: …*', () =>
        waJson.includes(`*Reason given: ${REASON}*`));
    assert('WhatsApp: no mark survives anywhere in the payload (body, buttons)', () => noMarks(waJson));

    const tg = renderBotReply(question, 'telegram', '12345');
    const tgText = String(tg.body.text);
    const tgEntities = tg.body.entities as Array<{ type: string; offset: number; length: number }> | undefined;
    assert('Telegram: plain text plus ONE bold entity covering exactly the reason line', () =>
        !!tgEntities && tgEntities.length === 1 && tgEntities[0].type === 'bold'
        && tgText.slice(tgEntities[0].offset, tgEntities[0].offset + tgEntities[0].length) === `Reason given: ${REASON}`);
    assert('Telegram: no parse_mode was introduced and no mark survives', () =>
        tg.body.parse_mode === undefined && noMarks(JSON.stringify(tg.body)));

    assert('a reply with NO mark is rendered byte-identical to before (no entities key added)', () => {
        const plain = renderBotReply({ kind: 'text', text: 'hello' }, 'telegram', '12345');
        return !('entities' in plain.body);
    });

    assert('the recently-sent record (what the model reads) carries no mark', () =>
        noMarks(compactSentText(`Hi ${strong('Reason given: x.')}`)) && compactSentText(`Hi ${strong('R.')}`) === 'Hi R.');

    assert('a moved parcel still quotes no agency reason (unchanged rule)', () =>
        !JSON.stringify(renderBotReply(feeChangeQuestion(view({ origin: 'change_agency' }), 'en', PAYER), 'whatsapp', '2376')).includes(REASON));

    // ═════════════════════════════════════════════════════════════════════════
    section('3 · The notification — bold where a chat draws it, plain everywhere else');
    // ═════════════════════════════════════════════════════════════════════════

    const situation = 'order.delivery_fee.approval_needed' as const;
    const ctx = {
        currency: 'XAF',
        orderNumber: 'WM-2026-000123',
        feeBeforeFormatted: '1 500',
        proposedFeeFormatted: '2 000',
        reasonLine: strong(customerFeeLine('reason', 'en', { reason: REASON })),
    };

    const waText = renderCustomerChannelText(situation, 'whatsapp', 'en', ctx);
    assert('WhatsApp (in window): the body carries *Reason given: …* — it is sent as-is by the buttons message', () =>
        waText.body.includes(`*Reason given: ${REASON}.*`) && noMarks(waText.body) && noMarks(waText.subject));
    assert('WhatsApp plain-text composer: still bold, heading still bold, no mark', () => {
        const out = toWhatsAppNotificationBody(waText.subject, waText.body);
        return out.startsWith('*') && out.includes(`*Reason given: ${REASON}.*`) && noMarks(out);
    });

    const tgContent = renderCustomerChannelText(situation, 'telegram', 'en', ctx);
    const tgMessage = toTelegramNotificationBody(tgContent.subject, tgContent.body);
    assert('Telegram: <b>Reason given: …</b> in the HTML message, and no mark', () =>
        tgMessage.includes(`<b>Reason given: ${REASON}.</b>`) && noMarks(tgMessage));
    assert('Telegram: a reason with < & > is still escaped inside the bold run', () => {
        const hostile = { ...ctx, reasonLine: strong(customerFeeLine('reason', 'en', { reason: 'a<b>&c' })) };
        const c = renderCustomerChannelText(situation, 'telegram', 'en', hostile);
        return toTelegramNotificationBody(c.subject, c.body).includes('<b>Reason given: a&lt;b&gt;&amp;c.</b>');
    });

    const email = renderCustomerChannelText(situation, 'email', 'en', ctx);
    const inApp = renderCustomerInApp(situation, 'en', ctx);
    assert('email and the in-app inbox: the reason is there, plain, with no mark and no asterisk', () =>
        email.body.includes(`Reason given: ${REASON}.`) && noMarks(email.body) && !email.body.includes('*')
        && inApp.message.includes(`Reason given: ${REASON}.`) && noMarks(inApp.message) && noMarks(inApp.title));

    assert('the notifier marks the reason line strong (source scan)', () =>
        /reasonLine:\s*strong\(/.test(stripComments(read('src/modules/delivery-fee-proposals/services/customer-fee-notifier.ts'))));

    assert('a missing reason never yields an empty line (a template parameter may not be empty)', () =>
        BOT_COPY_LANGUAGES.every((lang) => customerFeeLine('no_reason', lang, {}).trim().length > 0));

    // ═════════════════════════════════════════════════════════════════════════
    section('4 · The template switch — v1 until Meta approves v2');
    // ═════════════════════════════════════════════════════════════════════════

    assert('the switch is OFF: the approved v1 name is sent, with its four parameters', () =>
        customerWhatsAppTemplateName(situation) === 'customer_order_delivery_fee_approval_needed'
        && renderCustomerWhatsAppTemplateParams(situation, 'en', ctx).length === 4);

    assert('template parameters never carry a mark', () =>
        renderCustomerWhatsAppTemplateParams(situation, 'en', ctx).every(noMarks));

    assert('the v2 payload to submit exists, en + fr, with the reason as a bold 5th parameter', () => {
        const file = JSON.parse(read('api-doc/notifications/pending/fee-reason-template-v2.json')) as {
            payloads: Array<{ name: string; language: string; components: Array<{ type: string; text?: string }> }>;
        };
        const langs = file.payloads.map((p) => p.language).sort().join(',');
        return langs === 'en,fr' && file.payloads.every((p) =>
            p.name === 'customer_order_delivery_fee_approval_needed_v2'
            && (p.components.find((c) => c.type === 'BODY')?.text ?? '').includes('*{{5}}*'));
    });

    // ═════════════════════════════════════════════════════════════════════════
    section('5 · Proposing on a parcel the SHOP pays for — the chat says who pays');
    // ═════════════════════════════════════════════════════════════════════════

    assert('DELIVERY_FEE_PROPOSAL_NOT_PAYER has its own chat sentence in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const text = customerMessageFor(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PAYER, ERROR_CATEGORIES.BUSINESS_RULE, lang);
            return text.length > 0 && text !== customerMessageFor('NO_SUCH_CODE', ERROR_CATEGORIES.BUSINESS_RULE, lang);
        }));
    assert('…and the English one says the SHOP pays the delivery', () =>
        /shop pays the delivery/i.test(customerMessageFor(ERROR_CODES.DELIVERY_FEE_PROPOSAL_NOT_PAYER, ERROR_CATEGORIES.BUSINESS_RULE, 'en')));

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();
