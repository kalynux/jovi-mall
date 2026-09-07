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
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    CUSTOMER_NOTIFICATION_CATALOG,
    assertCustomerCatalogComplete,
    renderCustomerInApp,
    renderCustomerWhatsAppTemplateParams,
    renderCustomerButton,
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
import { SUPPORTED_LANGUAGES, Language } from '../../src/modules/notifications/catalog/notification-i18n';

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
    'booking.completed': 3,
    'booking.reminder': 3,
    'booking.payment.received': 3,
    'booking.balance.due': 4,
    'booking.refunded': 3,
    'booking.refund.pending': 3,
    'order.created': 4,
    'order.payment.received': 3,
    'order.shipped': 3,
    'order.out_for_delivery': 1,
    'order.delivered': 1,
    'order.delivery_failed': 1,
    'order.cancelled': 1,
    'order.refunded': 3,
    'order.payment_link': 4,
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

    // 22 = the 18 this stack shipped with, plus GAP-012's three `ticket.*` and the card
    // payment page. The literal is kept rather than derived: this assertion's whole job is
    // to notice a situation appearing on one side and not the other, and `catalog.length
    // === model.length` would pass happily while both drifted away from what anybody meant.
    assert('catalog and model enum list the same 22 situations', () => {
        const catalog = Object.keys(CUSTOMER_NOTIFICATION_CATALOG).sort();
        const model = [...CUSTOMER_NOTIFICATION_TYPES].sort();
        return catalog.length === 22 && JSON.stringify(catalog) === JSON.stringify(model);
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

    console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

main();
