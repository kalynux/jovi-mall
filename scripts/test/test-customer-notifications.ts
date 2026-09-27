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
import { TemplateRegistry } from '../../src/modules/whatsapp/handlers/template/template-registry';
import { TemplateValidator } from '../../src/modules/whatsapp/handlers/template/template-validator';
import { AppError } from '../../src/core/errors';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DeliveryCodeService } from '../../src/modules/cod/services/delivery-code.service';
import { DELIVERY_CODE_TEMPLATE_NAME, COPY_CODE_LABEL } from '../../src/modules/cod/domain/delivery-code-copy';
import { getWhatsAppMessagingService } from '../../src/modules/whatsapp/services/whatsapp-messaging.service';
import { abandonedCartWorker, buyableTitlesFrom } from '../../src/modules/cart/workers/abandoned-cart.worker';
import { CART_CONFIG } from '../../src/modules/cart/config/cart.config';
import {
    CUSTOMER_NOTIFICATION_CATALOG,
    assertCustomerCatalogComplete,
    assertCustomerQuickRepliesSendable,
    renderCustomerInApp,
    renderCustomerWhatsAppTemplateParams,
    renderCustomerButton,
    renderCustomerQuickReplies,
    renderCustomerTemplateQuickReplies,
    customerTemplateQuickReplyLabels,
    IN_WINDOW_ONLY_SITUATIONS,
    cartItemSummary,
    viewLineFor,
    customerWhatsAppTemplateName,
    deliveryFailureLine,
    codReadyLine,
    ticketReopenLine
} from '../../src/modules/notifications/catalog/customer-notification-catalog';
import {
    customerTicketSituationFor,
    CustomerNotificationEventHandler
} from '../../src/modules/notifications/services/customer-notification-event-handler.service';
import { connectionService } from '../../src/modules/channel-connections';
import { SHIPMENT_FAILURE_REASONS } from '../../src/modules/shipments/shipment.model';
import {
    CUSTOMER_AGGREGATE_TYPES,
    CUSTOMER_NOTIFICATION_TYPES,
    CustomerNotificationModel,
    CustomerNotificationType
} from '../../src/modules/notifications/models/customer-notification.model';
import { AGENT_NOTIFICATION_TYPES } from '../../src/modules/notifications/models/agent-notification.model';
import { AGENT_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/agent-notification-catalog';
import { AGENCY_NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/agency-notification-catalog';
import { NOTIFICATION_CATALOG } from '../../src/modules/notifications/catalog/notification-catalog';
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
    'ticket.resolved': 2,
    // In-window-only: no template, so no template parameters.
    'cart.abandoned': 0
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
    // become false, which told the customer nothing at all. 26 since 2026-09-27: the
    // abandoned-basket reminder, `cart.abandoned`. The literal
    // is kept rather than derived: this assertion's whole job is to notice a situation appearing
    // on one side and not the other, and `catalog.length === model.length` would pass happily
    // while both drifted away from what anybody meant.
    assert('catalog and model enum list the same 26 situations', () => {
        const catalog = Object.keys(CUSTOMER_NOTIFICATION_CATALOG).sort();
        const model = [...CUSTOMER_NOTIFICATION_TYPES].sort();
        return catalog.length === 26 && JSON.stringify(catalog) === JSON.stringify(model);
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

    /**
     * Every situation names a template EXCEPT the ones deliberately in-window-only — and that
     * exception is a named list, not a missing field (owner's ruling 2026-09-27, plan Q-6).
     */
    const templated = CUSTOMER_NOTIFICATION_TYPES.filter(s => !IN_WINDOW_ONLY_SITUATIONS.has(s));

    assert('every situation declares a template name, except the named in-window-only ones', () =>
        templated.every(s => !!customerWhatsAppTemplateName(s))
        && [...IN_WINDOW_ONLY_SITUATIONS].every(s => customerWhatsAppTemplateName(s) === null));

    assert('template names are unique', () => {
        const names = templated.map(customerWhatsAppTemplateName);
        return new Set(names).size === names.length;
    });

    assert('template names are all customer_-prefixed', () =>
        templated.every(s =>
            customerWhatsAppTemplateName(s)!.startsWith('customer_')));

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
        const missing = templated
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

    // Seven since 2026-09-27: `shop/cart`, the basket reminder's page.
    assert('every button carries a suffix and there are seven distinct ones', () =>
        allSuffixes.length === 7);

    assert('no suffix has a leading slash (Meta supplies the separator)', () =>
        allSuffixes.every((s) => !s.startsWith('/')));

    assert('no suffix carries a locale prefix (renderCustomerButton adds it)', () =>
        allSuffixes.every((s) => !/^(en|fr|pt|es|ar)\//.test(s)));

    /**
     * `shop/cart` is the one other exception, and it is not owner-scoped by URL: the storefront
     * serves the basket at `src/app/[locale]/shop/cart/page.tsx`, beside the catalogue, and
     * reads the signed-in customer's own basket there. Named, so a third is a deliberate edit.
     */
    assert('every owner-scoped suffix sits under shop/account/', () =>
        allSuffixes
            .filter((s) => !s.startsWith('pay/') && s !== 'shop/cart')
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
            'order.delivered', 'order.delivery_failed', 'cart.abandoned'
        ]);
        return UNMUTABLE.every(s => !gated.has(s));
    });

    assert('every situation is either gated or explicitly unmutable', () => {
        const gated = new Set<CustomerNotificationType>([
            'booking.created', 'booking.confirmed', 'booking.rescheduled', 'booking.completed',
            'booking.reminder', 'order.created', 'order.shipped', 'order.out_for_delivery',
            'order.delivered', 'order.delivery_failed', 'cart.abandoned'
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

    // Each mutant carries a `templateFallback` so it isolates the DUPLICATE rule — without one
    // the missing-fallback rule fires first, and this proof would pass for the wrong reason.
    bites('PROOF: two buttons sharing one token are refused', 'repeats quick-reply token', () =>
        swapActions([
            { token: 'ord:{{orderId}}', label: label20, templateFallback: 'open:ol' },
            { token: 'ord:{{orderId}}', label: label20, templateFallback: 'open:ol' },
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

    /**
     * ⛔ **COMMENTS ARE STRIPPED BEFORE ANY SCAN, AND THIS IS NOT TIDINESS.**
     *
     * Without it, **the sentence stating a rule defeats the check of the rule.** The positive
     * guard below looks for `templateLanguage(` — and two of the six files explain the rule in
     * a ⛔ comment that quotes the call *with its parenthesis*. So the real call could be
     * swapped back to `META_LANGUAGE_CODE[` and the guard would still pass, matching the
     * comment instead of the code. Measured, not theorised: with the call reverted and the
     * comment untouched — which is exactly how this regresses, because nobody deletes a ⛔ rule
     * comment — `delivery-code.service.ts` and `phone-verification.service.ts` both still
     * passed. Those are the two sites where the failure means a person can never verify a
     * phone number, or never receives a delivery code.
     *
     * ⚠ **It fixes the opposite direction at the same time.** The negative guard forbids
     * `language: META_LANGUAGE_CODE[`, and is clean today only because every comment happens
     * to quote the old form without a `language:` prefix. One comment written the obvious way
     * — *"the old form was `language: META_LANGUAGE_CODE[lang]`"* — would fail the guard on
     * CORRECT code, which is how a guard teaches the next person to weaken it.
     *
     * Block comments and whole-line `//` comments only: a trailing `//` is left alone so a URL
     * in a string literal cannot be mangled.
     */
    const stripComments = (src: string) =>
        src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    const readSource = (rel: string) =>
        stripComments(readFileSync(join(scanRoot, rel), 'utf8').replace(/\r\n/g, '\n'));

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
    /**
     * ⛔ **THE REGISTRY MAY NOT CLAIM A TEMPLATE THAT WAS NEVER SUBMITTED.**
     *
     * `template-registry.ts` gates nothing — its whole job is the "template not in registry,
     * this may fail" warning. So the one thing it must never do is assert that a template
     * exists when it does not, which is precisely what it did: it registered every name in
     * all five languages while only `en` and `fr` were ever submitted. Six send sites asked
     * Meta for the missing ones and died, and the mechanism designed to shout about that
     * stayed silent **because it had been told the template was there.**
     *
     * Behavioural, not a scan: the real registry is instantiated and every pair it claims is
     * checked against the generated submission set.
     */
    assert('⛔ the template registry claims no language that was never submitted', () => {
        const submitted = new Set(payloads.payloads.map(p => p.language));
        const claimed = new TemplateRegistry().getAll();
        if (claimed.length === 0) return false; // an empty registry would pass vacuously
        const overclaimed = claimed.filter(t => !submitted.has(t.language));
        if (overclaimed.length > 0) {
            const langs = [...new Set(overclaimed.map(t => t.language))].join(', ');
            console.error(`     ↳ registry claims unsubmitted languages: ${langs} (${overclaimed.length} entries)`);
        }
        return overclaimed.length === 0;
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Template NAMES — the same silence, one level down from the language
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Template names: every name a send asks Meta for was submitted ──');

    /**
     * ⛔ **NOTHING COMPARED THE NAME SET, AND NINE TEMPLATES DRIFTED UNDER A GREEN SUITE.**
     *
     * Everything above is about LANGUAGES. The registry check filters on the language alone,
     * so a registry name absent from the file passed. Three customer situations — two of
     * them payment failures — named templates Meta never held, and six payout situations did
     * the same for vendors, agencies and agents. Out of window a template is the only way to
     * reach a WhatsApp recipient, so each was refused and the recipient was told nothing.
     * All nine were submitted on 2026-09-27; this is what stops the tenth.
     *
     * ⚠ **The expected set is read as DATA, never by running the generator.** The generator
     * refuses without four URL variables, so a CI run would skip it — and skipped looks like
     * passing.
     *
     * Three sources of a name a send can ask for, all derived:
     *   1. the four notification catalogues, read through their exported objects;
     *   2. a template name written as a LITERAL at a send site elsewhere in `src/modules`,
     *      found by a comment-stripped scan — a name outside every catalogue is exactly the
     *      one no generator emits, and so the one most likely never to have been submitted;
     *   3. the two phone-verification OTP names, which are hand-built by the generator
     *      because Meta accepts an OTP body only as AUTHENTICATION. They are the ONLY names
     *      allowlisted, by name, below.
     *
     * Both directions: a submitted name nothing sends is a template at Meta that nothing
     * keeps honest.
     */
    type NamedCatalog = Record<string, { whatsapp: { template?: { name: string } } }>;
    const catalogTemplateNames = (): Map<string, string> => {
        const out = new Map<string, string>();
        const catalogs: Array<[string, NamedCatalog]> = [
            ['vendor', NOTIFICATION_CATALOG as unknown as NamedCatalog],
            ['customer', CUSTOMER_NOTIFICATION_CATALOG as unknown as NamedCatalog],
            ['agency', AGENCY_NOTIFICATION_CATALOG as unknown as NamedCatalog],
            ['agent', AGENT_NOTIFICATION_CATALOG as unknown as NamedCatalog],
        ];
        for (const [audience, catalog] of catalogs) {
            for (const [situation, messages] of Object.entries(catalog)) {
                // An in-window-only situation names no template, so asks Meta for none.
                if (messages.whatsapp.template) {
                    out.set(messages.whatsapp.template.name, `${audience} catalogue: ${situation}`);
                }
            }
        }
        return out;
    };

    /**
     * `{ type: 'template', name: '<literal>' }` — the shape every template send in this tree
     * builds. A name taken from a catalogue, a config value or an env variable is not a
     * literal and is covered by source 1 or 3 (or, for the optional carousel, by nobody:
     * it is unset by default and names a MARKETING template outside this file).
     */
    const LITERAL_TEMPLATE_NAME = /type:\s*'template',\s*name:\s*'([a-z0-9_]+)'/g;
    /**
     * ⚠ …and a `*TEMPLATE_NAME = '<literal>'` constant, because that is where a literal goes
     * when it is given a name: `cod_delivery_code` moved from the send site into
     * `DELIVERY_CODE_TEMPLATE_NAME` so the generator could share it, and a scan that only read
     * send sites would have lost sight of it in the same change that submitted it.
     */
    const CONSTANT_TEMPLATE_NAME = /\b[A-Z_]*TEMPLATE_NAME\s*=\s*'([a-z0-9_]+)'/g;
    const literalTemplateNames = (sources: ReadonlyArray<{ file: string; code: string }>): Map<string, string> => {
        const out = new Map<string, string>();
        for (const { file, code } of sources) {
            for (const m of code.matchAll(LITERAL_TEMPLATE_NAME)) out.set(m[1], `literal at ${file}`);
            for (const m of code.matchAll(CONSTANT_TEMPLATE_NAME)) out.set(m[1], `constant at ${file}`);
        }
        return out;
    };

    const moduleSources = (): Array<{ file: string; code: string }> => {
        const out: Array<{ file: string; code: string }> = [];
        const walk = (rel: string): void => {
            for (const entry of readdirSync(join(scanRoot, rel), { withFileTypes: true })) {
                const child = `${rel}/${entry.name}`;
                if (entry.isDirectory()) walk(child);
                else if (entry.name.endsWith('.ts')) out.push({ file: child, code: readSource(child) });
            }
        };
        walk('src/modules');
        return out;
    };

    /**
     * ⚠ **The allowlist is two NAMES, and the reason is here rather than a pattern.** These are
     * the phone-verification OTP pair (`PHONE_VERIFY_TEMPLATE_NAME` /
     * `PHONE_VERIFY_FALLBACK_TEMPLATE_NAME` defaults). The generator hand-builds them because
     * Meta classifies OTP content as AUTHENTICATION and refuses it anywhere else, so no
     * catalogue can hold them, and the send site reads the name from config rather than a
     * literal. A prefix rule (`wi_mall_*`) would admit the next unsubmitted name for free.
     */
    const HAND_BUILT_OTP_NAMES = new Set(['wi_mall_phone_verification', 'wi_mall_phone_verification_utility']);

    const templateNameProblems = (
        sentNames: Map<string, string>,
        submittedNames: Set<string>,
    ): string[] => {
        const problems: string[] = [];
        for (const [name, where] of sentNames) {
            if (!submittedNames.has(name)) problems.push(`SENT BUT NEVER SUBMITTED: "${name}" (${where})`);
        }
        for (const name of submittedNames) {
            if (!sentNames.has(name) && !HAND_BUILT_OTP_NAMES.has(name)) {
                problems.push(`SUBMITTED BUT NOTHING SENDS IT: "${name}"`);
            }
        }
        for (const name of HAND_BUILT_OTP_NAMES) {
            if (!submittedNames.has(name)) problems.push(`OTP TEMPLATE NOT SUBMITTED: "${name}"`);
        }
        return problems;
    };

    const submittedNames = new Set(payloads.payloads.map(p => p.name));
    const sentNames = (): Map<string, string> =>
        new Map([...catalogTemplateNames(), ...literalTemplateNames(moduleSources())]);

    // Non-vacuity first: an empty set on either side satisfies "every X is in Y" for nothing.
    assert('the name scan read all four catalogues and found a send-site literal', () => {
        const fromCatalogs = catalogTemplateNames();
        const literals = literalTemplateNames(moduleSources());
        const audiences = new Set([...fromCatalogs.values()].map(w => w.split(' ')[0]));
        return audiences.size === 4 && literals.size > 0 && submittedNames.size > 0;
    });

    assert('⛔ every template name a send can ask for was submitted, and every submitted name is sent', () => {
        const problems = templateNameProblems(sentNames(), submittedNames);
        problems.forEach(p => console.error(`     ↳ ${p}`));
        return problems.length === 0;
    });

    /**
     * ⭐ **Shown to BITE**, each against an in-memory copy — no file is mutated, so a crash
     * cannot leave the tree broken. Each checks the failure names the RIGHT thing, not merely
     * that something failed.
     */
    assert('BITE: a catalogue template renamed in memory is reported by name and situation', () => {
        const entry = CUSTOMER_NOTIFICATION_CATALOG['order.payment_failed'].whatsapp.template!;
        const original = entry.name;
        entry.name = 'customer_order_payment_failed_renamed';
        try {
            const problems = templateNameProblems(sentNames(), submittedNames);
            return problems.some(p => p.includes('"customer_order_payment_failed_renamed"')
                    && p.includes('customer catalogue: order.payment_failed'))
                && problems.some(p => p.includes('SUBMITTED BUT NOTHING SENDS IT: "customer_order_payment_failed"'));
        } finally {
            entry.name = original;
        }
    });

    assert('BITE: a name missing from the submitted set is reported (the 2026-09-27 defect, replayed)', () => {
        const before = new Set(submittedNames);
        before.delete('customer_booking_payment_failed');
        return templateNameProblems(sentNames(), before)
            .some(p => p.startsWith('SENT BUT NEVER SUBMITTED: "customer_booking_payment_failed"'));
    });

    assert('BITE: a literal template name at a send site is seen, and a commented-out one is not', () => {
        const live = `x({ type: 'template', name: 'made_up_template' })`;
        const commented = stripComments(`/* x({ type: 'template', name: 'commented_template' }) */`);
        const found = literalTemplateNames([{ file: 'mutant.ts', code: live }, { file: 'c.ts', code: commented }]);
        return found.has('made_up_template') && !found.has('commented_template')
            && templateNameProblems(new Map([...sentNames(), ...found]), submittedNames)
                .some(p => p.includes('"made_up_template" (literal at mutant.ts)'));
    });

    // ─────────────────────────────────────────────────────────────────────────
    //  Stage 2's first blocker: a template quick reply must be SENDABLE
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n── Template quick-reply payload: accepted when present, refused when empty ──');

    /**
     * The real validator, on the exact component shape the out-of-window send will build:
     * the URL button at index 0, then one quick reply per tap, each carrying its token.
     */
    const quickReplyTemplate = (payload: string) => ({
        type: 'template' as const,
        name: 'customer_order_shipped',
        language: 'en',
        components: [
            { type: 'body' as const, parameters: [{ type: 'text' as const, text: 'ORD-2026-000001' }] },
            { type: 'button' as const, sub_type: 'url' as const, index: 0,
                parameters: [{ type: 'text' as const, text: 'orders/x' }] },
            { type: 'button' as const, sub_type: 'quick_reply' as const, index: 1,
                parameters: [{ type: 'payload' as const, payload }] },
        ],
    });
    const refusedAs = (fn: () => void): string | null => {
        try { fn(); return null; } catch (err) { return err instanceof AppError ? err.code : 'NOT_AN_APP_ERROR'; }
    };
    const quietly = <T>(fn: () => T): T => {
        const warn = console.warn;
        console.warn = () => undefined; // the registry's advisory "not registered" warning
        try { return fn(); } finally { console.warn = warn; }
    };

    assert('a quick_reply button carrying a payload token passes the validator', () =>
        quietly(() => refusedAs(() => new TemplateValidator().validate(quickReplyTemplate('ord:' + 'a'.repeat(24))))) === null);

    assert('⛔ an EMPTY payload is refused as WHATSAPP_INVALID_PAYLOAD, before Meta is called', () =>
        quietly(() => refusedAs(() => new TemplateValidator().validate(quickReplyTemplate('  '))))
            === ERROR_CODES.WHATSAPP_INVALID_PAYLOAD);

    /**
     * ⚠ The two lists are a deliberate duplication — the type stops it compiling, the validator
     * stops a cast reaching Meta — so the thing to pin is that they AGREE. Read both as source.
     */
    assert('the TemplateParameter.type union and the validator\'s allowlist name the same types', () => {
        const types = readSource('src/modules/whatsapp/types/whatsapp-message.types.ts');
        const validator = readSource('src/modules/whatsapp/handlers/template/template-validator.ts');
        const union = types.match(/interface TemplateParameter \{\s*type:\s*([^;]+);/);
        const list = validator.match(/private validateParameter[\s\S]*?const validTypes = \[([^\]]+)\]/);
        if (!union || !list) return false;
        const names = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort().join(',');
        return names(union[1]).includes('payload') && names(union[1]) === names(list[1]);
    });

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
    /**
     * ⚠ **This proof used `rate:` and had to be re-pointed within the hour** — another stream
     * registered `rate` while this was being written, so the token stopped being dead and the
     * proof went green for the wrong reason. Instructive rather than annoying: a bite proof
     * anchored on a CURRENT defect expires the moment somebody fixes it, exactly like a count.
     *
     * `skip` is the durable choice: declared in `BOT_ACTION_VERBS` and registered by nobody
     * **on purpose**, so it parses (proving the registry half of the check bites, not the
     * parser half) and nobody is about to claim it.
     */
    assert('PROOF: a declared-but-unregistered verb is caught (`skip`, parses, no handler)', () => {
        const parsed = parseBotActionId(`skip:${ID}`);
        return parsed !== null && !keys.has(actionKeyOf(parsed).key);
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

    // ── A payment result goes back to the chat the checkout came from (2026-09-22) ──────────
    //
    // The owner's handset: an order placed and approved on WhatsApp had its "payment received"
    // sent to TELEGRAM, because the account is linked to both and the one secondary channel is
    // chosen telegram > email > whatsapp — minutes after the chat said "the result arrives in
    // this chat". The results below were measured by `measureOriginChat` before `main` ran.
    assert('the defect, reproduced: with no origin, the owner\'s account gets Telegram', () =>
        JSON.stringify(ORIGIN_CHAT.ownerNoOrigin) === JSON.stringify(['in-app', 'telegram']));
    assert('⭐ a checkout placed on WhatsApp is answered on WhatsApp, not Telegram', () =>
        JSON.stringify(ORIGIN_CHAT.ownerWhatsApp) === JSON.stringify(['in-app', 'whatsapp']));
    assert('⭐ the origin REPLACES the preference choice — one result, told once', () =>
        ORIGIN_CHAT.ownerWhatsApp.length === 2 && !ORIGIN_CHAT.ownerWhatsApp.includes('telegram'));
    assert('a checkout placed on Telegram is answered on Telegram', () =>
        JSON.stringify(ORIGIN_CHAT.telegramOrigin) === JSON.stringify(['in-app', 'telegram']));
    assert('an origin chat the account is no longer linked to falls back to the preference order', () =>
        JSON.stringify(ORIGIN_CHAT.unlinked) === JSON.stringify(['in-app', 'telegram']));
    assert('the origin is not gated on that channel\'s own switch (it answers the customer\'s own action)', () =>
        JSON.stringify(ORIGIN_CHAT.mutedChannel) === JSON.stringify(['in-app', 'whatsapp']));

    const orchestratorSource = readFileSync(
        join(__dirname, '../../src/modules/payments/services/payment-orchestrator.service.ts'), 'utf8'
    ).replace(/\r\n/g, '\n');
    const originHandlerSource = readFileSync(
        join(__dirname, '../../src/modules/notifications/services/customer-notification-event-handler.service.ts'), 'utf8'
    ).replace(/\r\n/g, '\n');
    const modelSource = readFileSync(
        join(__dirname, '../../src/modules/payments/models/payment-transaction.model.ts'), 'utf8'
    ).replace(/\r\n/g, '\n');
    const cartInitiate = orchestratorSource.slice(
        orchestratorSource.indexOf('async initiatePaymentForCart('),
        orchestratorSource.indexOf('private async', orchestratorSource.indexOf('async initiatePaymentForCart('))
    );

    assert('the chat is stamped WITH the new row, before the gateway is called (a charge can settle in seconds)', () =>
        cartInitiate.length > 0
        && cartInitiate.indexOf('originChat: { channel: options.originChat }') > 0
        && cartInitiate.indexOf('originChat: { channel: options.originChat }') < cartInitiate.indexOf('gatewayInstance.initiatePayment('));
    /**
     * ⚠ **Four, not two, since bookings phase 6 (2026-09-27)** — the cart's received + failed, and
     * the BOOKING's received + failed, which had the same defect one product type over. An exact
     * count rather than ≥: a fifth site is a new decision somebody should have to look at, and
     * losing one of the four is the bug. The booking half is pinned per site in
     * `test:booking-notification`.
     */
    assert('all four payment result events carry the chat (cart AND booking; received AND failed)', () =>
        orchestratorSource.split('originChannel: transaction.originChat?.channel ?? undefined').length - 1 === 4);
    assert('all four customer handlers pass it on, filtered to the two chat channels', () =>
        originHandlerSource.split('originChat: originChatOf(p.originChannel)').length - 1 === 4
        && /value === 'whatsapp' \|\| value === 'telegram' \? value : undefined/.test(originHandlerSource));
    assert('the stored value is one of the two chats, and absent (never null) elsewhere', () =>
        /originChat: \{\s*type: \{\s*channel: \{ type: String, enum: \['whatsapp', 'telegram'\], required: true \}\s*\},\s*default: undefined/.test(modelSource));

    console.log('\n── The shop is named by its STORE name, never "the provider" ──');
    // Owner's handset 2026-09-22: "…ORD-2026-000004. the provider is preparing it now." and "Your
    // order … with the provider is placed" — neither event carries a vendor name, so both fell
    // back to the generic word on every order. Booking messages named the vendor's PERSONAL name.
    assert('shopNameOf returns the store\'s name, trimmed', () => SHOP_NAME.found === 'Ulrich Shop');
    assert('no store row, a failing lookup or a malformed id → null (the generic wording), never a throw', () =>
        SHOP_NAME.missing === null && SHOP_NAME.throws === null && SHOP_NAME.badId === null && SHOP_NAME.badIdLookups === 0);

    console.log('\n── order.refunded has a trigger — it was built and nothing raised it ──');
    // Measured by `measureOrderRefunded` before `main` ran: the real handler, two stubs.
    assert('an order refund produces exactly ONE order.refunded, with this refund\'s amount', () =>
        ORDER_REFUNDED.order.length === 1
        && ORDER_REFUNDED.order[0].situation === 'order.refunded'
        && ORDER_REFUNDED.order[0].amountFormatted === '2,000'
        && ORDER_REFUNDED.order[0].currency === 'XAF');
    assert('⛔ a BOOKING refund is dropped — booking.payment.updated already tells that customer', () =>
        ORDER_REFUNDED.booking.length === 0);
    assert('⛔ two partial refunds of one order are two messages — the key is per REFUND, not per order', () =>
        ORDER_REFUNDED.twoPartials.length === 2
        && ORDER_REFUNDED.twoPartials[0].key !== ORDER_REFUNDED.twoPartials[1].key);
    console.log('\n── The COD code: the notification channel only; WhatsApp free-form first, template on refusal ──');
    const orderToken = `ord:6aad69bac51c555c27cc10d9`;
    assert('Telegram customer → the code arrives on TELEGRAM, with "Order details", and nowhere else', () =>
        COD_CODE.telegram.result === 'telegram'
        && COD_CODE.telegram.sends.length === 1
        && COD_CODE.telegram.sends[0].channel === 'telegram'
        && (COD_CODE.telegram.sends[0].body ?? '').includes('483920')
        && JSON.stringify(COD_CODE.telegram.sends[0].tokens) === JSON.stringify([orderToken]));
    assert('no notification channel → nothing is sent (the code stays in the app)', () =>
        COD_CODE.none.result === null && COD_CODE.none.sends.length === 0);
    assert('WhatsApp inside the window → ONE free-form message, and NO template', () =>
        COD_CODE.waInWindow.result === 'whatsapp'
        && COD_CODE.waInWindow.sends.length === 1
        && COD_CODE.waInWindow.sends[0].kind === 'free'
        && COD_CODE.waInWindow.sends[0].to === '+237600000001');
    assert('⛔ WhatsApp refused for the window → the AUTHENTICATION template: the code in the body AND the copy button', () => {
        const [free, template] = COD_CODE.waOutOfWindow.sends;
        return COD_CODE.waOutOfWindow.result === 'whatsapp'
            && COD_CODE.waOutOfWindow.sends.length === 2
            && free.kind === 'free' && (free.body ?? '').includes('483920')
            && template.kind === 'template'
            && JSON.stringify(template.templateParams) === JSON.stringify(['483920'])
            && template.buttonUrlParams?.[0] === '483920';
    });
    /**
     * ⛔ Meta REJECTED `cod_delivery_code` twice as UTILITY (2026-09-27, `INCORRECT_CATEGORY`). The
     * template is AUTHENTICATION under a new name. Pinned so nobody "restores" a UTILITY body.
     */
    assert('⛔ the submitted delivery-code template is AUTHENTICATION: Meta\'s body, no "do not share", a copy button', () =>
        (['en', 'fr'] as const).every(l => {
            const p = (payloads.payloads as Array<{ name: string; language: string; category?: string; components?: any[] }>)
                .find(x => x.name === DELIVERY_CODE_TEMPLATE_NAME && x.language === l);
            const body = p?.components?.find(c => c.type === 'BODY');
            const buttons = p?.components?.find(c => c.type === 'BUTTONS')?.buttons ?? [];
            return p?.category === 'AUTHENTICATION'
                && body !== undefined && body.text === undefined
                && body.add_security_recommendation === false
                && !p.components!.some(c => c.type === 'FOOTER')
                && buttons.length === 1 && buttons[0].type === 'OTP' && buttons[0].otp_type === 'COPY_CODE'
                && buttons[0].text === COPY_CODE_LABEL[l];
        })
        // The rejected UTILITY name is retired: nothing may generate or send it again.
        && !payloads.payloads.some(p => p.name === 'cod_delivery_code'));
    assert('email customer → email, carrying the code', () =>
        COD_CODE.email.result === 'email' && (COD_CODE.email.sends[0]?.body ?? '').includes('483920'));
    assert('⛔ the COD path never records to the bot\'s recentlySent — the code is a credential', () =>
        !readSource('src/modules/cod/services/delivery-code.service.ts').includes('noteSent')
        && !readSource('src/modules/cod/services/cash-collection.service.ts').includes('noteSent'));
    assert('⛔ the COD path no longer addresses WhatsApp from Customer.phone', () =>
        !/customer\??\.phone/.test(readSource('src/modules/cod/services/cash-collection.service.ts'))
        && !readSource('src/modules/cod/services/delivery-code.service.ts').includes('customerPhone'));

    console.log('\n── Template quick replies: one payload per approved button, never fewer ──');
    const ctxBase = { orderId: 'a'.repeat(24), orderNumber: 'ORD-1', ticketId: 'b'.repeat(24) };
    assert('ticket.resolved on a RESOLVED request carries the reopen token', () =>
        JSON.stringify(renderCustomerTemplateQuickReplies('ticket.resolved', { ...ctxBase, reopenableTicketId: 'b'.repeat(24) }))
            === JSON.stringify([`tkt:${'b'.repeat(24)}`]));
    assert('⛔ on a CLOSED request the button is still there, so it carries tkt:new — never nothing', () =>
        JSON.stringify(renderCustomerTemplateQuickReplies('ticket.resolved', { ...ctxBase, reopenableTicketId: '' }))
            === JSON.stringify(['tkt:new']));
    assert('booking.payment_failed: two chat actions, ONE template button, filled by whichever resolved', () =>
        customerTemplateQuickReplyLabels('booking.payment_failed').length === 1
        && JSON.stringify(renderCustomerTemplateQuickReplies('booking.payment_failed', { payBalanceBookingId: 'c'.repeat(24) }))
            === JSON.stringify([`bpay:${'c'.repeat(24)}:b`]));
    assert('every situation sends exactly as many payloads as its template has quick-reply buttons', () =>
        (Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[]).every(s =>
            renderCustomerTemplateQuickReplies(s, {}).length === customerTemplateQuickReplyLabels(s).length));

    /**
     * ⛔ **The submitted payloads must hold exactly the buttons the send fills.** A send with a
     * quick-reply parameter the approved template lacks is refused by Meta — silence — and one
     * without a parameter for a button it has delivers a tap the bot cannot route. Read from
     * the committed file, so a catalogue change that was not regenerated turns this red.
     */
    assert('⛔ the committed template payloads hold exactly the quick replies the send fills, en and fr', () => {
        const problems: string[] = [];
        for (const s of Object.keys(CUSTOMER_NOTIFICATION_CATALOG) as CustomerNotificationType[]) {
            if (!CUSTOMER_NOTIFICATION_CATALOG[s].whatsapp.template) continue;
            const name = CUSTOMER_NOTIFICATION_CATALOG[s].whatsapp.template.name;
            for (const [lang, code] of [['en', 'en'], ['fr', 'fr']] as const) {
                const payload = (payloads.payloads as Array<{ name: string; language: string; components?: any[] }>)
                    .find(p => p.name === name && p.language === code);
                const submitted = (payload?.components?.find(c => c.type === 'BUTTONS')?.buttons ?? [])
                    .filter((b: any) => b.type === 'QUICK_REPLY').map((b: any) => b.text);
                const expected = customerTemplateQuickReplyLabels(s).map(l => l[lang]);
                if (JSON.stringify(submitted) !== JSON.stringify(expected)) {
                    problems.push(`${name} [${code}]: file ${JSON.stringify(submitted)} vs catalogue ${JSON.stringify(expected)}`);
                }
            }
        }
        problems.forEach(p => console.error(`     ↳ ${p}`));
        return problems.length === 0;
    });

    assert('BITE: a placeholder token with no templateFallback is refused at boot', () => {
        const action = CUSTOMER_NOTIFICATION_CATALOG['order.shipped'].actions![0];
        const saved = action.templateFallback;
        delete action.templateFallback;
        try {
            assertCustomerQuickRepliesSendable();
            return false;
        } catch (err) {
            return (err as Error).message.includes('no templateFallback');
        } finally {
            action.templateFallback = saved;
        }
    });

    assert('the out-of-window send path fills the quick replies with explicit payloads', () => {
        const handler = readSource('src/modules/notifications/services/customer-notification-event-handler.service.ts');
        return handler.includes('renderCustomerTemplateQuickReplies(situation, context)')
            && handler.includes("sub_type: 'quick_reply'")
            && handler.includes("parameters: [{ type: 'payload', payload }]");
    });

    console.log('\n── The basket reminder: in-window only, gated, swept once per basket state ──');
    assert('⛔ OUT of the window the basket reminder sends NOTHING on WhatsApp — no template exists', () =>
        CART_WA.outOfWindow.delivered === false && CART_WA.outOfWindow.sends === 0);
    assert('inside the window it is one free-form message (never a template)', () =>
        CART_WA.inWindow.delivered === true && CART_WA.inWindow.sends === 1 && CART_WA.inWindow.kind !== 'template');
    assert('cart.abandoned is the in-window-only situation, and it has copy in all five languages', () =>
        IN_WINDOW_ONLY_SITUATIONS.has('cart.abandoned')
        && CUSTOMER_NOTIFICATION_CATALOG['cart.abandoned'].whatsapp.template === undefined
        && SUPPORTED_LANGUAGES.every(l => !!CUSTOMER_NOTIFICATION_CATALOG['cart.abandoned'].base[l]));
    assert('⛔ the reminder names what is in the basket and NEVER a price', () =>
        SUPPORTED_LANGUAGES.every(l => {
            const body = CUSTOMER_NOTIFICATION_CATALOG['cart.abandoned'].base[l].body;
            return body.includes('{{itemSummary}}') && !/\{\{\s*(amount|price|total|currency)/i.test(body);
        }));
    assert('BITE: a situation that loses its template without being listed is refused at boot', () => {
        const whatsapp = CUSTOMER_NOTIFICATION_CATALOG['order.shipped'].whatsapp;
        const saved = whatsapp.template;
        delete whatsapp.template;
        try {
            assertCustomerCatalogComplete();
            return false;
        } catch (err) {
            return (err as Error).message.includes('not listed in IN_WINDOW_ONLY_SITUATIONS');
        } finally {
            whatsapp.template = saved;
        }
    });
    assert('the item summary: one title, or the first and a localized count', () =>
        cartItemSummary(['Blue dress'], 'en') === 'Blue dress'
        && cartItemSummary(['Blue dress', 'Red hat', 'Shoes'], 'en') === 'Blue dress and 2 more'
        && cartItemSummary(['Robe', 'Chapeau'], 'fr') === 'Robe et 1 autre');
    const line = (id: string, type: 'physical' | 'digital' = 'physical') =>
        ({ productId: `p${id}`, variantId: `v${id}`, title: `T${id}`, productType: type }) as never;
    assert('buyable: an archived product, an archived variant, or no stock is not named', () =>
        JSON.stringify(buyableTitlesFrom(
            [line('1'), line('2'), line('3'), line('4'), line('5', 'digital')],
            [{ _id: 'p1', status: 'active' }, { _id: 'p2', status: 'archived' }, { _id: 'p3', status: 'active' },
                { _id: 'p4', status: 'active' }, { _id: 'p5', status: 'active' }],
            [{ _id: 'v1', status: 'active', stock: 3 }, { _id: 'v2', status: 'active', stock: 3 },
                { _id: 'v3', status: 'archived', stock: 3 }, { _id: 'v4', status: 'active', stock: 0 },
                { _id: 'v5', status: 'active', stock: 0 }]))
            === JSON.stringify(['T1', 'T5']));
    assert('buyable: out of stock but oversell allowed still counts', () =>
        JSON.stringify(buyableTitlesFrom([line('1')], [{ _id: 'p1', status: 'active' }],
            [{ _id: 'v1', status: 'active', stock: 0, allow_oversell: true }])) === JSON.stringify(['T1']));
    {
        const worker = readSource('src/modules/cart/workers/abandoned-cart.worker.ts');
        const config = readSource('src/modules/cart/config/cart.config.ts');
        assert('ships OFF, 12 hours, and reports the SAME interval it schedules with', () =>
            CART_CONFIG.reminder.enabled === (process.env.CART_REMINDER_ENABLED === 'true')
            && /enabled: process\.env\.CART_REMINDER_ENABLED === 'true'/.test(config)
            && /CART_REMINDER_LEAD_MINUTES \|\| '720'/.test(config)
            && abandonedCartWorker.schedules[0].kind === 'interval'
            && (abandonedCartWorker.schedules[0] as { everyMs: number }).everyMs === CART_CONFIG.reminder.intervalMs);
        assert('⛔ the idempotency key carries the basket\'s updatedAt — a basket abandoned again is reminded again', () =>
            worker.includes('idempotencyKey: `customer.cart.abandoned:${cart._id}:${new Date(cart.updatedAt).getTime()}`'));
        assert('the sweep tiles [now−lead−interval, now−lead) and skips an empty basket', () =>
            worker.includes('updatedAt: { $gte: windowStart, $lt: windowEnd }')
            && worker.includes("'items.0': { $exists: true }")
            && worker.includes("withWorkerLock('abandoned-cart'"));
        assert('the cart schema declares the updatedAt index the sweep needs', () =>
            /CartSchema\.index\(\{ updatedAt: 1 \}/.test(readSource('src/modules/cart/models/cart.model.ts')));
        assert('⛔ gated by cartReminders — it is not in the ungated list', () =>
            readSource('src/modules/notifications/services/customer-notification-event-handler.service.ts')
                .includes("'cart.abandoned': 'cartReminders'")
            && !UNMUTABLE.includes('cart.abandoned'));
    }

    assert('the consumer subscribes payment.refunded to the handler (the publisher already existed)', () =>
        readSource('src/modules/notifications/customer-notification-event-consumer.ts')
            .includes("eventBus.subscribe('payment.refunded', handler.handleOrderRefunded.bind(handler));"));

    const orderCreatedSpan = originHandlerSource.slice(
        originHandlerSource.indexOf('async handleOrderCreated('),
        originHandlerSource.indexOf('async handleOrderPaymentReceived('));
    const paymentReceivedSpan = originHandlerSource.slice(
        originHandlerSource.indexOf('async handleOrderPaymentReceived('),
        originHandlerSource.indexOf('async handleOrderPaymentFailed('));
    const namesTheShop = (created: string, received: string): boolean =>
        created.length > 0 && received.length > 0
        && created.includes('const vendorName = p.vendorName ?? (await this.shopNameOf(p.vendorId));')
        && created.includes('vendorName: vendorName ?? this.genericVendor(lang),')
        && received.includes('const { customer, orderNumber, vendorName } = await this.customerFromOrder(')
        && received.includes('vendorName: p.vendorName ?? vendorName ?? this.genericVendor(lang),');
    assert('order placed AND payment received look the shop up; "the provider" is only the fallback', () =>
        namesTheShop(orderCreatedSpan, paymentReceivedSpan)
        && /\.select\('customer_id vendor_id order_number/.test(originHandlerSource)
        && originHandlerSource.includes('vendorName: await this.shopNameOf(order.vendor_id?.toString())'));
    assert('PROOF: the scan bites on the handler as it was (straight to the generic word)', () =>
        !namesTheShop(orderCreatedSpan.replace('(await this.shopNameOf(p.vendorId))', 'undefined'), paymentReceivedSpan));
    const bookingSource = readFileSync(
        join(__dirname, '../../src/modules/booking/services/booking.service.ts'), 'utf8'
    ).replace(/\r\n/g, '\n');
    const bookingNameSpan = bookingSource.slice(
        bookingSource.indexOf('private async resolveVendorName('),
        bookingSource.indexOf('private async resolveVendorIdentity('));
    const orderServiceSource = readFileSync(
        join(__dirname, '../../src/modules/orders/order.service.ts'), 'utf8'
    ).replace(/\r\n/g, '\n');
    assert('"order placed" counts PACKS: the event carries units and the customer copy prefers them to lines', () =>
        orderServiceSource.includes('unitCount: order.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)')
        && orderServiceSource.includes('itemCount: order.items.length,')
        && orderCreatedSpan.includes('itemCount: String(p.unitCount && p.unitCount > 0 ? p.unitCount : (p.itemCount ?? 1)),'));
    assert('booking messages name the store first, the vendor\'s personal name only without one', () =>
        bookingNameSpan.indexOf('this.storeRepo.findNameByVendorId(vendorId)') > 0
        && bookingNameSpan.indexOf('this.storeRepo.findNameByVendorId(vendorId)') < bookingNameSpan.indexOf('this.vendorRepo.findById(vendorId)')
        && bookingSource.includes('vendorName: shop || (vendor?.display_name ?? null),'));

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

/**
 * The channel choice, measured on the REAL method with only the connection lookup stubbed.
 *
 * `main` and `assert` are synchronous, so this runs first and `main` asserts on what it found.
 * The handler is created WITHOUT its constructor (`Object.create`): the constructor builds the
 * mail, Telegram, WhatsApp and push services, and the method under test touches none of them.
 */
const ORIGIN_CHAT: Record<'ownerNoOrigin' | 'ownerWhatsApp' | 'telegramOrigin' | 'unlinked' | 'mutedChannel', string[]> = {
    ownerNoOrigin: [], ownerWhatsApp: [], telegramOrigin: [], unlinked: [], mutedChannel: [],
};
async function measureOriginChat(): Promise<void> {
    type ChannelChooser = {
        determineDeliveryChannels(customer: unknown, prefs: unknown, originChat?: 'whatsapp' | 'telegram'): Promise<string[]>;
    };
    const handler = Object.create(CustomerNotificationEventHandler.prototype) as ChannelChooser;
    const lookup = connectionService as unknown as { getConnectionMap: (userId: unknown) => Promise<unknown> };
    const customer = { user_id: 'user-1', email: null, email_verified: false };
    const prefs = { telegramEnabled: true, emailEnabled: false, whatsappEnabled: true };
    const bothLinked = { telegram: { channel: 'telegram' }, whatsapp: { channel: 'whatsapp' } };
    const telegramOnly = { telegram: { channel: 'telegram' } };

    const run = async (map: unknown, p: unknown, origin?: 'whatsapp' | 'telegram'): Promise<string[]> => {
        lookup.getConnectionMap = async () => map;
        try {
            return await handler.determineDeliveryChannels(customer, p, origin);
        } finally {
            // An own property shadows the prototype's method; deleting it restores the real one.
            delete (lookup as { getConnectionMap?: unknown }).getConnectionMap;
        }
    };

    ORIGIN_CHAT.ownerNoOrigin = await run(bothLinked, prefs);
    ORIGIN_CHAT.ownerWhatsApp = await run(bothLinked, prefs, 'whatsapp');
    ORIGIN_CHAT.telegramOrigin = await run(bothLinked, { ...prefs, telegramEnabled: false }, 'telegram');
    ORIGIN_CHAT.unlinked = await run(telegramOnly, prefs, 'whatsapp');
    ORIGIN_CHAT.mutedChannel = await run(bothLinked, { ...prefs, whatsappEnabled: false }, 'whatsapp');
}

/**
 * `shopNameOf`, measured on the REAL method with only the store lookup stubbed — same
 * constructor-free handler as above, for the same reason.
 */
const SHOP_NAME: { found: string | null; missing: string | null; throws: string | null; badId: string | null; badIdLookups: number } = {
    found: null, missing: 'unmeasured', throws: 'unmeasured', badId: 'unmeasured', badIdLookups: -1,
};

async function measureShopName(): Promise<void> {
    type ShopNamer = {
        shopNameOf(vendorId?: string | null): Promise<string | null>;
        storeRepo: { findNameByVendorId(vendorId: string): Promise<string | null> };
    };
    const handler = Object.create(CustomerNotificationEventHandler.prototype) as unknown as ShopNamer;
    const VENDOR = '6aad69bac51c555c27cc10d6';
    let lookups = 0;

    handler.storeRepo = { findNameByVendorId: async () => '  Ulrich Shop ' };
    SHOP_NAME.found = await handler.shopNameOf(VENDOR);
    handler.storeRepo = { findNameByVendorId: async () => null };
    SHOP_NAME.missing = await handler.shopNameOf(VENDOR);
    handler.storeRepo = { findNameByVendorId: () => Promise.reject(new Error('store lookup down')) };
    SHOP_NAME.throws = await handler.shopNameOf(VENDOR);
    handler.storeRepo = { findNameByVendorId: async () => { lookups += 1; return 'Never asked'; } };
    SHOP_NAME.badId = await handler.shopNameOf('not-an-object-id');
    SHOP_NAME.badIdLookups = lookups;
}

/**
 * `handleOrderRefunded`, measured on the REAL method with `customerFromOrder` and `notify`
 * stubbed as own properties — the same constructor-free handler as above. What is recorded is
 * what `notify` was asked to send, so the assertions read the handler's decisions directly.
 */
type RefundSend = { situation: string; key: string; amountFormatted: string; currency: string };
const ORDER_REFUNDED: { order: RefundSend[]; booking: RefundSend[]; twoPartials: RefundSend[] } = {
    order: [], booking: [], twoPartials: [],
};

async function measureOrderRefunded(): Promise<void> {
    type Refunder = {
        handleOrderRefunded(event: unknown): Promise<void>;
        customerFromOrder: (orderId: string) => Promise<unknown>;
        notify: (params: { situation: string; idempotencyKey: string; context: Record<string, string> }) => Promise<void>;
    };
    const handler = Object.create(CustomerNotificationEventHandler.prototype) as unknown as Refunder;
    const ORDER = '6aad69bac51c555c27cc10d7';
    handler.customerFromOrder = async () => ({
        customer: { _id: '6aad69bac51c555c27cc10d8' }, orderNumber: 'ORD-2026-000001', currency: 'XAF',
    });

    const run = async (payloads: Array<Record<string, unknown>>): Promise<RefundSend[]> => {
        const sent: RefundSend[] = [];
        handler.notify = async (p) => {
            sent.push({
                situation: p.situation, key: p.idempotencyKey,
                amountFormatted: p.context.amountFormatted, currency: p.context.currency,
            });
        };
        for (const payload of payloads) {
            await handler.handleOrderRefunded({ eventType: 'payment.refunded', payload, occurredAt: new Date() });
        }
        return sent;
    };

    ORDER_REFUNDED.order = await run([
        { orderId: ORDER, sourceKind: 'order', refundId: 'r1', amount: 2000, currency: 'XAF', fullyRefunded: false },
    ]);
    ORDER_REFUNDED.booking = await run([
        { bookingId: ORDER, sourceKind: 'booking', refundId: 'r2', amount: 2000, currency: 'XAF', fullyRefunded: true },
    ]);
    ORDER_REFUNDED.twoPartials = await run([
        { orderId: ORDER, sourceKind: 'order', refundId: 'r3', amount: 2000, currency: 'XAF', fullyRefunded: false },
        { orderId: ORDER, sourceKind: 'order', refundId: 'r4', amount: 3000, currency: 'XAF', fullyRefunded: true },
    ]);
}

/**
 * `DeliveryCodeService.sendToCustomer`, measured on the REAL method with every outbound seam
 * stubbed: Telegram and mail by injection, the WhatsApp messaging singleton's `send` and the
 * connection lookup as own properties (deleted afterwards, restoring the prototype's).
 * Records what each channel was asked to send.
 */
type CodSend = { channel: string; kind?: string; to?: string; body?: string; tokens: string[]; templateParams?: string[]; buttonUrlParams?: string[] };
const COD_CODE: Record<'telegram' | 'none' | 'waInWindow' | 'waOutOfWindow' | 'email', { result: string | null; sends: CodSend[] }> = {
    telegram: { result: 'unmeasured', sends: [] }, none: { result: 'unmeasured', sends: [] },
    waInWindow: { result: 'unmeasured', sends: [] }, waOutOfWindow: { result: 'unmeasured', sends: [] },
    email: { result: 'unmeasured', sends: [] },
};

async function measureCodDeliveryCode(): Promise<void> {
    const ORDER = '6aad69bac51c555c27cc10d9';
    const customer = { _id: 'c1', user_id: 'u1', name: 'Test', email: 'test@example.com', email_verified: true };
    const messaging = getWhatsAppMessagingService() as unknown as { send: (p: unknown) => Promise<unknown> };
    const lookup = connectionService as unknown as { getConnection: (u: unknown, c: unknown) => Promise<unknown> };

    const run = async (
        channel: 'telegram' | 'email' | 'whatsapp' | null,
        freeFormRefused: boolean,
    ): Promise<{ result: string | null; sends: CodSend[] }> => {
        const sends: CodSend[] = [];
        const telegram = { send: async (p: { message: string; quickReplies?: Array<{ token: string }> }) => {
            sends.push({ channel: 'telegram', body: p.message, tokens: (p.quickReplies ?? []).map(q => q.token) });
            return { success: true };
        } };
        const mail = { send: async (p: { variables: { message: string } }) => {
            sends.push({ channel: 'email', body: p.variables.message, tokens: [] });
        } };
        messaging.send = async (payload: unknown) => {
            const p = payload as { to: string; type: string; message: any };
            if (p.type === 'template') {
                const comps = p.message.components as Array<{ type: string; sub_type?: string; parameters: any[] }>;
                sends.push({
                    channel: 'whatsapp', kind: 'template', to: p.to,
                    templateParams: comps.find(c => c.type === 'body')!.parameters.map(x => x.text),
                    tokens: comps.filter(c => c.sub_type === 'quick_reply').map(c => c.parameters[0].payload),
                    buttonUrlParams: comps.filter(c => c.sub_type === 'url').map(c => c.parameters[0].text),
                });
                return { success: true };
            }
            sends.push({ channel: 'whatsapp', kind: 'free', to: p.to, body: p.message?.body?.text,
                tokens: (p.message?.action?.buttons ?? []).map((b: any) => b.reply?.id ?? b.id) });
            return freeFormRefused
                ? { success: false, error: { code: 'WHATSAPP_POLICY_VIOLATION' } }
                : { success: true };
        };
        lookup.getConnection = async () => ({ external_id: '237600000001' });
        try {
            const service = new DeliveryCodeService(undefined, telegram as never, mail as never);
            const result = await service.sendToCustomer({
                customer, channels: { notificationChannelFor: async () => channel },
                code: '483920', orderId: ORDER, orderNumber: 'ORD-2026-000001',
                expectedAmount: 15000, currency: 'XAF', language: 'fr', dedupeKey: 'k1',
            });
            return { result, sends };
        } finally {
            delete (messaging as { send?: unknown }).send;
            delete (lookup as { getConnection?: unknown }).getConnection;
        }
    };

    COD_CODE.telegram = await run('telegram', false);
    COD_CODE.none = await run(null, false);
    COD_CODE.waInWindow = await run('whatsapp', false);
    COD_CODE.waOutOfWindow = await run('whatsapp', true);
    COD_CODE.email = await run('email', false);
}

/**
 * The REAL `sendWhatsApp` for the basket reminder, in and out of the 24-hour window, with the
 * window check, the connection lookup and the messaging singleton stubbed. Records what was
 * asked of Meta.
 */
const CART_WA: { outOfWindow: { delivered: unknown; sends: number }; inWindow: { delivered: unknown; sends: number; kind?: string } } = {
    outOfWindow: { delivered: 'unmeasured', sends: -1 }, inWindow: { delivered: 'unmeasured', sends: -1 },
};

async function measureCartWhatsApp(): Promise<void> {
    type Sender = {
        sendWhatsApp(customer: unknown, situation: string, lang: string, ctx: unknown, key: string): Promise<boolean>;
        whatsappWindow: { canSendFreeMessage(id: string): Promise<boolean> };
        isWhatsAppProviderConfigured(): boolean;
    };
    const handler = Object.create(CustomerNotificationEventHandler.prototype) as unknown as Sender;
    const messaging = getWhatsAppMessagingService() as unknown as { send: (p: unknown) => Promise<unknown> };
    const lookup = connectionService as unknown as { getConnection: (u: unknown, c: unknown) => Promise<unknown> };
    handler.isWhatsAppProviderConfigured = () => true;

    const run = async (open: boolean) => {
        let sends = 0;
        let kind: string | undefined;
        handler.whatsappWindow = { canSendFreeMessage: async () => open };
        messaging.send = async (p: unknown) => { sends++; kind = (p as { type: string }).type; return { success: true }; };
        lookup.getConnection = async () => ({ external_id: '237600000001' });
        try {
            const delivered = await handler.sendWhatsApp(
                { user_id: 'u1' }, 'cart.abandoned', 'en', { itemSummary: 'Blue dress' }, 'k1');
            return { delivered, sends, kind };
        } finally {
            delete (messaging as { send?: unknown }).send;
            delete (lookup as { getConnection?: unknown }).getConnection;
        }
    };
    CART_WA.outOfWindow = await run(false);
    CART_WA.inWindow = await run(true);
}

measureOriginChat().then(measureShopName).then(measureOrderRefunded).then(measureCodDeliveryCode).then(measureCartWhatsApp).then(main, (error: unknown) => {
    console.error('measurement failed:', error);
    process.exit(1);
});
