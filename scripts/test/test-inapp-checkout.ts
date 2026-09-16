/**
 * Test: STREAM D — the checkout screen and the payment it starts.
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free.
 *
 * ── ⚠ WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 * Five sessions build this surface in **one working tree with no branching**. Two sessions
 * appending to one shared suite is a read-then-write race on disk, not a merge conflict — one
 * session's work simply disappears. So `test-bot-surface.ts` is touched by **nobody**, and
 * this file is **Stream D's alone**.
 *
 * ── ⚠ AND THIS IS THE STREAM WHOSE MISTAKES COST MONEY ──────────────────────
 * The `co` handle authorises **placing an order against a stranger's saved address and
 * starting a payment**, from a URL carrying no other credential. Every assertion in § 1 is
 * one of the four things that keeps that safe. If one fails, stop and read
 * `inapp-surface.store.ts` before changing anything.
 *
 * Run: npm run test:inapp-checkout
 */
import fs from 'fs';
import path from 'path';
import { TTL_SECONDS, InAppSurfaceStore } from '../../src/modules/bot-surface/services/inapp-surface.store';
import { __IN_APP_COPY, inAppCopy } from '../../src/modules/bot-surface/miniapp/inapp-copy';
import { __SCREEN_KINDS } from '../../src/modules/bot-surface/miniapp/inapp-page.controller';
import { BOT_COPY_LANGUAGES } from '../../src/modules/bot-surface/domain/bot-error-copy';
// ── § 2's imports (Stream D) ────────────────────────────────────────────────
/**
 * ⚠ **The masking rules are imported from `checkout-masking.ts`, NOT from the controller, and
 * the reason is load-bearing for this whole suite.** `checkout.controller.ts` imports
 * `orders/order.service` and `payments/`, both of which do work at import time and never return
 * in a bare `ts-node` process — which is exactly how these suites run. An import of the
 * controller here hangs the run with no output at all, and the repair somebody reaches for
 * under that symptom is deleting the assertions rather than moving the functions.
 */
import { maskAddress, accountIdentifier } from '../../src/modules/bot-surface/miniapp/surfaces/checkout-masking';
import {
    customerWhatsAppTemplateName,
    renderCustomerInApp,
} from '../../src/modules/notifications/catalog/customer-notification-catalog';
import { SUPPORTED_LANGUAGES } from '../../src/core/constants/languages';
import type { ICustomer, ICustomerSavedAddress } from '../../src/modules/customers/customer.model';

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

const PUBLIC_DIR = path.join(__dirname, '../../src/modules/bot-surface/miniapp/public');
const STORE_SRC = path.join(__dirname, '../../src/modules/bot-surface/services/inapp-surface.store.ts');

const page = (): string => fs.readFileSync(path.join(PUBLIC_DIR, 'co.html'), 'utf8');
/** Comments explain the rules; the scans below must read the CODE, not the explanation. */
const code = (): string => page().replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ─────────────────────────────────────────────────────────────────────────────
//  § 2's own fixtures (Stream D)
//
//  ⚠ Every scan below strips comments FIRST, for the reason § 1 records: these files
//  *explain* the rules they obey, and a guard that read the explanation as the offence would
//  fail on the file that gets it right — which is how a correct guard teaches somebody to
//  delete the comment that makes the code legible.
// ─────────────────────────────────────────────────────────────────────────────

const SCREEN_SRC = path.join(
    __dirname,
    '../../src/modules/bot-surface/miniapp/surfaces/checkout.controller.ts',
);
const CHAT_SRC = path.join(
    __dirname,
    '../../src/modules/bot-surface/controllers/bot-checkout.controller.ts',
);

const stripTs = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ORCHESTRATOR_SRC = path.join(
    __dirname,
    '../../src/modules/payments/services/payment-orchestrator.service.ts',
);
const NOTIFY_HANDLER_SRC = path.join(
    __dirname,
    '../../src/modules/notifications/services/customer-notification-event-handler.service.ts',
);
const NOTIFY_CONSUMER_SRC = path.join(
    __dirname,
    '../../src/modules/notifications/customer-notification-event-consumer.ts',
);

const screenCode = (): string => stripTs(fs.readFileSync(SCREEN_SRC, 'utf8'));
const chatCode = (): string => stripTs(fs.readFileSync(CHAT_SRC, 'utf8'));
const orchestratorCode = (): string => stripTs(fs.readFileSync(ORCHESTRATOR_SRC, 'utf8'));
const notifyHandlerCode = (): string => stripTs(fs.readFileSync(NOTIFY_HANDLER_SRC, 'utf8'));
const notifyConsumerCode = (): string => stripTs(fs.readFileSync(NOTIFY_CONSUMER_SRC, 'utf8'));

function main(): void {
    console.log('\n══ § 1 · The four things that keep a checkout handle safe ══');

    console.log('\n── 1 · A short life ──');

    /**
     * ⚠ Thirty minutes is right for a list somebody is still scrolling; it is far too long for
     * a credential that can place an order. A checkout is finished in minutes or abandoned.
     */
    assert('⛔ checkout lives 10 minutes, not 30', () => TTL_SECONDS.co === 600);

    assert('⛔ checkout is strictly the shortest-lived of the five', () =>
        (Object.keys(TTL_SECONDS) as (keyof typeof TTL_SECONDS)[])
            .filter((k) => k !== 'co')
            .every((k) => TTL_SECONDS[k] > TTL_SECONDS.co));

    console.log('\n── 2 · Single use on the write that places the order ──');

    /**
     * ⚠ **This mount has no `Idempotency-Key`** — `/api/bot/miniapp/*` is browser traffic and
     * a browser sends what the page sends, so the bot surface's mandatory-idempotency rule
     * cannot reach here. The store is the only guard there is.
     */
    assert('the store offers `consume`, which reads and deletes atomically', () =>
        typeof InAppSurfaceStore.prototype.consume === 'function');

    /**
     * ⚠ **`GETDEL` is NOT usable on this platform** — it landed in Redis 6.2 and the
     * development Redis here is 3.0, where it is an unknown command: a hard failure on the
     * first checkout, on a server that is otherwise fine. And it must never become a `get`
     * then a `del`: two concurrent submits would both see a live handle and both place an
     * order. `geo-candidate.store.ts` was bitten by exactly this once already.
     */
    assert('⛔ consumption is a Lua script — never GETDEL, never get-then-del', () => {
        const src = fs.readFileSync(STORE_SRC, 'utf8');
        /**
         * ⚠ Comments are stripped first, and that is not incidental: the store's own docstring
         * NAMES `GETDEL` in order to explain why it is unusable here. A scan that read the
         * explanation as the offence would fail on the very file that gets this right — which
         * is how a correct guard teaches somebody to delete the comment.
         */
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return code.includes('redis.call("get"')
            && code.includes('redis.call("del"')
            && !/GETDEL/i.test(code);
    });

    /**
     * ⚠ **Spent even when the caller then fails**, which is the safe direction: a customer who
     * loses a checkout re-taps and gets a fresh screen, whereas a handle that survived a
     * partial failure is a handle that can place the order twice.
     */
    assert('⛔ the page latches after ONE submit and offers no retry on it', () => {
        const c = code();
        return c.includes('if (placed) return;') && c.includes('placed = true;');
    });

    assert('⛔ a network failure after submit never claims the order was not placed', () =>
        code().includes('copy.failed') && !/not placed|was not placed/i.test(code()));

    console.log('\n── 3 · Nothing sensitive is projected in full ──');

    /**
     * ⚠ A `co` URL is forwardable. The address must be masked in the projection — the
     * `maskPhone` / `stripDeliveryCodes` precedent — and the mobile-money number never reaches
     * this page in full: it is the field's placeholder, and an empty field means "use the
     * number on my account".
     */
    assert('the page reads a masked phone and sends the field only when typed', () => {
        const c = code();
        return c.includes('phoneMasked') && c.includes('typed.length > 0 ? typed : null');
    });

    assert('the page renders the address the server sent and composes none of its own', () =>
        code().includes('data.address.text') && !code().includes('street') && !code().includes('postcode'));

    console.log('\n── 4 · The screen captures no address, and quotes no money of its own ──');

    /**
     * ⚠ Capturing an address here would drag `geo-candidate.store.ts`, `geo_search_address`
     * and the `gc_` picker into a WebView, and the chat already does it well with a map pin
     * and a candidate list. So "no saved address" is a real state with a real instruction.
     */
    assert('⛔ no saved address is a STATE with an instruction, not an error', () =>
        code().includes('copy.checkoutNoAddress'));

    assert('⛔ the screen has no address input of any kind', () => {
        const html = page().replace(/<!--[\s\S]*?-->/g, '');
        const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
        // Exactly one field, and it is the mobile-money number.
        return inputs.length === 1 && inputs[0].includes('type="tel"');
    });

    /**
     * ⚠ A WebView that computes a total is a second implementation of delivery fees, discounts
     * and the negotiated price lock, in the one place nothing tests. If a line and the total
     * disagree, the total is right — and it came from the server.
     */
    assert('⛔ the screen does no money arithmetic', () => {
        const c = code();
        return !c.includes('toFixed') && !c.includes('parseFloat') && !c.includes('Intl.NumberFormat');
    });

    console.log('\n── The result comes back in the CHAT ──');

    /**
     * ⚠ Neither a Mini App nor a WhatsApp Flow can hold a session open while somebody approves
     * a mobile-money push on their handset. The screen promises the answer in the thread and
     * closes; the chat delivers it, with Check-status and Try-again.
     */
    assert('the screen says the answer is coming to the chat, before the charge starts', () =>
        code().includes('copy.checkoutWatchChat'));

    assert('that message is on screen long enough to read before the page closes', () => {
        const m = code().match(/setTimeout\(function \(\) \{ if \(tg && tg\.close\)[\s\S]*?\}, (\d+)\)/);
        return m !== null && Number(m[1]) >= 2000;
    });

    console.log('\n── The frame ──');

    assert('the checkout page exists and is on the kind allowlist', () =>
        fs.existsSync(path.join(PUBLIC_DIR, 'co.html'))
        && (__SCREEN_KINDS as readonly string[]).includes('co'));

    assert('it links the shared stylesheet', () =>
        page().includes('/api/bot/miniapp/shell.css'));

    assert('every copy key it reads exists', () => {
        const known = Object.keys(__IN_APP_COPY);
        const used = [...new Set([...page().matchAll(/\bcopy\.([a-zA-Z]+)/g)].map((m) => m[1]))];
        const unknown = used.filter((k) => !known.includes(k));
        if (unknown.length > 0) console.error(`      co.html reads unknown keys: ${unknown.join(', ')}`);
        return unknown.length === 0;
    });

    assert('every checkout word resolves in all five languages', () =>
        BOT_COPY_LANGUAGES.every((lang) => {
            const c = inAppCopy(lang) as Record<string, string>;
            return ['checkoutHeading', 'checkoutTotal', 'checkoutAddress', 'checkoutNoAddress',
                'checkoutPhone', 'checkoutPay', 'checkoutWatchChat']
                .every((k) => typeof c[k] === 'string' && c[k].trim().length > 0);
        }));

    console.log('\n══ § 2 · Stream D\'s own assertions ══');

    console.log('\n── 5 · The write spends the handle, and spends it FIRST ──');

    /**
     * ⚠ **`consume` on the write, `read` on the page.** The page reads on every open and every
     * refresh; the one call that creates an order must not repeat. If this inverts, a refreshed
     * tab places a second order against the same basket and nothing anywhere notices — this
     * mount has no `Idempotency-Key`, because a browser sends what the page sends.
     */
    assert('⛔ `place` consumes the handle and `data` only reads it', () => {
        const src = screenCode();
        /**
         * ⚠ Bounded at the CLASS CLOSE, not at end-of-file. `readCheckout` is a module-level
         * helper below the class and it legitimately calls `read` — a slice running to the end
         * of the file swallows it and reports the handler as reading, which is how this
         * assertion failed the first time it ran against correct code.
         */
        const place = src.slice(src.indexOf('static place')).split(/\n\}\n/)[0];
        const data = src.slice(src.indexOf('static data'), src.indexOf('static place'));
        return place.includes("inAppSurfaceStore.consume('co'")
            && !place.includes('inAppSurfaceStore.read(')
            && data.includes('readCheckout(')
            && !data.includes('inAppSurfaceStore.consume(');
    });

    /**
     * ⚠ **The ORDER of these two lines is the whole guard.** Everything before `consume` is a
     * window in which two concurrent submits both see a live handle — so the basket read, the
     * customer read, the wallet lookup and the gateway choice all have to happen after it. A
     * refactor that hoists one "for clarity" re-opens the double-order race silently.
     */
    assert('⛔ the handle is spent BEFORE any order is created', () => {
        const src = screenCode();
        const spent = src.indexOf("inAppSurfaceStore.consume('co'");
        const placed = src.indexOf('createOrdersFromCart(');
        return spent > 0 && placed > spent;
    });

    /**
     * ⚠ **Both store calls name the kind.** `read`/`consume` refuse a mismatch, which is what
     * stops a `pl` handle — handed out freely in a chat, and forwardable — being replayed
     * against the one endpoint that can spend money. The check is by construction only for as
     * long as the literal is there.
     */
    assert('⛔ every store call on this screen names the `co` kind', () => {
        const calls = [...screenCode().matchAll(/inAppSurfaceStore\.(read|consume)\(([^,)]*)/g)];
        return calls.length >= 2 && calls.every((m) => m[2].trim() === "'co'");
    });

    console.log('\n── 6 · No prices are held, and the page is quoted no figure it computed ──');

    /**
     * ⚠ **A stored total is a total that can disagree with the basket by the time somebody
     * pays.** The `co` session carries an owner, a conversation and a cart id — nothing else.
     */
    assert('⛔ the minted checkout session holds a cartId and no money', () => {
        const src = chatCode();
        const mint = src.slice(src.indexOf("kind: 'co'"), src.indexOf("kind: 'co'") + 600);
        return mint.includes('cartId: cart.cartId')
            && !/\b(total|price|amount|subtotal)\s*:/i.test(mint);
    });

    /**
     * ⚠ **The total comes from `cartQuoteService`, the same service the storefront cart and
     * `cart_quote` call.** Summing the lines here would be a second implementation of delivery,
     * the vendor-absorbed fee, tax and discount — and it would be a *plausible-looking* one,
     * which is worse than an obviously missing one.
     */
    assert('⛔ the total is the quote service\'s figure, not a sum of the lines', () => {
        const src = screenCode();
        return src.includes('cartQuoteService.quoteForCustomer') && !src.includes('.reduce(');
    });

    /**
     * ⚠ Quoting WITH an address id makes `quoteForCustomer` validate it and throw — which would
     * turn the no-address state, a real state with a real instruction, into an error page.
     */
    assert('the quote is taken without an address, so no-address stays a STATE', () =>
        /quoteForCustomer\(\s*session\.customerId\s*\)/.test(screenCode()));

    console.log('\n── 7 · Mobile money is the only method, and the browser picks none of it ──');

    /**
     * ⚠ **A gateway name arriving from a browser is a caller choosing where a stranger's money
     * goes.** Every other entry point takes one from its caller because those callers are the
     * platform's own code; this one's caller is a web page.
     */
    assert('⛔ the gateway is chosen server-side and never read from the request', () => {
        const src = screenCode();
        return src.includes('mobileMoneyGateway()')
            && !/gateway\s*[:=][^;\n]*req\./.test(src)
            && !src.includes('STRIPE')
            && !src.includes('cardToken');
    });

    /**
     * ⚠ **NotchPay first is a REFUNDABILITY rule, not alphabetical order.** It is the gateway an
     * administrator can reverse a payment through; My-CoolPay has no refund API at all. The two
     * doors onto this charge must agree, or one basket gets two charges with different
     * reversibility depending on which door the customer came through.
     */
    assert('⛔ screen and chat prefer the same gateway, refundable one first', () => {
        const order = (src: string): boolean => {
            const notch = src.indexOf("'NOTCHPAY'");
            const cool = src.indexOf("'MYCOOLPAY'");
            return notch > 0 && cool > notch;
        };
        return order(screenCode()) && order(chatCode());
    });

    /** COD takes no payment and produces a delivery code; it does not come through this screen. */
    assert('⛔ the screen checks out ONLINE and never cash on delivery', () => {
        const src = screenCode();
        return /createOrdersFromCart\([\s\S]{0,120}'online'/.test(src)
            && !src.includes('cash_on_delivery');
    });

    console.log('\n── 8 · A forwarded URL reads out no address and no payable number ──');

    /**
     * ⚠ **This is protection 3, and it is the one a source scan cannot check.** A scan sees that
     * *something* was dropped; only driving the function shows *what*. A `co` URL is
     * forwardable, so what must not survive is the part that gets somebody to a door.
     */
    assert('⛔ the masked address drops the street line, the second line and the postcode', () => {
        const masked = maskAddress({
            label: 'Home',
            address_line1: '12 Rue Joss',
            address_line2: 'Apartment 4B',
            city: 'Douala',
            state: 'Littoral',
            country: 'CM',
            is_default: true,
            geo: {
                formatted_address: '12 Rue Joss, Akwa, Douala, Cameroon',
                components: { neighbourhood: 'Akwa', city: 'Douala', region: 'Littoral', postal_code: '1234' },
            },
        } as unknown as ICustomerSavedAddress);

        return masked.includes('Home')
            && masked.includes('Akwa')
            && !masked.includes('Rue Joss')
            && !masked.includes('12')
            && !masked.includes('Apartment')
            && !masked.includes('1234');
    });

    /** `Akwa, Akwa` reads as a bug in the address rather than as a coarse one. */
    assert('a repeated locality is not printed twice', () => {
        const masked = maskAddress({
            label: 'Home',
            address_line1: 'somewhere',
            address_line2: null,
            city: 'Akwa',
            state: null,
            country: 'CM',
            is_default: true,
            geo: { formatted_address: 'x', components: { neighbourhood: 'Akwa', city: 'akwa' } },
        } as unknown as ICustomerSavedAddress);
        return (masked.match(/kwa/gi) ?? []).length === 1;
    });

    /** With no locality at all it falls back to the LABEL, never to the street line. */
    assert('⛔ an ungeocoded-looking address falls back to the label, not the street', () => {
        const masked = maskAddress({
            label: 'Office',
            address_line1: '99 Secret Lane',
            address_line2: null,
            city: '',
            state: null,
            country: 'CM',
            is_default: true,
            geo: { formatted_address: 'x', components: {} },
        } as unknown as ICustomerSavedAddress);
        return masked === 'Office' && !masked.includes('Secret');
    });

    /**
     * ⚠ **A DIGITAL basket needs no delivery address, and must not be parked in the no-address
     * state** — a screen telling somebody to send an address for a download they will never be
     * carried. The identifier it shows instead is masked and language-free, so it needs no copy.
     */
    assert('⛔ a digital basket names the account, masked, with no new copy key', () => {
        
        const byEmail = accountIdentifier({ email: 'jean.dupont@example.com', name: 'Jean' } as ICustomer);
        const byPhone = accountIdentifier({ phone: '+237600124417', name: 'Jean' } as ICustomer);
        const byName = accountIdentifier({ name: 'Jean Dupont' } as ICustomer);

        return !byEmail.includes('jean.dupont')
            && byEmail.includes('@example.com')
            && !byPhone.includes('0012')
            && byPhone.includes('4417')
            && byName === 'Jean Dupont';
    });

    /**
     * ⚠ **The number the charge goes to is read through the REPOSITORY, never through
     * `paymentMethodService`** — that service projects to `PaymentMethodDto`, which omits both
     * gateway ids, and a saved wallet's number is unreadable through every API by design. It is
     * read here to charge and leaves the process only through `maskPhone`.
     */
    assert('⛔ the payable number is never published unmasked', () => {
        const src = screenCode();
        return src.includes('maskPhone(stored)')
            && !src.includes('paymentMethodService')
            && !/phoneMasked:\s*(stored|number|payerNumber)\b/.test(src);
    });

    console.log('\n── 9 · The payment\'s answer reaches the chat ──');

    /**
     * ⭐ **The silence this closes was the defect.** Every other checkout outcome said
     * something; a failed payment said nothing, so it was indistinguishable from a successful
     * one that had gone quiet — the customer waits for an order that is not coming.
     *
     * ⚠ **It needs a WhatsApp TEMPLATE, not just copy**, because it can fire outside the
     * 24-hour service window: the charge is approved on a handset minutes after the customer
     * last wrote to us, and free-form text is refused by Meta once that window shuts.
     */
    assert('⛔ `order.payment_failed` has a WhatsApp template', () =>
        customerWhatsAppTemplateName('order.payment_failed') === 'customer_order_payment_failed');

    assert('⛔ it is written in every supported language', () =>
        SUPPORTED_LANGUAGES.every((lang) => {
            const rendered = renderCustomerInApp('order.payment_failed', lang, {
                orderNumber: 'ORD-1', currency: 'XAF', amountFormatted: '20 000',
            });
            return rendered.title.trim().length > 0
                && rendered.message.trim().length > 0
                && !rendered.message.includes('{{');
        }));

    /**
     * ⚠ **Three copy rules, each load-bearing, and each checkable.** The English body is the
     * one they are stated against; a translation that broke one would need its own assertion,
     * which is what `assertCustomerCatalogComplete` and a human reviewer are for.
     *
     *   · it must NOT say cancelled — the basket survives and the charge is retryable, and
     *     announcing a cancellation destroys a recoverable sale;
     *   · it must NOT blame the customer — the common causes are an unapproved push prompt and
     *     a timeout, neither of which is a judgement on them;
     *   · it MUST say nothing was charged, because that is the customer's actual first question.
     */
    assert('the failure copy does not cancel the order, and blames nobody', () => {
        const body = renderCustomerInApp('order.payment_failed', 'en', {
            orderNumber: 'ORD-1', currency: 'XAF', amountFormatted: '20 000',
        }).message.toLowerCase();
        return !body.includes('cancel')
            && !body.includes('declined')
            && body.includes('nothing has been charged');
    });

    /**
     * ⚠ **A record is DATA for the model to narrate; only a fixed-wording turn carries a
     * sentence.** Writing "your payment went through" in the chat controller would put a second
     * opinion beside the notification catalogue's own copy for the same event, in a different
     * table — and the customer would eventually be told both. The screen door is the one
     * exception, because it renders a control.
     */
    assert('⛔ the money reads set no reply; only the screen door does', () => {
        const src = chatCode();
        const door = src.slice(src.indexOf('static screen'), src.indexOf('static paymentStatus'));
        const all = (src.match(/setBotReply\(/g) ?? []).length;
        const inDoor = (door.match(/setBotReply\(/g) ?? []).length;
        // Every reply in the file is inside the door, and the door sets at least one.
        return inDoor > 0 && all === inDoor;
    });

    /**
     * ⚠ **Never a dead button.** `inAppScreenUrl` answers null whenever the deployment has no
     * HTTPS in-app origin — which is TRUE IN PRODUCTION TODAY — so the storefront path is the
     * one that runs, and a third case with neither must clear the reply rather than render a
     * control with an empty target.
     */
    assert('⛔ the screen door degrades to the storefront, then to no button at all', () => {
        const src = chatCode();
        return src.includes("botStorefrontLink('/cart'")
            && /setBotReply\(req,\s*fallback\s*\?/.test(src);
    });

    /**
     * ⛔ **The origin is checked BEFORE the handle is minted, and for `co` that ordering is the
     * decision.** `BOT_MINIAPP_BASE_URL` is unset in production, so minting first means every
     * single checkout turn creates a ten-minute ORDER-PLACING credential that is handed to
     * nobody. Not a leak — nothing receives it and it expires — but it makes "how many live
     * checkout handles exist" a number that means nothing, and that is the number somebody
     * reaches for the first time this surface has an incident.
     *
     * ⚠ **Asked through `inAppBaseUrl()`, never a second read of the variable.** `inapp-url.ts`
     * is its single reader and holds BOTH rules that decide the answer — HTTPS (Telegram
     * refuses a `web_app` button on any other scheme, and refuses the whole message with it)
     * and publicly reachable. A local `process.env` check would pass on an origin the renderer
     * then rejects. Stream C calls the same function from its own minting paths.
     */
    assert('⛔ no checkout handle is minted when there is no screen to open', () => {
        const src = chatCode();
        const door = src.slice(src.indexOf('static screen'), src.indexOf('static paymentStatus'));
        const guard = door.indexOf('if (!inAppBaseUrl())');
        const mint = door.indexOf('inAppSurfaceStore.mint(');
        return guard > 0 && mint > guard && !src.includes('process.env.BOT_MINIAPP_BASE_URL');
    });

    /**
     * ⚠ **A digital basket changes the LABEL, not just the value.** Under "Deliver to", a masked
     * email reads as an address the shop has mangled; under `checkoutDigitalDelivery` the same
     * string answers the only question a download raises — WHICH account. The server flags it
     * because the page cannot tell a download from a parcel.
     */
    assert('⛔ a digital basket is not headed "Deliver to"', () => {
        const pageSrc = code();
        return pageSrc.includes('data.address.digital')
            && pageSrc.includes('copy.checkoutDigitalDelivery')
            && screenCode().includes('digital: true');
    });

    /**
     * ⚠ **The page's English table must cover EVERY key it reads.** `copy` is never null once
     * boot has run — a failed copy call falls back to this table — so a key added to the page
     * and not to the fallback produces `undefined` rendered as a label on exactly the request
     * that was already failing.
     */
    assert('⛔ the page\'s English fallback covers every key the page reads', () => {
        const pageSrc = page();
        const used = [...new Set([...pageSrc.matchAll(/\bcopy\.([a-zA-Z]+)/g)].map((m) => m[1]))];
        const fallback = pageSrc.slice(pageSrc.indexOf('var FALLBACK = {'), pageSrc.indexOf('function boot'));
        /**
         * ⚠ The declared keys are collected with ONE static pattern and compared as a SET,
         * rather than searched for per key. Two reasons, and the second is the one that bites:
         *
         *   - a per-key `new RegExp` is banned repo-wide (regex injection + ReDoS);
         *   - a substring check matches any LONGER key sharing the prefix — `retry` is inside
         *     `retryLater`, `checkoutPa` inside `checkoutPay` — so a key that is missing from
         *     the fallback reads as present because a different, longer one is there.
         *
         * ⚠ Appending a colon (`includes('retry:')`) narrows that one pair and does not fix the
         * class, and the colon-less form is what somebody actually writes. A Set comparison has
         * no such edge.
         *
         * ⚠ **Measured, not reasoned** — `'retryLater: "x"'.includes('retry')` is `true`. An
         * earlier version of this comment illustrated the trap with `retry` inside
         * `checkoutRetry`, which is FALSE: that key contains `Retry` with a capital R, so the
         * substring never matched. A wrong example in a correct guard's comment is worse than
         * no example, because the next reader verifies the comment, finds it false, and
         * distrusts the guard.
         */
        const declared = new Set([...fallback.matchAll(/^\s*([a-zA-Z]+)\s*:/gm)].map((m) => m[1]));
        const missing = used.filter((k) => !declared.has(k));
        if (missing.length > 0) console.error(`      FALLBACK is missing: ${missing.join(', ')}`);
        return missing.length === 0;
    });

    /**
     * ⚠ **A retry re-opens a CHARGE, never re-places an ORDER.** The orders from the failed
     * attempt still exist and are still awaiting payment — which is exactly why the failure copy
     * says the items are waiting. Placing a second set would double the basket and the stock
     * hold, and the customer would find out when asked to pay twice.
     */
    assert('⛔ the retry opens a charge and creates no second order', () => {
        const src = chatCode();
        const retry = src.slice(src.indexOf('static retryPayment'));
        return retry.includes('initiatePaymentForCart(')
            && !retry.includes('createOrdersFromCart(');
    });

    /**
     * ⚠ **One rule for which wallet is charged, imported rather than re-derived.** A second
     * implementation in the chat would mean the screen and the chat pushing the prompt to two
     * different handsets for one customer — discovered by them, while trying to pay.
     */
    assert('⛔ the chat and the screen resolve the payable number the same way', () =>
        chatCode().includes("import { storedPayerNumber } from '../miniapp/surfaces/checkout.controller'")
        && !chatCode().includes('gateway_customer_id'));

    console.log('\n── 10 · ⭐ The trigger — the silence at the moment the order is lost ──');

    /**
     * ⭐ **These five are the assertions that would have caught the original defect**, and the
     * defect was an ABSENCE: `PaymentOrchestratorService` published `payment.received.full` on
     * success and published nothing at all on FAILED or CANCELLED, so a refused mobile-money
     * push reached the customer as silence — indistinguishable from a payment that had worked
     * and gone quiet. The copy for it already existed in the catalogue with no trigger, which
     * is the hardest kind of gap to see: everything present looks correct.
     *
     * ⚠ A publisher with no subscriber, or a subscriber with no publisher, is the same silence
     * with a different shape. Both halves are pinned here for that reason.
     */
    assert('⛔ a dead payment PUBLISHES, on the webhook path and the verify path alike', () => {
        const src = orchestratorCode();
        const calls = (src.match(/await this\.handlePaymentFailure\(/g) ?? []).length;
        return src.includes("eventBus.publish('payment.failed'")
            && calls === 2
            && (src.match(/this\.isDeadStatus\([^)]*\) && !this\.isDeadStatus\(/g) ?? []).length === 2;
    });

    /**
     * ⚠ **The reconciliation sweep reaches the customer through `verifyPayment`**, which is why
     * that call site is not optional. `PaymentReconciliationWorker` closes a payment whose
     * callback never arrived by calling that method rather than the gateway directly — so the
     * customer whose failure is only discovered ten minutes later by the cron, who has been in
     * the dark longest, is told by the same line a client poll uses.
     */
    assert('⛔ the verify path publishes, so the reconciliation sweep reaches the customer', () => {
        const src = orchestratorCode();
        const verify = src.slice(src.indexOf('async verifyPayment'), src.indexOf('async applyWebhookEvent'));
        return verify.includes('this.handlePaymentFailure(');
    });

    /**
     * ⚠ **A local `FAILED` is NOT evidence of a failed payment**, and this is the assertion
     * that keeps somebody from "completing" the coverage by adding the obvious third call site.
     * `recordFailedAttempt` writes FAILED from the CATCH of the gateway call, which cannot tell
     * a refusal from a timeout — and a timeout means the charge may be live and the money may
     * be moving. `releaseDeadAttempt` is reached only from inside a NEW attempt, so a customer
     * pressing pay would be told their payment failed as they pressed it.
     */
    assert('⛔ a merely-locally-failed attempt tells the customer NOTHING', () => {
        const src = orchestratorCode();
        const span = (from: string, to: string): string =>
            src.slice(src.indexOf(from), to ? src.indexOf(to) : undefined);
        return !span('private async recordFailedAttempt', 'private async retireDeadAttempt')
            .includes('handlePaymentFailure')
            && !span('private async releaseDeadAttempt', 'private lastFailureWasRefused')
                .includes('handlePaymentFailure');
    });

    assert('⛔ the customer stack SUBSCRIBES to it', () =>
        notifyConsumerCode().includes(
            "eventBus.subscribe('payment.failed', handler.handleOrderPaymentFailed.bind(handler))",
        ));

    assert('the handler raises the situation the catalogue already has copy for', () => {
        const src = notifyHandlerCode();
        const handler = src.slice(src.indexOf('async handleOrderPaymentFailed'));
        return handler.includes("situation: 'order.payment_failed'")
            && handler.includes('idempotencyKey: `customer.order.payment_failed:${p.orderId}`');
    });

    /**
     * ⚠ **Money carries no preference key, and this is the strongest case for that rule on the
     * whole table.** A customer who muted "order updates" and then quietly lost an order to a
     * failed charge would have muted the one message that was never optional. `dispatch`
     * suppresses the entire notification — in-app record included — for a muted group, so an
     * entry added here would not degrade the message, it would delete it.
     */
    assert('⛔ no preference can silence a failed payment', () => {
        const src = notifyHandlerCode();
        const table = src.slice(src.indexOf('const SITUATION_PREFERENCE'), src.indexOf('};', src.indexOf('const SITUATION_PREFERENCE')));
        return !table.includes('order.payment_failed');
    });

    /**
     * ⚠ **The gateway's own `reason` is never relayed.** It is provider-sourced text that can
     * name the provider and its error codes, and the copy's second rule is that the message
     * blames nobody — a raw "insufficient funds" string breaks that in one word.
     */
    assert('⛔ the gateway\'s own failure text never reaches the customer', () => {
        const src = notifyHandlerCode();
        const handler = src.slice(
            src.indexOf('async handleOrderPaymentFailed'),
            src.indexOf('async handleOrderCancelled'),
        );
        return !handler.includes('reason') && !handler.includes('gatewayMessage');
    });

    console.log(
        failed === 0
            ? `\n✅ ${passed} passed, 0 failed`
            : `\n❌ ${passed} passed, ${failed} failed`,
    );
    process.exit(failed === 0 ? 0 : 1);
}

main();
