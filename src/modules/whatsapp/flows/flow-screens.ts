import { AppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { categoryFor, type ErrorCategory } from '../../../core/error-category';
import { customerMessageFor } from '../../bot-surface/domain/bot-error-copy';
import { inAppCopy } from '../../bot-surface/miniapp/inapp-copy';
import type { PurchaseContext, PurchaseResult } from '../../bot-surface/controllers/bot-purchase.controller';
import type { BookingConfirmed } from '../../bot-surface/miniapp/surfaces/booking.core';
import {
    bookingConfirmedResponse,
    toBookingDayScreen,
    toBookingListScreen,
    toBookingTimesScreen,
    type BookingDayView,
    type BookingTimesView,
} from './screens/booking.adapter';
import {
    BOOKING_DAY_SCREEN,
    BOOKING_TIMES_SCREEN,
} from './definitions/booking.flow';
import type { CheckoutPlaced, CheckoutView } from '../../bot-surface/miniapp/surfaces/checkout.controller';
import type { ImageSource } from '../../bot-surface/miniapp/surfaces/image-source';
import type { ProductDetailView } from '../../bot-surface/miniapp/surfaces/product-detail.read';
import type { ListingPage } from '../../bot-surface/miniapp/surfaces/product-listing.read';
import type { BotClaimResult, BotIdempotentResponse } from '../../bot-surface/services/bot-idempotency.store';
import type {
    InAppListingQuery,
    InAppSurfaceSession,
} from '../../bot-surface/services/inapp-surface.store';
import { CHECKOUT_SCREEN } from './definitions/checkout.flow';
import {
    PRODUCT_DETAIL_NO_IMAGE_SCREEN,
    PRODUCT_DETAIL_SCREEN,
} from './definitions/product-detail.flow';
import {
    FlowResponseBody,
    FlowScreenRequest,
    screenResponse,
    tokenUnusableBody,
} from './domain/flow-protocol';
import {
    handleSurvived,
    needsTypedNumber,
    placedResponse,
    planCheckoutFailure,
    reviewWithCorrection,
    toCheckoutScreen,
} from './screens/checkout.adapter';
import { toDetailScreen } from './screens/detail.adapter';
import type { FlowCopy } from './screens/flow-copy';
import { FLOW_LISTING_PAGE_SIZE, noticeResponse, toListingScreen } from './screens/listing.adapter';
import { FLOW_CAPS } from './screens/flow-text';

/**
 * Serving a screen: from a decrypted request to the answer that goes back encrypted.
 *
 * ── WHY THIS IS SEPARATE FROM THE CONTROLLER ────────────────────────────────
 * The controller owns the protocol: signature, cipher, status codes, the bare base64 body. This
 * file owns the product: which session, which read, which screen. Keeping them apart means the
 * routing can be tested against a request object with no cipher in the way, and the controller's
 * protocol rules can't be touched by somebody adding a screen.
 *
 * ── ONE READ, ONE SET OF RULES, TWO RENDERINGS ──────────────────────────────
 * Each screen's data comes from the SAME exported read its Telegram page uses:
 * `readListingPage` / `readProductDetail` (Stream B), `readCheckoutView` / `placeCheckout`
 * (Stream D) and `executePurchase` (Stream C). This module decides which one to call and
 * reshapes the answer through `screens/*.adapter.ts`. It never re-derives a price, a visibility
 * rule, a mask, a stock verdict or a purchase rung. A second copy of any of those is a second
 * set of rules that drifts from the first, on the channel nobody can open in a browser to compare.
 *
 * ── ⚠ WHY EVERY DEPENDENCY ARRIVES AS A PORT ────────────────────────────────
 * The checkout and purchase cores live in controller files that reach `orders/` and `payments/`,
 * and those do work at import that never returns under bare ts-node — a suite importing them
 * prints nothing at all. So this file imports only types from them, takes the real functions
 * through `FlowScreenPorts`, and `flow-screen-ports.ts` is the one place that wires the real
 * exports in. That is what lets `test:whatsapp-flows` drive every branch below with fakes, and a
 * source scan there pins that the ports ARE the real exports rather than look-alikes.
 *
 * ── WHICH FLOW IS ASKING ────────────────────────────────────────────────────
 * The only identifier a Flow sends is its token — the `ia_` handle. On `INIT` there is no screen
 * name either (Meta: "`screen` may not be populated"), so the handle's own KIND decides what to
 * draw: `read(kind, …)` refuses a mismatch by construction, so at most one of the three reads
 * answers. On `data_exchange` the screen names the form, and the handle is read AS that form's
 * kind — a listing handle submitted to the checkout form reads as absent.
 */

/**
 * The session kinds a WhatsApp form can open. `ol` and `sl` have no form; `bp` has a definition
 * but no read yet, so it is deliberately absent — see `openForm`.
 */
export type FlowSessionKind = 'pl' | 'pd' | 'co' | 'bl' | 'bk';

/** What `readBookingPicker` answers: the days, or one day's times — with the screens' words. */
export interface BookingPickerView {
    moving: string | null;
    copy: BookingDayView['copy'] & BookingTimesView['copy'];
    timezone: string;
    days?: BookingDayView['days'];
    date?: string;
    label?: string;
    slots?: BookingTimesView['slots'];
}
type SessionOf<K extends FlowSessionKind> = Extract<InAppSurfaceSession, { kind: K }>;

/** What one idempotency claim is scoped to. See `bot-idempotency.store.ts`. */
export interface FlowClaim {
    identity: string;
    key: string;
    fingerprint: string;
    tool: string;
}

/**
 * Everything this router reaches outside itself. Production wiring: `flow-screen-ports.ts`.
 *
 * ⚠ **Each member is the real export, passed through — never a wrapper with rules of its own.**
 * A port that "just adds" a check is a second copy of a rule, which is the thing this whole
 * design exists to prevent.
 */
export interface FlowScreenPorts {
    /** `inAppSurfaceStore.read` — kind-checked, repeatable, never consumes. */
    readSession<K extends FlowSessionKind>(kind: K, handle: string): Promise<SessionOf<K> | null>;
    /** `inAppSurfaceStore.touch` — which refuses `co` by its type. */
    extendSession(kind: 'pl' | 'pd', handle: string): Promise<unknown>;
    readListingPage(
        query: InAppListingQuery,
        options: { page?: number; pageSize?: number },
    ): Promise<ListingPage>;
    readProductDetail(productId: string, language: string | null): Promise<ProductDetailView>;
    /** `loadFlowImage` — refuses anything not `public` BEFORE reading a byte. */
    loadImage(image: ImageSource | null): Promise<string | null>;
    readCheckoutView(handle: string): Promise<CheckoutView>;
    placeCheckout(handle: string, phone: unknown): Promise<CheckoutPlaced>;
    executePurchase(ctx: PurchaseContext): Promise<PurchaseResult>;
    /**
     * `readBookingPicker` — one read for both booking screens. It resolves the `bk` session
     * ITSELF and carries the screens' own words, so this side holds no booking strings and no
     * second opinion about which days have times.
     */
    readBookingPicker(handle: string, input?: { date?: string | null }): Promise<BookingPickerView>;
    /** `confirmBooking` — consumes the `bk` handle itself; one handle, one appointment. */
    confirmBooking(handle: string, input: { slotId: string }): Promise<BookingConfirmed>;
    readCustomerBookings(input: {
        userId: string;
        language?: string | null;
        limit?: number;
    }): Promise<{ bookings: Array<{ bookingId: string; title: string; description: string }> }>;
    /** `bookingScreenCopy` / the chat acknowledgement — the one booking vocabulary. */
    bookingWords(language: string | null): { listTitle: string; listEmpty: string };
    bookingReceipt(confirmed: BookingConfirmed, language: string | null): string;
    /** `botIdempotencyStore` — atomic claim, stored answer replayed, released to retry. */
    claims: {
        claim(input: FlowClaim): Promise<BotClaimResult>;
        complete(input: FlowClaim & { response: BotIdempotentResponse }): Promise<void>;
        release(identity: string, key: string): Promise<void>;
    };
    /** A fresh random reference for one open of the product form. */
    newOpenRef(): string;
    sleep(ms: number): Promise<void>;
    /**
     * Count and log a failure this router answered for, instead of letting it reach the global
     * handler.
     *
     * ⚠ **Answering a failure politely is not the same as swallowing it.** The global handler
     * records every error it sees (a metric and a structured log line); a failure turned into a
     * customer sentence here never reaches it, so this is how it still gets counted.
     */
    reportFailure(where: string, error: unknown): void;
}

export type FlowScreenVerdict =
    | { status: 200; body: FlowResponseBody }
    /**
     * ⚠ **427 carries an encrypted `{ error_msg }` body, and the handset shows it.** Meta's
     * reference endpoint does exactly this. Without it the Flow ends on a blank failure the
     * customer can't act on.
     */
    | { status: 427; body: Record<string, unknown> };

/**
 * The 427 answer: this form's handle is spent, lapsed, or points at something that has gone.
 *
 * ⚠ **English when the session is gone, and that is a known limit rather than an oversight.**
 * The customer's language lives on the session, and the session is exactly what an unusable
 * token has lost. The Telegram page gets around this by carrying `?lang=` in its URL; a Flow's
 * only identifier is the token itself. When a live session IS available, its language is passed.
 */
export function tokenUnusable(language: string | null): FlowScreenVerdict {
    return { status: 427, body: tokenUnusableBody(inAppCopy(language).expired) };
}

/**
 * The form's words, in one language — straight from the five-language table the Telegram pages
 * read, so a French customer gets the same French on both channels.
 */
export function flowCopyFor(language: string | null): FlowCopy {
    return inAppCopy(language);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tuning — each number is a bound, with its reason
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a press waits for an earlier identical press to finish before saying "still working".
 *
 * ⚠ **Inside Meta's exchange timeout, with room for the work.** WhatsApp gives the endpoint about
 * ten seconds. Four waits of 750 ms is three seconds — long enough for a cart add or a placed
 * checkout to land and be replayed, short enough that the waiting press still answers in time.
 */
export const CLAIM_WAITS = 4;
export const CLAIM_WAIT_MS = 750;

/** The idempotency `tool` names, so a stored answer says which door wrote it. */
export const FLOW_DETAIL_TOOL = 'whatsapp_flow_product_detail';
export const FLOW_CHECKOUT_TOOL = 'whatsapp_flow_checkout';
export const FLOW_BOOKING_TOOL = 'whatsapp_flow_booking';

/**
 * The claim scope for a checkout press.
 *
 * ⚠ **Not the customer, and that is forced rather than chosen.** A retry of a Pay press that
 * already went through arrives AFTER the handle was consumed, so there is no session left to read
 * a customer from — and that retry is exactly the one that must be answered from the store. The
 * handle itself (128 random bits, in the key) is what makes the record one customer's.
 */
export const CHECKOUT_CLAIM_IDENTITY = 'wa-flow:checkout';

// ─────────────────────────────────────────────────────────────────────────────
//  The router
// ─────────────────────────────────────────────────────────────────────────────

export async function serveFlowScreen(
    request: FlowScreenRequest,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    const handle = request.flowToken;
    if (!handle) return tokenUnusable(null);

    if (request.action === 'data_exchange') {
        if (request.screen === PRODUCT_DETAIL_SCREEN || request.screen === PRODUCT_DETAIL_NO_IMAGE_SCREEN) {
            return submitProduct(handle, request.screen, request.data, ports);
        }
        if (request.screen === CHECKOUT_SCREEN) {
            return submitCheckout(handle, request.data, ports);
        }
        if (request.screen === BOOKING_DAY_SCREEN) {
            return chooseBookingDay(handle, request.data, ports);
        }
        if (request.screen === BOOKING_TIMES_SCREEN) {
            return confirmBookingTime(handle, request.data, ports);
        }
        // No definition sends an exchange from any other screen — the listing CLOSES on a choice.
        console.warn(`[WhatsAppFlows] data_exchange from screen '${request.screen ?? '(none)'}', which no form sends`);
        return tokenUnusable(null);
    }

    /**
     * `BACK` is drawn like `INIT`. None of the three definitions sets `refresh_on_back`, so Meta
     * should never send it; if a later definition does, redrawing the form is the honest answer.
     */
    if (request.action === 'INIT' || request.action === 'BACK') {
        return openForm(handle, ports);
    }

    console.warn(`[WhatsAppFlows] unknown screen action '${request.action}'`);
    return tokenUnusable(null);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Opening a form — reads only, nothing written but a session's life
// ─────────────────────────────────────────────────────────────────────────────

async function openForm(handle: string, ports: FlowScreenPorts): Promise<FlowScreenVerdict> {
    try {
        const listing = await ports.readSession('pl', handle);
        if (listing) return await drawListing(handle, listing, ports);

        const product = await ports.readSession('pd', handle);
        if (product) return await drawProduct(handle, product, ports);

        const checkout = await ports.readSession('co', handle);
        if (checkout) return await drawCheckout(handle, checkout, ports);

        const bookings = await ports.readSession('bl', handle);
        if (bookings) return await drawBookingList(bookings, ports);

        const picker = await ports.readSession('bk', handle);
        if (picker) return await drawBookingDays(handle, picker, ports);
    } catch (error) {
        return readFailed('open', error, null, ports);
    }
    /**
     * ⚠ **A `bp` handle lands here and is refused, deliberately.** Its definition exists and its
     * screen kind does, but nothing reads a booking's outstanding amount yet — and a payment
     * screen that cannot re-resolve what is owed is the one screen that must not be guessed at.
     * When that read lands this becomes a branch like the others.
     */
    return tokenUnusable(null);
}

async function drawBookingList(
    session: SessionOf<'bl'>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    try {
        const { bookings } = await ports.readCustomerBookings({
            userId: session.owner,
            language: session.language,
            limit: FLOW_CAPS.radioOptions,
        });
        return {
            status: 200,
            body: toBookingListScreen(
                bookings,
                ports.bookingWords(session.language),
                flowCopyFor(session.language),
            ),
        };
    } catch (error) {
        return readFailed('open bl', error, session.language, ports);
    }
}

/**
 * The day screen.
 *
 * ⚠ **`readBookingPicker` resolves the `bk` session itself**, so the handle is read twice on this
 * path — once here to learn the kind, once inside the read. That is deliberate: the read owning
 * its own session is what lets the Telegram page and this form be served by one function, and a
 * second Redis read costs less than a second opinion about what the session says.
 */
async function drawBookingDays(
    handle: string,
    session: SessionOf<'bk'>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    try {
        const picker = await ports.readBookingPicker(handle);
        return {
            status: 200,
            body: toBookingDayScreen(
                { moving: picker.moving, copy: picker.copy, days: picker.days ?? [] },
                flowCopyFor(session.language),
            ),
        };
    } catch (error) {
        return readFailed('open bk', error, session.language, ports);
    }
}

async function drawListing(
    handle: string,
    session: SessionOf<'pl'>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    try {
        /**
         * ⚠ **Page one of 20, and the 20 is this caller's to pass.** `readListingPage` clamps to
         * the catalogue's 1–100 and defaults to 24, which would overflow a `RadioButtonsGroup`.
         */
        const page = await ports.readListingPage(session.query, { page: 1, pageSize: FLOW_LISTING_PAGE_SIZE });
        keepAlive('pl', handle, ports);
        return { status: 200, body: toListingScreen(page, flowCopyFor(session.language)) };
    } catch (error) {
        return readFailed('open pl', error, session.language, ports);
    }
}

async function drawProduct(
    handle: string,
    session: SessionOf<'pd'>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    try {
        const body = await productBody(session, ports, ports.newOpenRef());
        keepAlive('pd', handle, ports);
        return { status: 200, body };
    } catch (error) {
        return readFailed('open pd', error, session.language, ports);
    }
}

/**
 * The product screen for one open.
 *
 * ⚠ **The product id comes from the SESSION.** The form sends a variant and nothing else, so a
 * form cannot buy — or even draw — a product its handle was not opened for.
 */
async function productBody(
    session: SessionOf<'pd'>,
    ports: FlowScreenPorts,
    openRef: string,
): Promise<FlowResponseBody> {
    const view = await ports.readProductDetail(session.productId, session.language);
    /** The picture is a decoration; a failure costs the photo and never the screen. */
    const image = await ports.loadImage(view.image).catch(() => null);
    return toDetailScreen(view, flowCopyFor(session.language), image, openRef);
}

async function drawCheckout(
    handle: string,
    session: SessionOf<'co'>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    try {
        const view = await ports.readCheckoutView(handle);
        return { status: 200, body: toCheckoutScreen(view, flowCopyFor(view.language)) };
    } catch (error) {
        return readFailed('open co', error, session.language, ports);
    }
}

/**
 * Extend a browsing session while somebody is looking at it — the Telegram pages do the same on
 * every read.
 *
 * ⚠ **Here, and deliberately NOT inside the shared reads**, which must never extend a session as
 * a side effect of fetching data. Never `co`: `touch` refuses it by type, because a checkout
 * credential must not slide. Fire-and-forget: a failed extension costs a re-tap much later, and
 * failing this screen over it would cost the screen now.
 */
function keepAlive(kind: 'pl' | 'pd', handle: string, ports: FlowScreenPorts): void {
    void Promise.resolve()
        .then(() => ports.extendSession(kind, handle))
        .catch(() => undefined);
}

/**
 * A read that failed.
 *
 * ⚠ **404 and 410 mean the thing the handle pointed at has gone** — a product taken off sale, a
 * basket emptied or replaced — which is the handle being unusable, so it gets the 427 and the
 * "ask me again" sentence, in the session's language where there is one. Anything else is ours:
 * counted, and answered with the form's own "something went wrong, ask me in the chat".
 */
function readFailed(
    where: string,
    error: unknown,
    language: string | null,
    ports: FlowScreenPorts,
): FlowScreenVerdict {
    if (error instanceof AppError && (error.statusCode === 404 || error.statusCode === 410)) {
        return tokenUnusable(language);
    }
    ports.reportFailure(where, error);
    const copy = flowCopyFor(language);
    return { status: 200, body: noticeResponse(copy.failed, copy) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The product form's button — a write, through the purchase core
// ─────────────────────────────────────────────────────────────────────────────

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const OPEN_REF = /^[A-Za-z0-9_-]{8,64}$/;

const stringMatching = (value: unknown, pattern: RegExp): string | null =>
    typeof value === 'string' && pattern.test(value) ? value : null;

/**
 * The product form's footer: Bargain · Add to cart · Buy now · Book.
 *
 * ── ⚠ THE SAME `executePurchase` THE CHAT BUTTON AND THE TELEGRAM SCREEN RUN ─
 * It re-resolves the rung from the product and the variant itself, so nothing the form sends can
 * choose a verb, and the form sends none. `productId` is the SESSION's.
 *
 * ── ⚠ THE CLAIM IS THIS DOOR'S, BECAUSE THIS DOOR IS THE ONE THAT RETRIES ───
 * `executePurchase` deliberately takes no idempotency key: the chat route already has one and the
 * Telegram screen repeats only when a human double-taps. WhatsApp resends an exchange on its own,
 * and the cart ADDS rather than sets, so without a claim a retry doubles the line. So:
 *   - scope: the session's owner; key: handle + this open's `openRef` + the variant;
 *   - a success is STORED and a retry of the same open replays it without adding again;
 *   - a refusal is RELEASED, so pressing again after changing variant (or after stock returns)
 *     runs again — the Telegram page's "change variant and press again";
 *   - a press arriving while an identical one is still running waits briefly for its answer.
 * A LATER open draws a new `openRef`, so the same variant added again then is a second add — as
 * two presses on the Telegram page are.
 */
async function submitProduct(
    handle: string,
    screenId: string,
    data: Record<string, unknown>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    let session: SessionOf<'pd'> | null;
    try {
        session = await ports.readSession('pd', handle);
    } catch (error) {
        return readFailed('submit pd', error, null, ports);
    }
    if (!session) return tokenUnusable(null);

    const language = session.language;
    const copy = flowCopyFor(language);

    const variantId = stringMatching(data.variantId, OBJECT_ID);
    const openRef = stringMatching(data.openRef, OPEN_REF);
    if (!variantId || !openRef) {
        // The drop-down is required and the reference is ours, so a real handset cannot send
        // this. Answered, not guessed at: a missing variant must never fall back to a default.
        console.warn('[WhatsAppFlows] product form submitted without a variant or its open reference');
        return { status: 200, body: noticeResponse(copy.failed, copy) };
    }

    const claim: FlowClaim = {
        identity: session.owner,
        key: `wa-flow:pd:${handle}:${openRef}:${variantId}`,
        fingerprint: `pd:${session.productId}:${variantId}`,
        tool: FLOW_DETAIL_TOOL,
    };

    const gate = await claimOrWait(claim, ports);
    if (gate.status !== 'claimed') return answerFromGate(gate, language, ports);

    let result: PurchaseResult;
    try {
        result = await ports.executePurchase({
            userId: session.owner,
            customerId: session.customerId,
            channel: session.channel,
            externalId: session.externalId,
            language,
            productId: session.productId,
            variantId,
        });
    } catch (error) {
        await settle(ports, () => ports.claims.release(claim.identity, claim.key));
        return refusedPurchase(error, session, screenId, openRef, ports);
    }

    /**
     * ⚠ **`message` is shown and `url` is ignored.** A `checkout` outcome's url is a Telegram
     * SCREEN address, meaningless inside WhatsApp. `bargain` and `book` write nothing; their
     * message is the question the customer answers in the chat, which is what wakes the agent.
     *
     * ⚠ **And the closing screen STAMPS which of those it was**, because on WhatsApp this screen
     * is the last thing the customer sees: it closes and the thread is empty. `asked` tells the
     * chat to carry the question into the conversation — where it can still be answered — and
     * `added` tells it to offer the three controls a chat-tap "added to cart" offers. See
     * `domain/flow-outcome.ts`.
     */
    const verdict: FlowScreenVerdict = {
        status: 200,
        body: noticeResponse(result.message, copy, result.outcome === 'chat' ? 'asked' : 'added'),
    };
    await settle(ports, () => ports.claims.complete({ ...claim, response: verdict }));
    return verdict;
}

/**
 * A purchase refusal.
 *
 * ⚠ **A refusal the customer can act on keeps them on the form**, redrawn from a fresh read, with
 * the refusal as Meta's snackbar — so a variant that sold out between the drawing and the press
 * now shows disabled, and they can pick another. Same `openRef`: it is still the same open.
 * The sentence is `customerMessageFor`, the table every bot door speaks from, in their language.
 *
 * ⚠ **The redraw must land on the SAME screen.** `PRODUCT` → `PRODUCT_NO_IMAGE` is not a declared
 * route, so if the picture no longer loads (or nothing is buyable any more) the refusal is shown
 * on the notice screen instead of risking a transition the handset refuses.
 */
async function refusedPurchase(
    error: unknown,
    session: SessionOf<'pd'>,
    screenId: string,
    openRef: string,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    const language = session.language;
    const copy = flowCopyFor(language);

    if (!(error instanceof AppError)) {
        ports.reportFailure('submit pd', error);
        return { status: 200, body: noticeResponse(copy.failed, copy) };
    }
    if (error.statusCode === 404 || error.statusCode === 410) return tokenUnusable(language);

    const sentence = customerMessageFor(error.code, error.category, language);
    if (error.statusCode >= 500) {
        ports.reportFailure('submit pd', error);
        return { status: 200, body: noticeResponse(sentence, copy) };
    }

    try {
        const again = await productBody(session, ports, openRef);
        if (again.screen === screenId) {
            return { status: 200, body: screenResponse(again.screen, again.data, sentence) };
        }
    } catch {
        // The redraw is a courtesy. The refusal is still the answer.
    }
    return { status: 200, body: noticeResponse(sentence, copy) };
}

// ─────────────────────────────────────────────────────────────────────────────
//  The checkout form's Pay button — the one press that costs money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pay.
 *
 * ── ⛔ WHAT CANNOT HAPPEN, WHATEVER THE TIMING: A SECOND ORDER ──────────────
 * Two guards, and they answer different questions:
 *   1. **`placeCheckout` consumes the handle atomically before anything slow.** That alone makes a
 *      second placement impossible — every later press finds the handle gone.
 *   2. **The claim, taken BEFORE that consume, decides what a later press is TOLD.** Without it a
 *      retry of a Pay that went through (WhatsApp resends a slow exchange; a customer presses again
 *      after a timeout) would meet a spent handle and be told "no longer available, ask me again"
 *      — an invitation to order a second time. With it, the retry is answered with the first
 *      press's own outcome, replayed from the store and never re-executed.
 *
 * ── WHICH OUTCOMES ARE STORED, AND WHICH RELEASED ───────────────────────────
 *   - **Every outcome reached after the spend is STORED** — success ("approve it on your phone")
 *     and every failure alike, because once the handle is spent pressing again cannot change
 *     anything, and the honest answer to a repeat is the first answer.
 *   - **A refusal that provably happened before the spend is RELEASED** (`handleSurvived`, the one
 *     reading of `details.spent === false`) — a mistyped number, no number on file. Storing those
 *     would replay "fix your number" forever at a customer who has fixed it. Releasing is safe
 *     because nothing was placed and guard 1 still stands.
 * The stored answer lives 24 hours (`BOT_IDEMPOTENCY_RECORD_TTL_SECONDS`), far past the handle's
 * ten minutes. The in-flight claim lives 60 seconds; a press outliving it finds the handle spent,
 * which is guard 1's job.
 */
async function submitCheckout(
    handle: string,
    data: Record<string, unknown>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    /**
     * Read first — `read`, never `consume` — only for the language and to know whether there is a
     * live checkout at all. A replayed press arrives with the handle already spent, so a null here
     * is decided AFTER the claim, never before it.
     */
    let session: SessionOf<'co'> | null;
    try {
        session = await ports.readSession('co', handle);
    } catch (error) {
        return readFailed('submit co', error, null, ports);
    }
    const language = session?.language ?? null;

    const claim: FlowClaim = {
        identity: CHECKOUT_CLAIM_IDENTITY,
        key: `wa-flow:co:${handle}`,
        fingerprint: 'co:place',
        tool: FLOW_CHECKOUT_TOOL,
    };

    const gate = await claimOrWait(claim, ports);
    if (gate.status !== 'claimed') return answerFromGate(gate, language, ports);

    const release = (): Promise<void> =>
        settle(ports, () => ports.claims.release(claim.identity, claim.key));

    if (!session) {
        await release();
        return tokenUnusable(null);
    }
    const copy = flowCopyFor(language);

    let view: CheckoutView;
    try {
        view = await ports.readCheckoutView(handle);
    } catch (error) {
        await release();
        return readFailed('submit co', error, language, ports);
    }

    /**
     * ⚠ **No number on file and the field left empty: refused HERE, before the spend.** Meta
     * documents no dynamic `required`, so the form cannot disable Pay the way the page does, and
     * `placeCheckout` can only discover this AFTER consuming the handle.
     */
    if (needsTypedNumber(view, data.phone)) {
        await release();
        return {
            status: 200,
            body: reviewWithCorrection(
                view,
                copy,
                customerMessageFor(
                    ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED,
                    categoryFor(ERROR_CODES.PAYMENT_PAYER_NUMBER_REQUIRED, 422),
                    language,
                ),
            ),
        };
    }

    let verdict: FlowScreenVerdict;
    let spent: boolean;
    try {
        const placed = await ports.placeCheckout(handle, data.phone);
        verdict = { status: 200, body: placedResponse(placed, copy) };
        spent = true;
    } catch (error) {
        spent = !handleSurvived(error);
        verdict = checkoutRefused(error, view, copy, language, ports);
    }

    await settle(ports, () => (spent
        ? ports.claims.complete({ ...claim, response: verdict })
        : ports.claims.release(claim.identity, claim.key)));
    return verdict;
}

/**
 * What a `placeCheckout` refusal is answered with. The decision is `planCheckoutFailure`'s — pure
 * and asserted row by row; this only turns the plan into a screen.
 */
function checkoutRefused(
    error: unknown,
    view: CheckoutView,
    copy: FlowCopy,
    language: string | null,
    ports: FlowScreenPorts,
): FlowScreenVerdict {
    const plan = planCheckoutFailure(error);

    switch (plan.kind) {
        case 'stay': {
            /**
             * ⚠ **A refusal about the phone field is answered with the field's own instruction**
             * ("leave it empty for your account's number, or include the country code"). The two
             * codes it can be have no sentence of their own, and their category sentences —
             * "that does not look right", "that is not possible right now" — do not say which
             * box to fix.
             */
            const aboutPhone = (error as { details?: { field?: unknown } }).details?.field === 'phone';
            return {
                status: 200,
                body: reviewWithCorrection(
                    view,
                    copy,
                    aboutPhone
                        ? copy.flowPhoneHint
                        // The plan carries the error's own derived category. A value outside the
                        // taxonomy cannot reach a customer as-is: the lookup falls back to the
                        // generic sentence.
                        : customerMessageFor(plan.code, plan.category as ErrorCategory, language),
                ),
            };
        }
        case 'restart':
            return tokenUnusable(language);
        case 'unavailable':
        case 'ask_chat':
            /**
             * ⛔ `failed` — "look in the chat". Never `checkoutWatchChat`: after a 502 no payment
             * prompt is coming, so "approve it on your phone" would be false.
             */
            ports.reportFailure('submit co', error);
            return { status: 200, body: noticeResponse(copy.failed, copy) };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The booking form's two presses
// ─────────────────────────────────────────────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** A slot handle is the read's own opaque string; bounded, never parsed. */
const SLOT_ID = /^[\w:.-]{1,128}$/;

/**
 * "See times" — the day is chosen, the same read answers again with that day's times.
 *
 * ⚠ **A read, not a write**, so no claim: nothing is held, nothing is spent, and pressing twice
 * costs a second look at the same availability.
 */
async function chooseBookingDay(
    handle: string,
    data: Record<string, unknown>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    let session: SessionOf<'bk'> | null;
    try {
        session = await ports.readSession('bk', handle);
    } catch (error) {
        return readFailed('submit bk', error, null, ports);
    }
    if (!session) return tokenUnusable(null);

    const copy = flowCopyFor(session.language);
    const date = stringMatching(data.day, DAY_KEY);
    if (!date) {
        console.warn('[WhatsAppFlows] a booking day was submitted without a day');
        return { status: 200, body: noticeResponse(copy.failed, copy) };
    }

    try {
        const picker = await ports.readBookingPicker(handle, { date });
        return {
            status: 200,
            body: toBookingTimesScreen(
                { copy: picker.copy, label: picker.label, slots: picker.slots ?? [] },
                copy,
            ),
        };
    } catch (error) {
        return readFailed('submit bk', error, session.language, ports);
    }
}

/**
 * "Confirm" — the appointment is made, or moved.
 *
 * ── ⛔ TWO GUARDS, THE SAME SPLIT THE CHECKOUT ARRIVED AT ───────────────────
 *   1. **`confirmBooking` consumes the `bk` handle itself**, so a second press cannot make a
 *      second appointment, whatever the timing.
 *   2. **The claim, taken BEFORE that consume, decides what a second press is TOLD.** Without it
 *      a retry of a confirm that went through — WhatsApp resends a slow exchange, a customer
 *      presses again after a timeout — would meet a spent handle and be told to start again,
 *      which is how somebody books twice out of politeness to a form.
 * Every outcome after the consume is stored and replayed; a refusal BEFORE it releases, so the
 * customer can pick another time when the one they chose was taken a moment earlier.
 *
 * ⚠ **The screen shows the full receipt and the chat will not.** Here the session is provably
 * this customer's; by the time the chat speaks it is gone. See `screens/booking.adapter.ts`.
 */
async function confirmBookingTime(
    handle: string,
    data: Record<string, unknown>,
    ports: FlowScreenPorts,
): Promise<FlowScreenVerdict> {
    let session: SessionOf<'bk'> | null;
    try {
        session = await ports.readSession('bk', handle);
    } catch (error) {
        return readFailed('confirm bk', error, null, ports);
    }
    const language = session?.language ?? null;
    const copy = flowCopyFor(language);

    const slotId = stringMatching(data.slot, SLOT_ID);
    if (!slotId) {
        console.warn('[WhatsAppFlows] a booking was confirmed without a slot');
        return { status: 200, body: noticeResponse(copy.failed, copy) };
    }

    const claim: FlowClaim = {
        identity: CHECKOUT_CLAIM_IDENTITY,
        key: `wa-flow:bk:${handle}:${slotId}`,
        fingerprint: `bk:${slotId}`,
        tool: FLOW_BOOKING_TOOL,
    };

    const gate = await claimOrWait(claim, ports);
    if (gate.status !== 'claimed') return answerFromGate(gate, language, ports);

    const release = (): Promise<void> =>
        settle(ports, () => ports.claims.release(claim.identity, claim.key));

    if (!session) {
        await release();
        return tokenUnusable(null);
    }

    let verdict: FlowScreenVerdict;
    let spent: boolean;
    try {
        const confirmed = await ports.confirmBooking(handle, { slotId });
        verdict = {
            status: 200,
            body: bookingConfirmedResponse(confirmed, ports.bookingReceipt(confirmed, language), copy),
        };
        spent = true;
    } catch (error) {
        /**
         * ⚠ **A refusal here is almost always "somebody took that time first"**, and the handle
         * survives it — `confirmBooking` consumes before it holds the slot, so a 409 arrives with
         * the session already gone. Treated as spent for that reason: the customer cannot press
         * again on this form and must reopen it, which is what the notice says.
         */
        spent = !handleSurvived(error);
        verdict = readFailed('confirm bk', error, language, ports);
    }

    await settle(ports, () => (spent
        ? ports.claims.complete({ ...claim, response: verdict })
        : ports.claims.release(claim.identity, claim.key)));
    return verdict;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The claim
// ─────────────────────────────────────────────────────────────────────────────

type Gate = BotClaimResult | { status: 'unavailable' };

/**
 * Claim, or wait a moment for an identical press already running.
 *
 * ⚠ **A store that cannot be reached FAILS CLOSED** — nothing is bought or placed without the
 * guard. That is the bot surface's own posture (`BOT_IDEMPOTENCY_STORE_UNAVAILABLE`), and the
 * session store is the same Redis database, so in practice the session read fails first.
 */
async function claimOrWait(claim: FlowClaim, ports: FlowScreenPorts): Promise<Gate> {
    for (let waited = 0; ; waited += 1) {
        let result: BotClaimResult;
        try {
            result = await ports.claims.claim(claim);
        } catch (error) {
            ports.reportFailure('claim', error);
            return { status: 'unavailable' };
        }
        if (result.status !== 'in_progress' || waited >= CLAIM_WAITS) return result;
        await ports.sleep(CLAIM_WAIT_MS);
    }
}

/** Every gate outcome other than `claimed`. */
function answerFromGate(
    gate: Exclude<Gate, { status: 'claimed' }>,
    language: string | null,
    ports: FlowScreenPorts,
): FlowScreenVerdict {
    const copy = flowCopyFor(language);
    const say = (code: string, status: number): FlowScreenVerdict => ({
        status: 200,
        body: noticeResponse(customerMessageFor(code, categoryFor(code, status), language), copy),
    });

    switch (gate.status) {
        case 'replay':
            return replayed(gate.response, copy, ports);
        /** The statuses the bot surface raises these two codes at, so each keeps one category. */
        case 'in_progress':
            return say(ERROR_CODES.BOT_IDEMPOTENCY_IN_PROGRESS, 409);
        case 'unavailable':
            return say(ERROR_CODES.BOT_IDEMPOTENCY_STORE_UNAVAILABLE, 503);
        case 'reused':
            // A key built from the handle and the variant cannot meet a different fingerprint
            // unless the handle's product changed under it — our bug, never a customer's.
            ports.reportFailure('claim', `idempotency key reused by ${gate.tool}`);
            return { status: 200, body: noticeResponse(copy.failed, copy) };
    }
}

/**
 * A stored answer, replayed exactly. Checked for shape first: it is our own write, but a record we
 * cannot read is answered with "look in the chat", never passed to the cipher as-is.
 */
function replayed(
    response: BotIdempotentResponse,
    copy: FlowCopy,
    ports: FlowScreenPorts,
): FlowScreenVerdict {
    const body = response.body as Record<string, unknown> | null;
    if (response.status === 200 && typeof body?.screen === 'string'
        && typeof body.data === 'object' && body.data !== null) {
        return { status: 200, body: body as unknown as FlowResponseBody };
    }
    if (response.status === 427 && typeof body?.error_msg === 'string') {
        return { status: 427, body: body as Record<string, unknown> };
    }
    ports.reportFailure('replay', 'a stored WhatsApp form answer has an unreadable shape');
    return { status: 200, body: noticeResponse(copy.failed, copy) };
}

/**
 * Store or release a claim after the answer is decided.
 *
 * ⚠ **Never fails the answer.** The work is done; failing to record it costs, at worst, a claim
 * that lapses in 60 seconds — whereas throwing here would lose the customer a result that is true.
 */
async function settle(ports: FlowScreenPorts, write: () => Promise<void>): Promise<void> {
    try {
        await write();
    } catch (error) {
        ports.reportFailure('claim settle', error);
    }
}
