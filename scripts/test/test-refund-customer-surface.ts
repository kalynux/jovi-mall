/**
 * test:refund-customer-surface — the CUSTOMER half of the refund flow (REFUND-FLOW-PLAN § 8, R9).
 *
 * Offline. What it pins:
 *  1. **The status collapse** — seven internal statuses → six customer ones; `failed` is never
 *     shown (→ `in_progress`), `rejected` reads `declined`, an unknown value never leaks raw.
 *  2. **The refund block** — `null` when no request exists; gross/fee/net/percent; the number
 *     masked to its last three digits; `completedAt` only once completed; `waitingForCash`.
 *  3. **The fee line** — "You receive 4,900 XAF (5,000 minus a 2% transfer fee)." in EN and FR;
 *     a CARD refund (fee 0) never mentions a fee, in the notification or on the bot card.
 *  4. **Which situation** each status / channel raises — and the silent ones (failed, Support at
 *     the request stage, a card refund "sending").
 *  5. **Registration** — every new situation is in the model enum, the catalog (five languages),
 *     the template registry (same param count), the generated payloads (en + fr) and the
 *     approval doc; the consumer subscribes the event; the service publishes it.
 *  6. **The handlers**, measured on the real methods with the I/O stubbed.
 *
 * Run: npm run test:refund-customer-surface
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    CUSTOMER_REFUND_STATUS_OF,
    CUSTOMER_REFUND_STATUSES,
    toCustomerRefundBlock,
    toCustomerRefundStatus,
    CustomerRefundSourceRow,
} from '../../src/modules/payments/dto/customer-refund.dto';
import { REFUND_REQUEST_STATUSES } from '../../src/modules/payments/domain/refund-status';
import {
    CUSTOMER_NOTIFICATION_CATALOG,
    assertCustomerCatalogComplete,
    customerWhatsAppTemplateName,
    renderCustomerInApp,
    renderCustomerWhatsAppTemplateParams,
    refundAmountLine,
    refundDestinationLabel,
} from '../../src/modules/notifications/catalog/customer-notification-catalog';
import {
    CustomerNotificationEventHandler,
    customerRefundCompletedSituationFor,
    customerRefundSituationFor,
} from '../../src/modules/notifications/services/customer-notification-event-handler.service';
import {
    CUSTOMER_NOTIFICATION_TYPES,
    CustomerNotificationType,
} from '../../src/modules/notifications/models/customer-notification.model';
import { TemplateRegistry } from '../../src/modules/whatsapp/handlers/template/template-registry';
import {
    ORDER_REFUND_COPY,
    botRefundLine,
    botRefundStateLabel,
} from '../../src/modules/bot-surface/domain/bot-order-status-copy';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
import { toCustomerOrderDto } from '../../src/modules/orders/dto/customer-order.dto';
import { SUPPORTED_LANGUAGES } from '../../src/modules/notifications/catalog/notification-i18n';

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

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const NEW_SITUATIONS: Array<[CustomerNotificationType, string, number]> = [
    ['order.refund.requested', 'customer_order_refund_requested', 3],
    ['order.refund.waiting_for_cash', 'customer_order_refund_waiting_for_cash', 3],
    ['order.refund.sending', 'customer_order_refund_sending', 3],
    ['order.refund.completed', 'customer_order_refund_completed', 3],
    ['order.refund.paid_externally', 'customer_order_refund_paid_externally', 2],
    ['order.refund.declined', 'customer_order_refund_declined', 1],
    ['booking.refund.requested', 'customer_booking_refund_requested', 3],
    ['booking.refund.sending', 'customer_booking_refund_sending', 3],
    ['booking.refund.completed', 'customer_booking_refund_completed', 3],
    ['booking.refund.paid_externally', 'customer_booking_refund_paid_externally', 2],
    ['booking.refund.declined', 'customer_booking_refund_declined', 1],
];

function row(over: Partial<CustomerRefundSourceRow> = {}): CustomerRefundSourceRow {
    return {
        status: 'sending',
        gross_amount: 5000,
        fee_amount: 100,
        fee_rate: 2,
        net_amount: 4900,
        currency: 'XAF',
        channel: 'payout',
        destination: { phone: '+237677123512', name: 'Ama', source: 'payer' },
        completed_at: null,
        ...over,
    } as CustomerRefundSourceRow;
}

// ── Handler measurements (real methods, I/O stubbed) ────────────────────────────

type Sent = { situation: string; key: string; ctx: Record<string, string> };
const MEASURED: Record<string, Sent[]> = {};

async function measureHandlers(): Promise<void> {
    type H = {
        handleRefundStatusChanged(e: unknown): Promise<void>;
        handleOrderRefunded(e: unknown): Promise<void>;
        customerFromOrder: (orderId: string) => Promise<unknown>;
        notify: (p: { situation: string; idempotencyKey: string; context: Record<string, string> }) => Promise<void>;
    };
    const handler = Object.create(CustomerNotificationEventHandler.prototype) as unknown as H;
    const ORDER = '6aad69bac51c555c27cc10d7';
    handler.customerFromOrder = async () => ({
        customer: { _id: '6aad69bac51c555c27cc10d8', preferred_language: 'en' },
        orderNumber: 'ORD-2026-000001',
        currency: 'XAF',
    });
    const run = async (name: string, method: 'handleRefundStatusChanged' | 'handleOrderRefunded', eventType: string, payloads: Array<Record<string, unknown>>) => {
        const sent: Sent[] = [];
        handler.notify = async (p) => { sent.push({ situation: p.situation, key: p.idempotencyKey, ctx: p.context }); };
        for (const payload of payloads) await handler[method]({ eventType, payload, occurredAt: new Date() });
        MEASURED[name] = sent;
    };
    const base = {
        refundRequestId: 'rr1', sourceKind: 'order', orderId: ORDER, orderNumber: 'ORD-2026-000001',
        grossAmount: 5000, feeAmount: 100, feeRate: 2, netAmount: 4900, currency: 'XAF',
        paymentChannel: 'mobile_money', destinationMasked: '+•••••••••512',
    };
    await run('sendingPayout', 'handleRefundStatusChanged', 'refund.status_changed', [
        { ...base, status: 'sending', channel: 'payout', requestedByRole: 'vendor' },
        // A retry re-announces `sending`: same key, so the dispatcher's idempotency drops it.
        { ...base, status: 'sending', channel: 'payout', requestedByRole: 'vendor' },
    ]);
    await run('supportRequested', 'handleRefundStatusChanged', 'refund.status_changed', [
        { ...base, status: 'awaiting_approval', channel: null, requestedByRole: 'support' },
    ]);
    await run('vendorRequested', 'handleRefundStatusChanged', 'refund.status_changed', [
        { ...base, status: 'awaiting_approval', channel: null, requestedByRole: 'vendor' },
    ]);
    await run('failed', 'handleRefundStatusChanged', 'refund.status_changed', [
        { ...base, status: 'failed', channel: 'payout', requestedByRole: 'vendor' },
    ]);
    await run('completedPayout', 'handleOrderRefunded', 'payment.refunded', [
        { orderId: ORDER, sourceKind: 'order', refundId: 'rt1', refundRequestId: 'rr1', amount: 4900, grossAmount: 5000, feeAmount: 100, feeRate: 2, netAmount: 4900, currency: 'XAF', channel: 'payout', destinationMasked: '+•••••••••512' },
    ]);
    await run('completedCard', 'handleOrderRefunded', 'payment.refunded', [
        { orderId: ORDER, sourceKind: 'order', refundId: 'rt2', refundRequestId: 'rr2', amount: 5000, grossAmount: 5000, feeAmount: 0, feeRate: 0, netAmount: 5000, currency: 'XAF', channel: 'card_refund' },
    ]);
    await run('completedExternal', 'handleOrderRefunded', 'payment.refunded', [
        { orderId: ORDER, sourceKind: 'order', refundId: 'rt3', refundRequestId: 'rr3', amount: 4900, grossAmount: 5000, feeAmount: 100, feeRate: 2, netAmount: 4900, currency: 'XAF', channel: 'external' },
    ]);
}

function main(): void {
    console.log('\n── 1 · The status collapse ──');
    const expected: Record<string, string> = {
        awaiting_approval: 'requested',
        approved: 'requested',
        waiting_for_cash: 'waiting_for_cash',
        sending: 'sending',
        failed: 'in_progress',
        completed: 'completed',
        rejected: 'declined',
    };
    assert('the collapse table matches the plan, status by status', () =>
        REFUND_REQUEST_STATUSES.every((s) => CUSTOMER_REFUND_STATUS_OF[s] === expected[s]));
    assert('the table is total over the internal statuses (7) and lands in the 6 customer ones', () =>
        Object.keys(CUSTOMER_REFUND_STATUS_OF).length === REFUND_REQUEST_STATUSES.length
        && new Set(Object.values(CUSTOMER_REFUND_STATUS_OF)).size === CUSTOMER_REFUND_STATUSES.length);
    assert('⛔ "failed" is never a customer status', () =>
        !(CUSTOMER_REFUND_STATUSES as readonly string[]).includes('failed') && toCustomerRefundStatus('failed') === 'in_progress');
    assert('an unknown internal value reads in_progress — never raw, never "completed"', () =>
        toCustomerRefundStatus('some_new_status') === 'in_progress');

    console.log('\n── 2 · The refund block ──');
    assert('no refund request → null', () => toCustomerRefundBlock(null) === null && toCustomerRefundBlock(undefined) === null);
    assert('a payout in flight: gross / fee / percent / net / channel carried, waitingForCash false', () => {
        const b = toCustomerRefundBlock(row())!;
        return b.status === 'sending' && b.grossAmount === 5000 && b.feeAmount === 100 && b.feePercent === 2
            && b.netAmount === 4900 && b.currency === 'XAF' && b.channel === 'payout' && b.waitingForCash === false
            && b.completedAt === null;
    });
    assert('the number is masked to its last three digits — never the full number', () => {
        const b = toCustomerRefundBlock(row())!;
        return b.destinationMasked !== null && b.destinationMasked.endsWith('512')
            && !b.destinationMasked.includes('677123') && b.destinationMasked.startsWith('+');
    });
    assert('a card refund: no destination, fee 0', () => {
        const b = toCustomerRefundBlock(row({ channel: 'card_refund', destination: null, fee_amount: 0, fee_rate: 0, net_amount: 5000 }))!;
        return b.destinationMasked === null && b.feeAmount === 0 && b.netAmount === 5000;
    });
    assert('COD waiting for cash → waitingForCash true', () =>
        toCustomerRefundBlock(row({ status: 'waiting_for_cash', channel: null }))!.waitingForCash === true);
    assert('completedAt is set only once completed (ISO)', () => {
        const at = new Date('2026-10-05T10:00:00Z');
        const done = toCustomerRefundBlock(row({ status: 'completed', completed_at: at }))!;
        const notYet = toCustomerRefundBlock(row({ status: 'sending', completed_at: at }))!;
        return done.completedAt === at.toISOString() && notYet.completedAt === null;
    });
    assert('rejected → "declined", and the block carries no rejection reason', () => {
        const b = toCustomerRefundBlock({ ...row({ status: 'rejected' }), rejection_reason: 'internal note' } as CustomerRefundSourceRow)!;
        return b.status === 'declined' && !JSON.stringify(b).includes('internal note');
    });
    assert('the block exposes exactly the documented keys', () =>
        JSON.stringify(Object.keys(toCustomerRefundBlock(row())!).sort()) === JSON.stringify(
            ['channel', 'completedAt', 'currency', 'destinationMasked', 'feeAmount', 'feePercent', 'grossAmount', 'netAmount', 'status', 'waitingForCash'].sort()));

    console.log('\n── 2b · The order DTO carries it ──');
    const order = {
        _id: '6aad69bac51c555c27cc10d7', order_number: 'ORD-1', cart_id: null, vendor_id: '6aad69bac51c555c27cc10d9',
        order_type: 'digital', total_amount: 5000, currency: 'XAF',
        price_breakdown: { base: 5000, delivery: 0, tax: 0, discount: 0, total: 5000 },
        payment_method: 'mobile_money', payment_status: 'paid', fulfillment_status: 'fulfilled', items: [],
        created_at: new Date(), updated_at: new Date(),
    } as unknown as Parameters<typeof toCustomerOrderDto>[0]['order'];
    const dtoInput = { order, storeName: null, storeSlug: null, storeVerified: false, imagesByKey: new Map() };
    assert('an order with no refund request projects refund: null (present, never absent)', () => {
        const dto = toCustomerOrderDto(dtoInput);
        return 'refund' in dto && dto.refund === null;
    });
    assert('an order with one projects the block unchanged', () =>
        toCustomerOrderDto({ ...dtoInput, refund: toCustomerRefundBlock(row()) }).refund?.netAmount === 4900);

    console.log('\n── 3 · The fee line ──');
    const money = { netAmount: 4900, grossAmount: 5000, feeAmount: 100, feePercent: 2, currency: 'XAF' };
    assert('EN: "You receive 4,900 XAF (5,000 minus a 2% transfer fee)."', () =>
        refundAmountLine(money, 'en') === 'You receive 4,900 XAF (5,000 minus a 2% transfer fee).');
    assert('FR: "Vous recevez 4,900 XAF (5,000 moins des frais de transfert de 2 %)."', () =>
        refundAmountLine(money, 'fr') === 'Vous recevez 4,900 XAF (5,000 moins des frais de transfert de 2 %).');
    assert('every language has a fee line and a no-fee line, never empty', () =>
        SUPPORTED_LANGUAGES.every((l) => refundAmountLine(money, l).includes('4,900') && refundAmountLine(money, l).includes('5,000')
            && refundAmountLine({ ...money, feeAmount: 0, feePercent: 0, netAmount: 5000 }, l).length > 0));
    assert('⛔ a card refund (fee 0) says nothing about a fee — EN and FR', () => {
        const card = { netAmount: 5000, grossAmount: 5000, feeAmount: 0, feePercent: 0, currency: 'XAF' };
        return refundAmountLine(card, 'en') === 'You receive 5,000 XAF.'
            && refundAmountLine(card, 'fr') === 'Vous recevez 5,000 XAF.';
    });
    assert('⛔ a completed CARD refund is order.refunded — full amount, and its copy names no fee', () => {
        const situation = customerRefundCompletedSituationFor('order', 'card_refund');
        const en = renderCustomerInApp(situation, 'en', { currency: 'XAF', amountFormatted: '5,000', orderNumber: 'ORD-1' });
        const fr = renderCustomerInApp(situation, 'fr', { currency: 'XAF', amountFormatted: '5,000', orderNumber: 'ORD-1' });
        return situation === 'order.refunded' && !/fee/i.test(en.message) && !/frais/i.test(fr.message)
            && customerRefundCompletedSituationFor('booking', 'card_refund') === 'booking.refunded'
            && customerRefundCompletedSituationFor('order', undefined) === 'order.refunded';
    });
    assert('a missing destination renders a localized phrase, never an empty parameter', () =>
        refundDestinationLabel(null, 'en') === 'your mobile money number' && refundDestinationLabel('', 'fr').length > 0
        && refundDestinationLabel('+•••512', 'en') === '+•••512');

    console.log('\n── 4 · Which situation each status raises ──');
    const S = (status: string, role: string | null, channel: string | null = 'payout', sourceKind = 'order') =>
        customerRefundSituationFor({ sourceKind, status, requestedByRole: role, channel });
    assert('requested: vendor / system / admin are told; Support and the customer are not', () =>
        S('awaiting_approval', 'vendor', null) === 'order.refund.requested'
        && S('awaiting_approval', 'system', null) === 'order.refund.requested'
        && S('approved', 'admin', null) === 'order.refund.requested'
        && S('awaiting_approval', 'support', null) === null
        && S('awaiting_approval', 'customer', null) === null);
    assert('waiting_for_cash → order.refund.waiting_for_cash; never for a booking', () =>
        S('waiting_for_cash', 'admin', null) === 'order.refund.waiting_for_cash'
        && S('waiting_for_cash', 'admin', null, 'booking') === null);
    assert('sending → *.refund.sending for a payout; a card "sending" is silent', () =>
        S('sending', 'vendor') === 'order.refund.sending'
        && S('sending', 'system', 'payout', 'booking') === 'booking.refund.sending'
        && S('sending', 'vendor', 'card_refund') === null);
    assert('rejected → *.refund.declined, whoever raised it', () =>
        S('rejected', 'support', null) === 'order.refund.declined'
        && S('rejected', 'vendor', null, 'booking') === 'booking.refund.declined');
    assert('⛔ failed is never announced; completed comes from payment.refunded', () =>
        S('failed', 'vendor') === null && S('completed', 'vendor') === null);
    assert('a billing source (plan purchase, credit top-up) raises nothing for the customer stack', () =>
        S('sending', 'admin', 'payout', 'plan_purchase') === null);
    assert('completed: payout → *.refund.completed, external → *.refund.paid_externally', () =>
        customerRefundCompletedSituationFor('order', 'payout') === 'order.refund.completed'
        && customerRefundCompletedSituationFor('order', 'external') === 'order.refund.paid_externally'
        && customerRefundCompletedSituationFor('booking', 'payout') === 'booking.refund.completed'
        && customerRefundCompletedSituationFor('booking', 'external') === 'booking.refund.paid_externally');

    console.log('\n── 5 · Registration ──');
    const registry = new TemplateRegistry();
    const payloads = JSON.parse(read('api-doc/notifications/whatsapp-template-payloads.json')) as { payloads: Array<{ name: string; language: string }> };
    const approvalDoc = read('api-doc/notifications/whatsapp-templates.md');
    assert('the boot assertion passes with the new situations', () => { assertCustomerCatalogComplete(); return true; });
    for (const [situation, template, params] of NEW_SITUATIONS) {
        assert(`${situation}: enum + catalog (5 languages) + template ${template} (${params} params) + registry + payloads en/fr + approval doc`, () => {
            const entry = CUSTOMER_NOTIFICATION_CATALOG[situation];
            const rendered = renderCustomerWhatsAppTemplateParams(situation, 'en', {
                orderNumber: 'ORD-1', serviceName: 'Haircut', currency: 'XAF', amountFormatted: '5,000',
                destination: '+•••512', amountLine: 'You receive 4,900 XAF (5,000 minus a 2% transfer fee).',
            });
            return CUSTOMER_NOTIFICATION_TYPES.includes(situation)
                && SUPPORTED_LANGUAGES.every((l) => !!entry.base[l]?.subject && !!entry.base[l]?.body)
                && customerWhatsAppTemplateName(situation) === template
                && rendered.length === params && rendered.every((p) => p.trim() !== '')
                && ['en', 'fr'].every((l) => registry.get(template, l)?.components?.body === params)
                && ['en', 'fr'].every((l) => payloads.payloads.some((p) => p.name === template && p.language === l))
                && approvalDoc.includes(`\`${template}\``);
        });
    }
    assert('the money situations carry the amount line and the masked number in their body', () =>
        ['order.refund.sending', 'order.refund.completed', 'booking.refund.sending', 'booking.refund.completed']
            .every((s) => CUSTOMER_NOTIFICATION_CATALOG[s as CustomerNotificationType].base.en.body.includes('{{amountLine}}')
                && CUSTOMER_NOTIFICATION_CATALOG[s as CustomerNotificationType].base.en.body.includes('{{destination}}')));
    assert('declined copy quotes no administrator reason', () =>
        ['order.refund.declined', 'booking.refund.declined'].every((s) =>
            SUPPORTED_LANGUAGES.every((l) => !/reason|\{\{rejection/i.test(CUSTOMER_NOTIFICATION_CATALOG[s as CustomerNotificationType].base[l].body))));

    const consumer = read('src/modules/notifications/customer-notification-event-consumer.ts');
    const service = read('src/modules/payments/services/refund-request.service.ts');
    const handlerSrc = read('src/modules/notifications/services/customer-notification-event-handler.service.ts');
    assert('the consumer subscribes refund.status_changed and the booking half of payment.refunded', () =>
        consumer.includes("eventBus.subscribe('refund.status_changed', handler.handleRefundStatusChanged.bind(handler));")
        && consumer.includes("eventBus.subscribe('payment.refunded', handler.handleBookingRefunded.bind(handler));"));
    assert('RefundRequestService publishes refund.status_changed, and payment.refunded carries feeRate', () =>
        service.includes("eventBus.publish('refund.status_changed'") && /feeRate: completed\.fee_rate/.test(service));
    assert('booking.payment.updated no longer maps refunded / refund_pending (no double message)', () =>
        !/p\.paymentStatus === 'refund_pending'/.test(handlerSrc) && !/p\.paymentStatus === 'refunded'\s*\n?\s*\?/.test(handlerSrc));

    console.log('\n── 6 · The handlers ──');
    assert('payout sending → ONE order.refund.sending per request (a re-announce reuses the key)', () => {
        const s = MEASURED.sendingPayout;
        return s.length === 2 && s.every((x) => x.situation === 'order.refund.sending') && s[0].key === s[1].key
            && s[0].key === 'customer.order.refund.sending:rr1';
    });
    assert('…its context carries the masked number and the EN fee line', () => {
        const c = MEASURED.sendingPayout[0].ctx;
        return c.destination === '+•••••••••512' && c.amountLine === 'You receive 4,900 XAF (5,000 minus a 2% transfer fee).';
    });
    assert('a Support request is not announced; a vendor one is', () =>
        MEASURED.supportRequested.length === 0 && MEASURED.vendorRequested.length === 1
        && MEASURED.vendorRequested[0].situation === 'order.refund.requested' && MEASURED.vendorRequested[0].ctx.amountFormatted === '5,000');
    assert('⛔ a failed transfer sends nothing', () => MEASURED.failed.length === 0);
    assert('payment.refunded payout → order.refund.completed with the fee line', () =>
        MEASURED.completedPayout.length === 1 && MEASURED.completedPayout[0].situation === 'order.refund.completed'
        && MEASURED.completedPayout[0].ctx.amountLine.includes('2% transfer fee'));
    assert('payment.refunded card → order.refunded, FULL amount, legacy key kept', () =>
        MEASURED.completedCard.length === 1 && MEASURED.completedCard[0].situation === 'order.refunded'
        && MEASURED.completedCard[0].ctx.amountFormatted === '5,000'
        && MEASURED.completedCard[0].key === 'customer.order.refunded:6aad69bac51c555c27cc10d7:rt2');
    assert('payment.refunded external → order.refund.paid_externally', () =>
        MEASURED.completedExternal.length === 1 && MEASURED.completedExternal[0].situation === 'order.refund.paid_externally');

    console.log('\n── 7 · The bot card line ──');
    const fmt = (n: number, c: string) => `${new Intl.NumberFormat('en-US').format(n)} ${c}`;
    assert('the refund copy table is total over the customer statuses, in every bot language', () =>
        CUSTOMER_REFUND_STATUSES.every((s) => BOT_COPY_LANGUAGES.every((l) => !!ORDER_REFUND_COPY[s]?.[l])));
    assert('payout line: label · NET (gross minus the fee)', () =>
        botRefundLine(toCustomerRefundBlock(row())!, 'en', fmt) === 'Refund being sent · 4,900 XAF (5,000 XAF minus a 2% transfer fee)');
    assert('⛔ card line: no fee note', () =>
        botRefundLine(toCustomerRefundBlock(row({ status: 'completed', channel: 'card_refund', destination: null, fee_amount: 0, fee_rate: 0, net_amount: 5000 }))!, 'fr', fmt)
            === 'Remboursé · 5,000 XAF');
    assert('declined line carries no amount; an unknown status never leaks', () =>
        botRefundLine(toCustomerRefundBlock(row({ status: 'rejected' }))!, 'en', fmt) === 'Refund declined'
        && botRefundStateLabel('weird', 'en') === 'Status not available');

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
}

measureHandlers().then(main, (error: unknown) => {
    console.error('measurement failed:', error);
    process.exit(1);
});
