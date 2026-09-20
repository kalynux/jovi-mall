/**
 * Test: the customer notification stack + booking balance settlement.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no
 * framework). DB-free.
 *
 * What it pins, and why each one is worth a test:
 *
 *  1. **Catalog completeness in all five languages.** The consumer asserts this at
 *     boot, so a gap is a crash on deploy rather than a silent English fallback.
 *  2. **Catalog ↔ model-enum agreement.** The agent stack kept two hand-maintained
 *     lists and they drifted — eight situations were in the union and absent from
 *     the schema enum, so every agent contract notification threw a Mongoose
 *     ValidationError and the agent was never told. Both stacks now derive the
 *     enum from one array; these tests are what stop that regressing.
 *  3. **WhatsApp param counts.** Meta rejects a send whose parameter count differs
 *     from the approved template, and the failure surfaces only at delivery time,
 *     to one customer, in a log.
 *  4. **Which situations can be muted.** Money and cancellations must not be
 *     silenceable — a preference key appearing on one of them is a real bug.
 *  5. **The settlement arithmetic** — balance vs credit against what was actually
 *     PAID, not what was quoted.
 *
 * Run: npm run test:customer-notifications
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseBotActionId } from '../../src/modules/bot-surface/domain/bot-action-id';
import { actionKeyOf } from '../../src/modules/bot-surface/domain/bot-action-dispatch';
import { parseTicketTap } from '../../src/modules/bot-surface/domain/bot-ticket-actions';
import {
    CUSTOMER_NOTIFICATION_CATALOG,
    assertCustomerCatalogComplete,
    assertCustomerQuickRepliesSendable,
    renderCustomerInApp,
    renderCustomerWhatsAppTemplateParams,
    renderCustomerButton,
    renderCustomerQuickReplies,
    viewLineFor,
    customerWhatsAppTemplateName,
    deliveryFailureLine,
    codReadyLine,
    ticketReopenLine
} from '../../src/modules/notifications/catalog/customer-notification-catalog';
import { customerTicketSituationFor } from '../../src/modules/notifications/services/customer-notification-event-handler.service';
import { SHIPMENT_FAILURE_REASONS } from '../../src/modules/shipments/shipment.model';
import {
    CUSTOMER_AGGREGATE_TYPES,
    CUSTOMER_NOTIFICATION_TYPES,
    CustomerNotificationModel,
    CustomerNotificationType
} from '../../src/modules/notifications/models/customer-notification.model';
import { AGENT_NOTIFICATION_TYPES } from '../../src/modules/notifications/models/agent-notification.model';
import { AGENT_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/agent-notification-catalog';
import {
    SUPPORTED_LANGUAGES,
    Language,
    TEMPLATE_LANGUAGES,
    META_LANGUAGE_CODE,
    templateLanguage
} from '../../src/modules/notifications/catalog/notification-i18n';

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

/**
 * Situations that must NEVER be gated by a preference. Mirrors the absent keys in
 * the handler's SITUATION_PREFERENCE table — a customer is the counterparty to
 * someone else's action here, not the owner of a dashboard.
 */
const UNMUTABLE: CustomerNotificationType[] = [
    'booking.cancelled',
    'booking.payment.received',
    // Money, on the same footing as the line above: it is the RECEIPT for a balance the
    // platform asked for in `booking.balance.due`, and a setting that silenced it would
    // leave somebody who has just paid unsure whether it landed.
    'booking.balance.received',
    'booking.balance.due',
    'booking.refunded',
    'booking.refund.pending',
    'order.cancelled',
    'order.payment.received',
    'order.refunded',
    // The card payment page (GAP-008 + GAP-012). Money, so ungated on the same rule as
    // the rest of this list — and a page the customer asked for in a chat must not be
    // silenced by a setting about order progress.
    'order.payment_link',
    // A declined charge, and unmutable for the same reason as the line above plus a sharper
    // one: it is the ANSWER to something the customer did thirty seconds ago. A preference
    // about "order progress" silencing it would leave somebody who just tried to pay
    // believing the payment worked — the precise silence this situation was added to end.
    'order.payment_failed',
    // The same silence one product type over, and unmutable for the same two reasons: it is
    // money, and it answers something the customer did minutes ago. An online booking payment
    // was never announced in either direction until 2026-09-16.
    'booking.payment_failed',
    // The three GAP-012 support situations, and NOT on the counterparty argument the rest
    // of this list rests on — a support request is the customer's own. Narrower: all three
    // are the ANSWER to a question they asked, and `awaiting_customer` is the platform
    // saying it is blocked on them. A preference silencing those would mute the reply to
    // your own question and then hold the request open waiting for you.
    'ticket.replied',
    'ticket.awaiting_customer',
    'ticket.resolved'
];

/** Expected WhatsApp body-param counts, mirroring the template registry. */
const EXPECTED_WA_PARAMS: Record<CustomerNotificationType, number> = {
    'booking.created': 3,
    'booking.confirmed': 3,
    'booking.rescheduled': 3,
    'booking.cancelled': 3,
    'booking.completed': 4,
    'booking.reminder': 4,
    'booking.payment.received': 4,
    // currency + amount + serviceName, and deliberately NO startAt — the appointment is already
    // over by the time a balance is settled, so a time here reads as a future visit. The same
    // reason `booking.payment_failed` omits one, arrived at from the opposite direction: that
    // situation needs ONE sentence true of both purposes, this one is the balance's own.
    'booking.balance.received': 3,
    // currency + amount + serviceName, and deliberately NO startAt: the same sentence must be true
    // for a balance paid after the appointment, where a time reads as a future visit.
    'booking.payment_failed': 3,
    'booking.balance.due': 5,
    'booking.refunded': 3,
    'booking.refund.pending': 3,
    'order.created': 5,
    'order.payment.received': 4,
    'order.shipped': 3,
    'order.out_for_delivery': 1,
    'order.delivered': 1,
    'order.delivery_failed': 1,
    'order.cancelled': 1,
    'order.refunded': 3,
    'order.payment_link': 4,
    // currency + amount + orderNumber. The amount is carried so a customer with two orders
    // in flight can tell which one failed.
    'order.payment_failed': 3,
    'ticket.replied': 1,
    'ticket.awaiting_customer': 1,
    // TWO, and the second is a whole sentence. Whether the customer may still reply
    // depends on resolved-vs-closed, so it travels as a parameter rather than being baked
    // into the approved template body — which would make one of the two outcomes a lie.
    'ticket.resolved': 2
};

/** The settlement arithmetic, mirroring CompletionPricingService. */
function settle(finalPrice: number, amountPaid: number) {
    return {
        balanceDue: Math.max(0, finalPrice - amountPaid),
        creditDue: Math.max(0, amountPaid - finalPrice)
    };
}

/** What a cash settlement credits, mirroring BookingService.settleBalanceByCash. */
function cashSettle(balanceDue: number, balancePaid: number, declared?: number) {
    const outstanding = balanceDue - balancePaid;
    if (outstanding <= 0) return null; // already settled
    return Math.min(outstanding, Math.round(declared ?? outstanding));
}

function main(): void {
    console.log('\n── Catalog completeness (the boot-time assert) ──');

    assert('assertCustomerCatalogComplete passes', () => {
        assertCustomerCatalogComplete();
        return true;
    });

    assert('every situation has base copy in all five languages', () => {
        for (const situation of CUSTOMER_NOTIFICATION_TYPES) {
            for (const lang of SUPPORTED_LANGUAGES) {
                const base = CUSTOMER_NOTIFICATION_CATALOG[situation]?.base?.[lang as Language];
                if (!base?.subject || !base?.body) return false;
            }
        }
        return true;
    });

    assert('no translation was left as a copy of the English', () => {
        // A pasted placeholder is the realistic way a "complete" catalog ships
        // untranslated — the assert above would pass on it.
        for (const situation of CUSTOMER_NOTIFICATION_TYPES) {
            const en = CUSTOMER_NOTIFICATION_CATALOG[situation].base.en.body;
            for (const lang of ['fr', 'pt', 'es', 'ar'] as Language[]) {
                if (CUSTOMER_NOTIFICATION_CATALOG[situation].base[lang].body === en) return false;
            }
        }
        return true;
    });

    console.log('\n── Catalog ↔ model enum (the drift that bit the agent stack) ──');

    // 25 = the 18 this stack shipped with, plus GAP-012's three `ticket.*`, the card
    // payment page, `order.payment_failed` — the silence that used to follow a declined
    // charge — `booking.payment_failed`, the same silence for an appointment, and
    // `booking.balance.received` (phase 10), the LAST of that set: a balance paid after the
    // appointment used to return early rather than reuse a "see you then" sentence that had
    // become false, which told the customer nothing at all. The literal
    // is kept rather than derived: this assertion's whole job is to notice a situation appearing
    // on one side and not the other, and `catalog.length === model.length` would pass happily
    // while both drifted away from what anybody meant.
    assert('catalog and model enum list the same 25 situations', () => {
        const catalog = Object.keys(CUSTOMER_NOTIFICATION_CATALOG).sort();
        const model = [...CUSTOMER_NOTIFICATION_TYPES].sort();
        return catalog.length === 25 && JSON.stringify(catalog) === JSON.stringify(model);
    });

    // The aggregate enum is spread from CUSTOMER_AGGREGATE_TYPES rather than hand-kept —
    // it WAS a literal, and GAP-012's `ticket` is exactly the value that would have been
    // added to the union and forgotten here, throwing a ValidationError on every ticket
    // notification. Same drift, same stack, one situation later.
    assert('the aggregate enum is spread from the array, not re-typed', () => {
        const declared = CustomerNotificationModel.schema.path('aggregateType') as unknown as {
            enumValues?: string[];
        };
        const enumValues = [...(declared.enumValues ?? [])].sort();
        return JSON.stringify(enumValues) === JSON.stringify([...CUSTOMER_AGGREGATE_TYPES].sort());
    });

    assert('AGENT catalog and enum agree too (the regression that shipped)', () => {
        // The agent enum was missing all eight agent_contract.* situations, so
        // writing one threw a ValidationError and the notification vanished.
        const catalog = Object.keys(AGENT_NOTIFICATION_CATALOG).sort();
        const model = [...AGENT_NOTIFICATION_TYPES].sort();
        return JSON.stringify(catalog) === JSON.stringify(model);
    });

    assert('the agent enum includes every agent_contract situation', () =>
        AGENT_NOTIFICATION_TYPES.filter(t => t.startsWith('agent_contract.')).length === 8);

    console.log('\n── WhatsApp template contract ──');

    assert('every situation declares a template name', () =>
        CUSTOMER_NOTIFICATION_TYPES.every(s => !!customerWhatsAppTemplateName(s)));

    assert('template names are unique', () => {
        const names = CUSTOMER_NOTIFICATION_TYPES.map(customerWhatsAppTemplateName);
        return new Set(names).size === names.length;
    });

    assert('template names are all customer_-prefixed', () =>
        CUSTOMER_NOTIFICATION_TYPES.every(s =>
            customerWhatsAppTemplateName(s).startsWith('customer_')));

    /**
     * ⚠ **The approval doc is the difference between a template existing and WORKING.** All
     * eighteen customer templates were registered in code and documented nowhere until
     * 2026-08-26, which is the same thing as not existing: an unapproved template fails on
     * send, and one nobody wrote down never gets approved. This assertion is what stops a
     * situation being added with copy that no operator can act on.
     */
    assert('⚠ every customer template has approval copy in the templates doc', () => {
        const doc = readFileSync(
            join(__dirname, '..', '..', 'api-doc', 'notifications', 'whatsapp-templates.md'),
            'utf8'
        );
        const missing = CUSTOMER_NOTIFICATION_TYPES
            .map(customerWhatsAppTemplateName)
            .filter(name => !doc.includes(`\`${name}\``));
        if (missing.length) console.error('     ↳', missing.join(', '));
        return missing.length === 0;
    });

    assert('body-param counts match the registered templates', () => {
        for (const situation of CUSTOMER_NOTIFICATION_TYPES) {
            const rendered = renderCustomerWhatsAppTemplateParams(situation, 'en', {
                serviceName: 'Haircut',
                vendorName: 'Salon A',
                orderNumber: 'ORD-1',
                trackingNumber: 'ACR-1',
                currency: 'XAF',
                amountFormatted: '5,000',
                balanceFormatted: '1,000',
                startAt: '2026-08-10 14:00'
            });
            if (rendered.length !== EXPECTED_WA_PARAMS[situation]) {
                console.error(
                    `      ${situation}: got ${rendered.length}, expected ${EXPECTED_WA_PARAMS[situation]}`
                );
                return false;
            }
        }
        return true;
    });

    console.log('\n── Rendering ──');

    assert('placeholders are substituted, not left in the output', () => {
        const rendered = renderCustomerInApp('booking.reminder', 'en', {
            serviceName: 'Haircut',
            vendorName: 'Salon A',
            whenPhrase: 'tomorrow',
            startAt: '2026-08-10 14:00'
        });
        return rendered.title.includes('Haircut')
            && rendered.message.includes('Salon A')
            && rendered.message.includes('tomorrow')
            && !rendered.message.includes('{{');
    });

    assert('each language renders its own copy', () => {
        const ctx = { serviceName: 'Haircut', vendorName: 'Salon A', startAt: '2026-08-10 14:00' };
        const en = renderCustomerInApp('booking.confirmed', 'en', ctx).title;
        const fr = renderCustomerInApp('booking.confirmed', 'fr', ctx).title;
        const ar = renderCustomerInApp('booking.confirmed', 'ar', ctx).title;
        return en !== fr && fr !== ar && en.includes('Haircut') && fr.includes('Haircut');
    });

    assert('an unknown language falls back to the default rather than throwing', () => {
        const rendered = renderCustomerInApp('booking.confirmed', 'de' as Language, {
            serviceName: 'Haircut'
        });
        return rendered.title.includes('Haircut');
    });

    assert('booking buttons deep-link to the booking', () => {
        const button = renderCustomerButton(
            'booking.confirmed', 'en', { bookingId: 'B1' }, 'https://shop.example'
        );
        return button?.url === 'https://shop.example/shop/account/bookings/B1';
    });

    assert('the balance-due button points at the payment page, not the booking', () => {
        const button = renderCustomerButton(
            'booking.balance.due', 'en', { bookingId: 'B1' }, 'https://shop.example'
        );
        return button?.url === 'https://shop.example/shop/account/bookings/B1/balance';
    });

    assert('a missing base URL yields a relative path, not "undefined/..."', () => {
        const button = renderCustomerButton('order.delivered', 'en', { orderId: 'O1' }, undefined);
        return button?.url === 'shop/account/orders/detail/O1';
    });

    assert('a trailing slash on the base URL does not double up', () => {
        const button = renderCustomerButton(
            'order.delivered', 'en', { orderId: 'O1' }, 'https://shop.example/'
        );
        return button?.url === 'https://shop.example/shop/account/orders/detail/O1';
    });

    /**
     * ── The addresses themselves ────────────────────────────────────────────────
     *
     * Every button in this catalogue pointed at a page that does not exist until
     * 2026-09-07: the tails were bare nouns (`orders/{{id}}`) while the shop serves
     * `/shop/account/orders/…`. Nothing could catch it — a wrong link is only ever
     * wrong in the customer's browser, and the four assertions above were written
     * against the broken values and passed.
     *
     * ⚠ **This group cannot prove the storefront serves these paths** (different
     * repository, no shared package). What it CAN do is refuse the two shapes that
     * are wrong on their face — a bare tail with no section, and a leading slash —
     * and pin the two addresses the storefront still owes, so re-pointing one is a
     * deliberate edit rather than a silent drift.
     */
    console.log('\n── Button addresses vs the storefront route tree ──');

    /** Every distinct suffix in the catalogue, deduplicated. */
    const allSuffixes = [...new Set(
        CUSTOMER_NOTIFICATION_TYPES
            .map((t) => CUSTOMER_NOTIFICATION_CATALOG[t].button?.urlSuffix)
            .filter((s): s is string => typeof s === 'string')
    )];

    assert('every button carries a suffix and there are six distinct ones', () =>
        allSuffixes.length === 6);

    assert('no suffix has a leading slash (Meta supplies the separator)', () =>
        allSuffixes.every((s) => !s.startsWith('/')));

    assert('no suffix carries a locale prefix (renderCustomerButton adds it)', () =>
        allSuffixes.every((s) => !/^(en|fr|pt|es|ar)\//.test(s)));

    assert('every owner-scoped suffix sits under shop/account/', () =>
        allSuffixes
            .filter((s) => !s.startsWith('pay/'))
            .every((s) => s.startsWith('shop/account/')));

    assert('the pay link stays OUTSIDE shop/account — it is opened with no session', () =>
        allSuffixes.includes('pay/{{payToken}}'));

    assert('the order button points at ONE order, not at the checkout group page', () => {
        const button = renderCustomerButton('order.created', 'en', { orderId: 'O1' }, 'https://s.example');
        // `/shop/account/orders/O1` would be read as a cartId by the group page.
        return button?.url === 'https://s.example/shop/account/orders/detail/O1';
    });

    console.log('\n── The locale prefix (next-intl "as-needed") ──');

    assert('a French customer gets the French tree', () => {
        const button = renderCustomerButton(
            'booking.confirmed', 'fr', { bookingId: 'B1' }, 'https://shop.example'
        );
        return button?.url === 'https://shop.example/fr/shop/account/bookings/B1';
    });

    assert('English stays on the unprefixed tree', () => {
        const button = renderCustomerButton(
            'booking.confirmed', 'en', { bookingId: 'B1' }, 'https://shop.example'
        );
        return !button?.url.includes('/en/');
    });

    assert('all four non-English locales are prefixed', () =>
        (['fr', 'pt', 'es', 'ar'] as const).every((lang) => {
            const button = renderCustomerButton(
                'booking.confirmed', lang, { bookingId: 'B1' }, 'https://shop.example'
            );
            return button?.url === `https://shop.example/${lang}/shop/account/bookings/B1`;
        }));

    /**
     * ⚠ The three outputs are NOT interchangeable, and each consumer prepends
     * something different. Getting these two rows the wrong way round produces
     * `/fr/fr/shop/…` on the inbox row and `//shop/…` on WhatsApp.
     */
    assert('urlSuffix stays locale-FREE — it is stored as action.path and re-prefixed', () => {
        const button = renderCustomerButton(
            'booking.confirmed', 'fr', { bookingId: 'B1' }, 'https://shop.example'
        );
        return button?.urlSuffix === 'shop/account/bookings/B1';
    });

    assert('whatsappSuffix is locale-prefixed and has NO leading slash', () => {
        const button = renderCustomerButton(
            'booking.confirmed', 'fr', { bookingId: 'B1' }, 'https://shop.example'
        );
        return button?.whatsappSuffix === 'fr/shop/account/bookings/B1';
    });

    assert('the WhatsApp send site sends whatsappSuffix, never urlSuffix', () => {
        const source = readFileSync(
            join(__dirname, '../../src/modules/notifications/services/customer-notification-event-handler.service.ts'),
            'utf8'
        );
        return source.includes('text: button.whatsappSuffix')
            && !source.includes('text: button.urlSuffix');
    });

    /**
     * The rule this whole group exists to enforce, as a source scan: there is ONE
     * implementation of the `as-needed` prefix. Two copies is how the notification
     * half was wrong for months while the bot half was right.
     */
    assert('the locale rule has exactly one implementation', () => {
        const catalog = readFileSync(
            join(__dirname, '../../src/modules/notifications/catalog/customer-notification-catalog.ts'),
            'utf8'
        );
        const botWindow = readFileSync(
            join(__dirname, '../../src/modules/bot-surface/domain/bot-list-window.ts'),
            'utf8'
        );
        return catalog.includes("from '../../../core/utils/storefront-link.util'")
            && botWindow.includes("from '../../../core/utils/storefront-link.util'")
            // neither may re-derive the prefix itself
            && !catalog.includes("=== 'en' ? '' :")
            && !botWindow.includes("=== 'en' ? '' :");
    });

    console.log('\n── The three composed lines (previously rendered empty) ──');

    assert('a delivery failure explains itself instead of trailing off', () => {
        const rendered = renderCustomerInApp('order.delivery_failed', 'en', {
            orderNumber: 'ORD-1',
            reasonLine: deliveryFailureLine('customer_absent', 'en')
        });
        return rendered.message.includes('There was nobody at the address.');
    });

    assert('every failure reason has a customer-facing line in all five languages', () => {
        for (const reason of [...SHIPMENT_FAILURE_REASONS, null]) {
            for (const lang of SUPPORTED_LANGUAGES) {
                const line = deliveryFailureLine(reason, lang as Language);
                if (!line || line.length < 5) return false;
            }
        }
        return true;
    });

    assert('a reason-less failure still gets a sentence, not a blank', () =>
        deliveryFailureLine(null, 'en').length > 0
        && deliveryFailureLine(undefined, 'fr').length > 0);

    assert('failure lines never accuse the customer', () => {
        // `customer_refused` is an agent-entered code that may be mis-tagged; the
        // customer must not be told "you refused it".
        const en = deliveryFailureLine('customer_refused', 'en').toLowerCase();
        return !en.startsWith('you ') && !en.includes('you refused');
    });

    assert('COD orders are told to have the cash ready, with the amount', () => {
        const line = codReadyLine(true, 15000, 'XAF', 'en');
        return line.includes('15,000') && line.includes('XAF') && !line.includes('{{');
    });

    assert('the COD line renders inside the out-for-delivery message', () => {
        const rendered = renderCustomerInApp('order.out_for_delivery', 'en', {
            orderNumber: 'ORD-1',
            codLine: codReadyLine(true, 15000, 'XAF', 'en')
        });
        return rendered.message.includes('cash on delivery')
            && rendered.message.includes('15,000');
    });

    assert('a PREPAID order gets no cash sentence at all', () =>
        codReadyLine(false, 15000, 'XAF', 'en') === '');

    assert('a COD order with nothing left to pay gets no cash sentence', () =>
        // `partially_paid` COD: quoting the full total to someone who already paid
        // part of it starts an argument on the doorstep.
        codReadyLine(true, 0, 'XAF', 'en') === '');

    assert('the COD line is localized, not English everywhere', () => {
        const en = codReadyLine(true, 15000, 'XAF', 'en');
        const fr = codReadyLine(true, 15000, 'XAF', 'fr');
        const ar = codReadyLine(true, 15000, 'XAF', 'ar');
        return en !== fr && fr !== ar && fr.includes('15,000');
    });

    assert('an empty optional line leaves no trailing space', () => {
        // "…can receive it. " with a dangling space reaches push and email
        // un-trimmed; only the in-app copy passes through a trim: true path.
        const rendered = renderCustomerInApp('order.out_for_delivery', 'en', {
            orderNumber: 'ORD-1',
            codLine: ''
        });
        return rendered.message === rendered.message.trim()
            && rendered.message.endsWith('receive it.');
    });

    assert('an empty mid-sentence line leaves no double space', () => {
        const rendered = renderCustomerInApp('booking.balance.due', 'en', {
            vendorName: 'Salon A', serviceName: 'Haircut', currency: 'XAF',
            finalPriceFormatted: '12,500', balanceFormatted: '7,500',
            reasonLine: ''
        });
        return !rendered.message.includes('  ');
    });

    assert('whitespace tidying does not damage a normal message', () => {
        const rendered = renderCustomerInApp('order.delivery_failed', 'en', {
            orderNumber: 'ORD-1',
            reasonLine: deliveryFailureLine('customer_absent', 'en')
        });
        return rendered.message.includes('today. There was nobody at the address. We will');
    });

    assert('order.shipped prints a real tracking number', () => {
        const rendered = renderCustomerInApp('order.shipped', 'en', {
            orderNumber: 'ORD-1',
            vendorName: 'Shop A',
            trackingNumber: 'ACR-260810-143000-7Q2XZ'
        });
        return rendered.message.includes('ACR-260810-143000-7Q2XZ');
    });

    console.log('\n── Support requests (GAP-012) ──');

    /**
     * ⚠ **The row of GAP-012's table that had no notification at all.** `ticket.*` events
     * were published from the day the tickets module shipped and NOTHING subscribed, so a
     * customer who asked a question — through the bot or anywhere else — was never told it
     * had been answered, on any channel.
     */
    assert('⚠ both ticket events are actually SUBSCRIBED — the defect was zero subscribers', () => {
        const consumer = readFileSync(
            join(__dirname, '..', '..', 'src', 'modules', 'notifications', 'customer-notification-event-consumer.ts'),
            'utf8'
        );
        return /subscribe\('ticket\.note_created'/.test(consumer)
            && /subscribe\('ticket\.status_changed'/.test(consumer);
    });

    assert('the platform is blocked on the customer → they are told', () =>
        customerTicketSituationFor('waiting_on_customer') === 'ticket.awaiting_customer');

    assert('both terminal statuses share one situation', () =>
        customerTicketSituationFor('resolved') === 'ticket.resolved'
        && customerTicketSituationFor('closed') === 'ticket.resolved');

    assert('⚠ five of the eight statuses are silent — internal progress is not news', () =>
        ['open', 'in_progress', 'waiting_on_admin', 'waiting_on_vendor', 'waiting_on_agency', 'waiting_on_agent']
            .every(status => customerTicketSituationFor(status) === null));

    assert('an unknown or missing status is silent rather than guessed at', () =>
        customerTicketSituationFor(undefined) === null
        && customerTicketSituationFor('escalated_to_legal') === null);

    /**
     * ⚠ **`resolved` and `closed` are terminal and are NOT interchangeable here.** A resolved
     * request can be reopened by replying; a closed one cannot. Telling somebody to "reply if
     * this is not sorted" on a closed request sends them to a route the platform has shut.
     */
    assert('⚠ the reopen sentence differs by outcome, and is never empty', () =>
        SUPPORTED_LANGUAGES.every(lang => {
            const reopenable = ticketReopenLine(false, lang);
            const closed = ticketReopenLine(true, lang);
            return reopenable.length > 0 && closed.length > 0 && reopenable !== closed;
        }));

    assert('the ticket copy never quotes the reply itself', () =>
        // A note can be 5000 characters, may be written by a vendor about another customer's
        // order, and a Meta template parameter cannot contain a newline at all — so a pasted
        // reply would fail the send outright. `{{subject}}` is the customer's OWN words.
        (['ticket.replied', 'ticket.awaiting_customer', 'ticket.resolved'] as CustomerNotificationType[])
            .every(situation =>
                SUPPORTED_LANGUAGES.every(lang => {
                    const body = CUSTOMER_NOTIFICATION_CATALOG[situation].base[lang].body;
                    return !/\{\{(note|noteContent|reply|body|message)\}\}/.test(body);
                })));

    assert('⚠ the copy says "request", never the platform word "ticket"', () =>
        // Rule 2 of the catalog's header — no platform vocabulary. The Portuguese and Spanish
        // words for `ticket` mean a travel or raffle ticket.
        (['ticket.replied', 'ticket.awaiting_customer', 'ticket.resolved'] as CustomerNotificationType[])
            .every(situation => {
                const en = CUSTOMER_NOTIFICATION_CATALOG[situation].base.en;
                return !/\bticket\b/i.test(`${en.subject} ${en.body}`);
            }));

    console.log('\n── What a customer may NOT mute ──');

    assert('money and cancellations carry no preference key', () => {
        // Mirrors the handler's SITUATION_PREFERENCE table by construction: these
        // situations must be absent from it, so no setting can silence them.
        const gated = new Set<CustomerNotificationType>([
            'booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.completed',
            'booking.reminder', 'order.created', 'order.shipped', 'order.out_for_delivery',
            'order.delivered', 'order.delivery_failed'
        ]);
        return UNMUTABLE.every(s => !gated.has(s));
    });

    assert('every situation is either gated or explicitly unmutable', () => {
        const gated = new Set<CustomerNotificationType>([
            'booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.completed',
            'booking.reminder', 'order.created', 'order.shipped', 'order.out_for_delivery',
            'order.delivered', 'order.delivery_failed'
        ]);
        return CUSTOMER_NOTIFICATION_TYPES.every(
            s => gated.has(s) || UNMUTABLE.includes(s)
        );
    });

    console.log('\n── Completion settlement arithmetic ──');

    assert('a longer job on a PAID booking owes the difference', () =>
        settle(12500, 5000).balanceDue === 7500 && settle(12500, 5000).creditDue === 0);

    assert('an UNPAID booking owes the whole final price, not just the overrun', () => {
        // Comparing against the quote (as the old code did) billed 1,000 on a
        // 6,000 job the customer had never paid for at all.
        const { balanceDue } = settle(6000, 0);
        return balanceDue === 6000;
    });

    assert('settling exactly at the paid amount owes nothing either way', () =>
        settle(5000, 5000).balanceDue === 0 && settle(5000, 5000).creditDue === 0);

    assert('settling BELOW the paid amount records a credit, not a negative balance', () => {
        const { balanceDue, creditDue } = settle(3000, 5000);
        return balanceDue === 0 && creditDue === 2000;
    });

    assert('a free (0) settlement on a paid booking credits the whole payment', () =>
        settle(0, 5000).creditDue === 5000);

    console.log('\n── Cash balance settlement ──');

    assert('omitting the amount settles the whole outstanding balance', () =>
        cashSettle(7500, 0) === 7500);

    assert('a partial cash payment credits only what was handed over', () =>
        cashSettle(7500, 0, 3000) === 3000);

    assert('a second partial settles the remainder', () =>
        cashSettle(7500, 3000) === 4500);

    assert('over-declaring is clamped to what is actually owed', () => {
        // Otherwise a mistyped 75000 inflates the vendor's earnings against money
        // the customer never paid.
        return cashSettle(7500, 0, 75000) === 7500;
    });

    assert('a fully-settled balance refuses another payment', () =>
        cashSettle(7500, 7500) === null);

    assert('fractional cash amounts are rounded, never truncated to zero', () =>
        cashSettle(7500, 0, 0.6) === 1);

    // ─────────────────────────────────────────────────────────────────────────
    //  Phase 10 · chat quick replies (stage 1)
    //
    //  Stage 1 renders the vocabulary on the CHAT channels only. The three pins
    //  the design owes, plus the dead-button guard that makes conditional
    //  buttons possible without a second mechanism.
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Quick replies: the vocabulary ──');

    const ID = 'a'.repeat(24);
    const withActions = (Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[])
        .filter(s => (CUSTOMER_NOTIFICATION_CATALOG[s].actions?.length ?? 0) > 0);

    assert('the boot assertion accepts the catalogue as written', () => {
        assertCustomerQuickRepliesSendable();
        return true;
    });

    /**
     * ⚠ **This was "exactly 13 of the 25" — the THIRD expired count in this file in one day**,
     * after "the five shortest-lived" and "the owner's three buttons". Every time, a number was
     * a date-stamped observation wearing the clothes of a rule; every time, it went red for a
     * CORRECT change. Here three buttons were withdrawn because their handlers do not exist.
     *
     * The two properties actually meant, neither of which a withdrawal can falsify:
     */
    assert('some situation carries quick replies (otherwise every check below is vacuous)', () =>
        withActions.length > 0);

    assert('⛔ a situation with quick replies always has a link button too', () =>
        withActions.every((s) => CUSTOMER_NOTIFICATION_CATALOG[s].button !== undefined));

    assert('⚠ every label fits WhatsApp\'s 20-character reply-button cap, in all five languages', () => {
        for (const situation of withActions) {
            for (const action of CUSTOMER_NOTIFICATION_CATALOG[situation].actions!) {
                for (const lang of SUPPORTED_LANGUAGES) {
                    const label = action.label[lang];
                    if (!label || [...label].length > 20) return false;
                }
            }
        }
        return true;
    });

    assert('⚠ every token fits Telegram\'s 64-BYTE callback_data cap with a real id expanded', () => {
        for (const situation of withActions) {
            for (const action of CUSTOMER_NOTIFICATION_CATALOG[situation].actions!) {
                const widest = action.token.replace(/\{\{\s*\w+\s*\}\}/g, ID);
                if (Buffer.byteLength(widest, 'utf8') > 64) return false;
            }
        }
        return true;
    });

    /**
     * ⭐ **Green is not evidence: each cap is shown to BITE on a deliberately broken
     * catalogue.** These mutate the in-memory catalogue, assert the boot check throws
     * for the RIGHT reason, and restore it — so the proof needs no file mutation and
     * cannot leave the tree broken.
     *
     * The failure this catches is the one this effort kept finding: an assertion that
     * passes because it has stopped looking, rather than because the property holds.
     */
    const bites = (name: string, fault: string, breakIt: () => () => void): void => {
        assert(name, () => {
            const restore = breakIt();
            try {
                assertCustomerQuickRepliesSendable();
                return false; // did not throw — the cap is not enforced
            } catch (err) {
                return (err as Error).message.includes(fault);
            } finally {
                restore();
            }
        });
    };

    const victim = 'order.delivered' as CustomerNotificationType;
    const swapActions = (next: typeof CUSTOMER_NOTIFICATION_CATALOG[CustomerNotificationType]['actions']) => {
        const original = CUSTOMER_NOTIFICATION_CATALOG[victim].actions;
        CUSTOMER_NOTIFICATION_CATALOG[victim].actions = next;
        return () => { CUSTOMER_NOTIFICATION_CATALOG[victim].actions = original; };
    };
    const label20 = { en: 'ok', fr: 'ok', pt: 'ok', es: 'ok', ar: 'ok' };

    bites('PROOF: a 21-character label is refused', 'characters; the cap is', () =>
        swapActions([{ token: 'ord:{{orderId}}', label: { ...label20, en: 'x'.repeat(21) } }]));

    bites('PROOF: a token that cannot fit its own id is refused', 'bytes with ids expanded', () =>
        swapActions([{ token: `ord:${'x'.repeat(50)}:{{orderId}}`, label: label20 }]));

    bites('PROOF: a fourth button is refused', 'WhatsApp renders at most', () =>
        swapActions([
            { token: 'ord:{{orderId}}', label: label20 },
            { token: 'rate:{{orderId}}', label: label20 },
            { token: 'track:{{orderId}}', label: label20 },
            { token: 'tkt:new:ord:{{orderId}}', label: label20 },
        ]));

    bites('PROOF: a missing translation is refused', 'is missing its', () =>
        swapActions([{ token: 'ord:{{orderId}}', label: { ...label20, ar: '' } as never }]));

    bites('PROOF: a token with no verb is refused', 'does not start with a verb', () =>
        swapActions([{ token: '{{orderId}}', label: label20 }]));

    bites('PROOF: two buttons sharing one token are refused', 'repeats quick-reply token', () =>
        swapActions([
            { token: 'ord:{{orderId}}', label: label20 },
            { token: 'ord:{{orderId}}', label: label20 },
        ]));

    console.log('\n── Quick replies: the dead-button guard ──');

    /**
     * ⭐ The guard this whole mechanism rests on, and the reason it cannot be a
     * check for a leftover `{{`: `renderTemplate` fills a MISSING key with an empty
     * string, so `pay:rt:{{transactionId}}` with no id renders to `pay:rt:` — well
     * formed, and pointing at nothing. A customer tapping it gets "this button
     * expired" on a message that arrived seconds ago.
     */
    assert('⛔ a token whose id is missing is DROPPED, not sent half-built', () =>
        renderCustomerQuickReplies('order.payment_failed', 'en', { orderId: ID }).length === 0);

    assert('the same token IS sent once its id is supplied', () => {
        const out = renderCustomerQuickReplies('order.payment_failed', 'en', { transactionId: ID });
        return out.length === 1 && out[0].token === `pay:rt:${ID}`;
    });

    assert('an EMPTY id counts as missing — that is what a lost id looks like in a context', () =>
        renderCustomerQuickReplies('order.payment_failed', 'en', { transactionId: '' }).length === 0);

    // The conditional, expressed as a present-or-absent id rather than a second
    // mechanism. A closed request must not offer a reply: `reopenLine` already tells
    // the customer that door is shut, and a button beside it would contradict the
    // sentence it sits under.
    assert('⛔ a CLOSED request offers no "Not sorted" button', () =>
        renderCustomerQuickReplies('ticket.resolved', 'en', { ticketId: ID }).length === 0);

    assert('a RESOLVED request does offer it', () =>
        renderCustomerQuickReplies('ticket.resolved', 'en', { reopenableTicketId: ID }).length === 1);

    /**
     * ⚠ **This said "the owner's THREE buttons" and went red at two** — the second time today a
     * count inside an assertion has expired, and I wrote the first one up. The count was never
     * the property: what matters is that every button renders, that none promises an action the
     * platform cannot perform, and that the whole message fits what WhatsApp will draw.
     *
     * The third button went because it was a duplicate of the link, and the remaining two now
     * use the tickets stream's existing `rd` / `ad` tokens — a four-segment argument is refused
     * by their parser, so the shape matters as much as the count did not.
     */
    assert('every delivery-failure button renders, and none names an action we cannot perform', () => {
        const out = renderCustomerQuickReplies('order.delivery_failed', 'en', { orderId: ID });
        if (out.length === 0) return false;
        // No reschedule and no redirect — the owner's constraint. There is no reschedule
        // endpoint anywhere and the address is snapshotted at checkout, so either label
        // would promise something the platform cannot keep.
        return !out.some(b => /reschedul|redirect|change (the )?(date|address)/i.test(b.label));
    });

    /**
     * ⛔ The shape the tickets parser actually accepts: `tkt` + at most three argument
     * segments. A four-segment token is refused outright, and because Telegram reports
     * nothing for an unhandled callback, the failure would be invisible from this side — the
     * customer taps "I was not there" on a failed-delivery message and is told "I did not
     * understand that".
     */
    assert('⛔ no `tkt` token exceeds the three segments the tickets parser accepts', () => {
        const all = (Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[])
            .flatMap(s => CUSTOMER_NOTIFICATION_CATALOG[s].actions ?? []);
        const tktTokens = all.filter(a => a.token.startsWith('tkt:'));
        if (tktTokens.length === 0) return false; // the scan must find something
        return tktTokens.every(a => a.token.split(':').length - 1 <= 3);
    });

    assert('the failed-delivery buttons use the tickets stream\'s CLAIMED tokens', () => {
        const out = renderCustomerQuickReplies('order.delivery_failed', 'en', { orderId: ID });
        return out.map(b => b.token.split(':').slice(0, 3).join(':')).join(' ') === 'tkt:new:rd tkt:new:ad';
    });

    /**
     * Scans read from here, so a mutation harness can point them at a deliberately
     * broken copy and confirm each one reports ITS OWN fault. Same convention as
     * `INAPP_CHECKOUT_SCAN_ROOT`. Unset in normal runs: the real tree.
     *
     * ⚠ CRLF is normalised on read — the committed blobs carry it, so a scan that
     * does not normalise fails on correct code under a fresh checkout.
     */
    const scanRoot = process.env.CUSTOMER_NOTIFICATIONS_SCAN_ROOT || join(__dirname, '../..');
    if (process.env.CUSTOMER_NOTIFICATIONS_SCAN_ROOT) console.log('  (SCANS REDIRECTED)');
    const readSource = (rel: string) => readFileSync(join(scanRoot, rel), 'utf8').replace(/\r\n/g, '\n');

    // ─────────────────────────────────────────────────────────────────────────
    //  Template languages — the silent gap between what we speak and what Meta cleared
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Template languages: no customer may fall off the end ──');

    const payloads = JSON.parse(
        readFileSync(join(__dirname, '../../api-doc/notifications/whatsapp-template-payloads.json'), 'utf8')
    ) as { languages: string[]; payloads: Array<{ name: string; language: string }> };

    // A scan that finds nothing satisfies every "every X is Y" check below.
    assert('the submitted payload set was actually read', () =>
        Array.isArray(payloads.payloads) && payloads.payloads.length > 0);

    /**
     * ⛔ **THE ASSERTION THAT CATCHES THE SILENCE.** Every language a customer can hold must
     * resolve to a template language that is genuinely in the submitted set. Before
     * `templateLanguage` existed, `pt`/`es`/`ar` resolved to themselves, Meta refused the send,
     * and the customer got nothing outside the 24-hour window.
     *
     * It also catches two things nobody has to remember: a sixth bot language added later, and
     * a template set submitted in French but NOT English — which would leave the fallback
     * itself unsendable.
     */
    /** The property, as a function of the resolver — so the same check can be run against a broken one. */
    const everyLanguageSendable = (resolve: (lang: Language) => string): boolean => {
        const submitted = new Set(payloads.payloads.map(p => p.language));
        return SUPPORTED_LANGUAGES.every(lang => submitted.has(resolve(lang)));
    };

    assert('⛔ every bot language resolves to a submitted template — including the FALLBACK itself', () =>
        everyLanguageSendable(templateLanguage));

    assert('⛔ the approved-language constant matches what the generator submitted', () => {
        const submitted = new Set(payloads.payloads.map(p => p.language));
        const declared = new Set(TEMPLATE_LANGUAGES.map(l => META_LANGUAGE_CODE[l]));
        return [...declared].every(l => submitted.has(l)) && declared.size === submitted.size;
    });

    // The fallback is English BY NAME, not "the platform default" and not "whichever approved
    // language sorts first" — both would drift without failing.
    assert('⛔ an unapproved language falls back to ENGLISH specifically', () =>
        templateLanguage('ar') === 'en' && templateLanguage('es') === 'en' && templateLanguage('pt') === 'en');

    assert('an approved language is left alone', () =>
        templateLanguage('fr') === 'fr' && templateLanguage('en') === 'en');

    /**
     * ⭐ PROOF, reproducing the ACTUAL defect rather than a hypothetical: before
     * `templateLanguage` existed the send path used `META_LANGUAGE_CODE[lang]` directly, so a
     * customer's own language was asked of Meta whether or not it had ever been approved.
     * Running the same property against that resolver must FAIL — if it passes, the assertion
     * above is not testing anything.
     */
    assert('PROOF: the pre-fix resolver (the customer\'s own language) FAILS this check', () =>
        everyLanguageSendable((lang) => META_LANGUAGE_CODE[lang]) === false);

    /**
     * And the case the owner's decision makes reachable: a set submitted in French but not
     * English would leave the FALLBACK ITSELF unsendable, which is worse than the gap it
     * closes — every unapproved language would resolve to a template that does not exist.
     */
    assert('PROOF: a fallback language missing from the submitted set is caught', () => {
        const frenchOnly = new Set(['fr']);
        return SUPPORTED_LANGUAGES.every(lang => frenchOnly.has(templateLanguage(lang))) === false;
    });

    /**
     * ⛔ **No notification stack may name the recipient's own language at a template send.**
     * All four carried the identical line and all four are fixed; this is what stops the fifth
     * one being written, or one of these being "tidied" back to the direct lookup.
     *
     * ⚠ Scoped to `notifications/**` on purpose. Two sites OUTSIDE it have the same defect —
     * `cod/services/delivery-code.service.ts` and
     * `phone-verification/services/phone-verification.service.ts` — and neither is this
     * stream's to edit. They are reported, not silently swept in, and the second is the more
     * serious: a phone-verification OTP is out of window BY NATURE, since the number being
     * verified may never have messaged us.
     */
    /**
     * ⛔ **ALL SIX TEMPLATE SEND SITES, not just the notification stacks.** Every one carried
     * the identical line, and the two outside `notifications/**` were the worse of the six:
     *
     *  - `phone-verification` — a **sign-up** defect, not a notification one. That message is
     *    outside the 24-hour window BY NATURE (the number being verified may never have written
     *    to us), so there is no free-form fallback: a Portuguese-, Spanish- or Arabic-speaking
     *    person could never verify a phone number at all, every time, on every stack.
     *  - `cod/delivery-code` — reached ONLY when the free-form send already failed on
     *    `WHATSAPP_POLICY_VIOLATION`, so again no third chance: the delivery code never
     *    arrived and an agent turned up with a parcel the customer could not confirm.
     *
     * The list is explicit rather than a directory walk: a walk that stops matching finds
     * nothing and passes.
     */
    const TEMPLATE_SEND_SITES: readonly string[] = [
        'src/modules/notifications/services/customer-notification-event-handler.service.ts',
        'src/modules/notifications/services/vendor-notification-event-handler.service.ts',
        'src/modules/notifications/services/agency-notification-event-handler.service.ts',
        'src/modules/notifications/services/agent-notification-event-handler.service.ts',
        'src/modules/cod/services/delivery-code.service.ts',
        'src/modules/phone-verification/services/phone-verification.service.ts',
    ];

    assert('⛔ no template send names the recipient\'s own language, on ANY of the six sites', () =>
        TEMPLATE_SEND_SITES.every((rel) => !/language:\s*META_LANGUAGE_CODE\[/.test(readSource(rel))));

    assert('all six sites were actually read, and each resolves through templateLanguage', () =>
        TEMPLATE_SEND_SITES.every((rel) => /templateLanguage\(/.test(readSource(rel))));

    // ─────────────────────────────────────────────────────────────────────────
    //  ⛔ THE SECOND AXIS: a token must PARSE, not merely be fully substituted
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Quick replies: every token reaches a handler ──');

    /**
     * ⛔ **THE ASSERTION WHOSE ABSENCE LET TEN DEAD BUTTONS SHIP-READY.**
     *
     * The completeness check above verifies that every PLACEHOLDER is supplied, and it is
     * right about the failure it was written for — `pay:rt:` rendering as `pay:rt:` with an
     * empty id. But **a token with every placeholder filled and a verb nobody handles passes
     * it perfectly.** The check never parsed the token, so `bk:cancel:<id>`, `rate:<id>`,
     * `tkt:reply:<id>` and five others read as healthy: well-formed, fully substituted,
     * pointing at nothing.
     *
     * Two things had to be true and only one was checked. The other half:
     *
     *  1. the token parses under `parseBotActionId`, and its `(verb, sub-key)` is a key some
     *     stream's handler map actually registers;
     *  2. for `tkt`, the ARGUMENT additionally satisfies `parseTicketTap` — a claimed verb
     *     with a legal-looking argument is exactly what no check on this side could see, and
     *     it is how the failed-delivery pair nearly shipped.
     *
     * ⚠ **Claimed keys are read as TEXT, never imported.** Importing a controller under bare
     * ts-node does real work at module scope and never returns, which is why every `test:inapp-*`
     * suite scans instead. The parsers themselves are pure domain modules and ARE imported —
     * so the grammar is the real one, not a second copy of it that could drift.
     */
    const claimedActionKeys = (): Set<string> => {
        const dir = join(scanRoot, 'src/modules/bot-surface/controllers');
        const keys = new Set<string>();
        for (const file of readdirSync(dir)) {
            if (!file.endsWith('.ts')) continue;
            const src = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
            const maps = src.matchAll(/export const [A-Z_]+_ACTION_HANDLERS[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\);/g);
            for (const map of maps) {
                for (const entry of map[1].matchAll(/^\s{4}'?([a-zA-Z:]+)'?\s*:/gm)) keys.add(entry[1]);
            }
        }
        return keys;
    };

    const keys = claimedActionKeys();

    // A scan that stops matching yields an empty set, and "every token is in the set" is then
    // vacuously... false, which is safe — but an empty set would also make the guard useless
    // in the other direction, so its size is pinned.
    assert('the dispatcher registry scan found the claimed keys', () =>
        keys.size >= 20 && keys.has('pay') && keys.has('tkt') && keys.has('ord'));

    const catalogueTokens = (): Array<{ situation: string; token: string }> =>
        (Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[]).flatMap((s) =>
            (CUSTOMER_NOTIFICATION_CATALOG[s].actions ?? []).map((a) => ({
                situation: s,
                // Every placeholder filled with a plausible id, which is the state the
                // renderer would actually emit.
                token: a.token.replace(/\{\{\s*\w+\s*\}\}/g, ID),
            }))
        );

    assert('the token census found tokens to check', () => catalogueTokens().length > 0);

    assert('⛔ every quick-reply token PARSES and its verb is registered by some stream', () => {
        const dead = catalogueTokens().filter(({ token }) => {
            const parsed = parseBotActionId(token);
            if (!parsed) return true;
            return !keys.has(actionKeyOf(parsed).key);
        });
        if (dead.length > 0) {
            console.error(`     ↳ unreachable: ${dead.map((d) => `${d.token} (${d.situation})`).join(', ')}`);
        }
        return dead.length === 0;
    });

    assert('⛔ every `tkt` token additionally satisfies the TICKET parser', () => {
        const dead = catalogueTokens()
            .filter(({ token }) => token.startsWith('tkt:'))
            .filter(({ token }) => parseTicketTap(token.slice('tkt:'.length)) === null);
        if (dead.length > 0) {
            console.error(`     ↳ refused by parseTicketTap: ${dead.map((d) => `${d.token} (${d.situation})`).join(', ')}`);
        }
        return dead.length === 0;
    });

    /**
     * PROOF that both halves bite, using the real dead tokens this check was written after —
     * one per failure mode. If either passes, the assertion above is not doing its job.
     */
    assert('PROOF: an unregistered verb is caught (`rate:` — declared, handled by nobody)', () => {
        const parsed = parseBotActionId(`rate:${ID}`);
        return parsed === null || !keys.has(actionKeyOf(parsed).key);
    });

    assert('PROOF: a claimed verb with an illegal argument is caught (`tkt:reply:<id>`)', () =>
        parseTicketTap(`reply:${ID}`) === null);

    console.log('\n── Quick replies: what must NOT change ──');

    const handlerSource = readSource('src/modules/notifications/services/customer-notification-event-handler.service.ts');
    const telegramSource = readSource('src/modules/telegram/services/telegram-bot.service.ts');

    // A scan that stops matching returns nothing, and "nothing" satisfies most checks.
    assert('the scanned sources were actually found', () =>
        handlerSource.includes('private async sendWhatsApp') && telegramSource.includes('inline_keyboard'));

    /**
     * PIN 1 — the compensating link line carries the SAME label and URL the CTA button
     * would have. Composed from one value rather than a second copy key, so the two
     * cannot drift.
     */
    assert('⚠ the view line is built from the button it replaces, so the two cannot drift', () => {
        const button = renderCustomerButton('order.delivered', 'en', { orderId: ID }, 'https://wi-mall.com');
        if (!button) return false;
        const line = viewLineFor({ label: button.label, url: button.url });
        return line.includes(button.url) && line.includes(button.label);
    });

    assert('no view line exists when there is no button to replace', () =>
        viewLineFor(null) === '');

    /**
     * PIN 2 — the line belongs to the IN-WINDOW interactive path only. The
     * out-of-window template is untouched in stage 1: its body is the approved copy,
     * and appending anything would make the send disagree with what Meta approved.
     */
    assert('⛔ the view line is applied ONLY on the in-window path, never to a template body', () => {
        const templateBranch = handlerSource.slice(handlerSource.indexOf('const components: TemplateComponent[]'));
        return !templateBranch.includes('viewLineFor');
    });

    /**
     * PIN 3 — a situation with no quick reply keeps the CTA URL button it has today.
     * The `buttons` payload is reachable only behind a non-empty quick-reply list.
     */
    assert('⛔ reply buttons are sent only when a quick reply exists; otherwise the CTA path is unchanged', () => {
        const inWindow = handlerSource.slice(
            handlerSource.indexOf('if (withinWindow) {'),
            handlerSource.indexOf('const components: TemplateComponent[]')
        );
        return /if \(quickReplies\.length > 0\) \{[\s\S]*?WaServiceMessage\.buttons\(/.test(inWindow)
            && /\} else if \(button\) \{[\s\S]*?WaServiceMessage\.ctaUrl\(/.test(inWindow);
    });

    // The fourth expired count, same day, same shape — the number was never the property.
    // What matters is that a situation carrying no tap still gives the customer a way to look
    // at the thing, which is exactly what makes a withdrawal safe.
    assert('⛔ every situation without a quick reply still resolves a URL button', () => {
        const ctx = { orderId: ID, bookingId: ID, ticketId: ID, payToken: 'tok' };
        const none = (Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[])
            .filter(s => !(CUSTOMER_NOTIFICATION_CATALOG[s].actions?.length));
        return none.length > 0
            && none.every(s => renderCustomerButton(s, 'en', ctx, 'https://wi-mall.com') !== null);
    });

    /**
     * Telegram's pre-phase-10 callers pass `button` alone, and the row they produce must
     * be the same bytes it always was. The new `buttons` path is additive.
     */
    assert('⛔ Telegram\'s single-URL-button shape is preserved for every existing caller', () =>
        /options\.buttons\?\.length[\s\S]{0,200}options\.button/.test(telegramSource)
        && telegramSource.includes('{ text: b.text, url: b.url }'));

    assert('a Telegram callback button carries callback_data, not a url', () =>
        telegramSource.includes('{ text: b.text, callback_data: b.callbackData }'));

    /**
     * The coordinator's pin: at most ONE secondary channel is chosen per notification
     * (telegram > email > whatsapp), so each rendering is read ALONE. A sentence
     * referring the customer to another channel's copy would be false for everybody
     * who did not receive that one.
     *
     * ⚠ What this proves and what it does not: it catches copy that NAMES another
     * channel, which is the reachable form of the mistake. It cannot prove a sentence
     * is self-contained in general — no scan can.
     */
    const crossChannelFree = (): boolean => {
        const crossChannel = /\b(check your (email|inbox|sms)|see the (email|sms|app)|as (we )?(emailed|texted)|in the app we sent)\b/i;
        for (const situation of Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[]) {
            for (const lang of SUPPORTED_LANGUAGES) {
                const copy = CUSTOMER_NOTIFICATION_CATALOG[situation].base[lang];
                if (crossChannel.test(copy.subject) || crossChannel.test(copy.body)) return false;
            }
        }
        return true;
    };

    assert('⛔ no situation\'s copy points the customer at another channel\'s message', crossChannelFree);

    assert('PROOF: a sentence referring to another channel IS caught', () => {
        const original = CUSTOMER_NOTIFICATION_CATALOG['order.delivered'].base.en.body;
        CUSTOMER_NOTIFICATION_CATALOG['order.delivered'].base.en.body = `${original} Check your email for the receipt.`;
        try {
            return crossChannelFree() === false;
        } finally {
            CUSTOMER_NOTIFICATION_CATALOG['order.delivered'].base.en.body = original;
        }
    });

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();
