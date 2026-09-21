import { Router } from 'express';
import { publicRateLimiter } from '../../../api/rate-limit/rate-limit.middleware';
import { MiniAppController } from './miniapp.controller';
import { InAppPageController } from './inapp-page.controller';
import { ProductListingController } from './surfaces/product-listing.controller';
import { ProductDetailController } from './surfaces/product-detail.controller';
import { TicketFormController } from './surfaces/ticket-form.controller';
import { BookingScreensController } from './surfaces/booking.controller';
import { CheckoutController } from './surfaces/checkout.controller';
import { OrderListingController } from './surfaces/order-listing.controller';
import { StoreListingController } from './surfaces/store-listing.controller';
import { BotPurchaseController } from '../controllers/bot-purchase.controller';

/**
 * `/api/bot/miniapp` — the Telegram Mini App's own mount.
 *
 * ── THREE ROUTES, AND THE MOUNT IS THE SECURITY DECISION ────────────────────
 * This is deliberately NOT under `/api/internal/bot`. That router's first two `router.use`
 * lines demand `INTERNAL_SERVICE_TOKEN` and `BOT_WEBHOOK_SECRET`, and a browser cannot be
 * given either without giving every viewer the whole bot surface. Mounting here instead makes
 * that impossible by construction rather than by a guard somebody could reorder.
 *
 * ⚠ **`GET` is correct here and forbidden next door**, and the difference is what is in the
 * URL. The bot surface bans `GET` because its identity envelope would put a real person's
 * phone number into every access log on the path; what is in these URLs is an opaque
 * random handle that names a shopping list and expires in thirty minutes.
 *
 * ── ITS OWN IP BUCKET, FOR THE STOREFRONT'S REASON ──────────────────────────
 * `publicRateLimiter` is reused rather than a fourth policy invented: this is
 * unauthenticated browser traffic on a page that fires two or three requests per open, which
 * is exactly the shape `PUBLIC_POLICY` was sized for. Layer A still applies on top.
 *
 * ⚠ **Not exempt from maintenance**, unlike `/api/internal/bot/*`'s reads. A `readonly`
 * window blocks the cart write and leaves the page readable, which is the honest behaviour —
 * and a `down` window closes it entirely, as it closes the storefront the page is part of.
 */
const router = Router();

router.use(publicRateLimiter);

/**
 * ── THE OLD RAIL — being retired, still serving ──────────────────────────────
 *
 * ⚠ **Kept working until the new listing screen is proven on a real handset, then deleted.**
 * That deletion is a named task, not a someday: dead code that looks alive is how somebody
 * later fixes a bug in the wrong file. The chat card's button is repointed at `/s/pl/…` first;
 * these two lines and `miniapp.controller.ts` go once that is confirmed.
 */
/** The page itself. Static, cached nowhere, and it checks no handle — see the controller. */
router.get('/p/:handle', MiniAppController.page);

/** Its data. Same handle, one hop later, as JSON. */
router.get('/api/:handle', MiniAppController.data);

/** The one write. Bounded to variants the set itself offered. */
router.post('/api/:handle/cart', MiniAppController.addToCart);

// ─────────────────────────────────────────────────────────────────────────────
//  The in-app screens — `/s/<kind>/<handle>`
//
//  ⚠ **`assertNoShadowedRoutes()` does NOT cover this router.** It guards `BOT_ROUTES` only,
//  so ordering here is unprotected — and this service has shipped the literal-behind-parameter
//  defect twice (`/articles/index` behind `/articles/:slug`,
//  `/orders/groups/:cartId` behind `/orders/:id`). Both times the handler existed, compiled,
//  and was never reached.
//
//  The `/s/` prefix is what makes that impossible here rather than merely unlikely: `/p/:handle`
//  is one segment deep and `/s/:kind/:handle` is two, so neither can swallow the other at any
//  depth, whatever order they are declared in.
//
//  ⚠ **Each screen's DATA endpoint belongs to the stream that builds it — but this FILE
//  belongs to the coordinator, and the two are not the same thing.**
//
//  An earlier draft of this comment said the owning stream mounts its own route here. That is
//  wrong and it is the exact hazard the rest of the plan is built to avoid: three streams each
//  adding a line to one file, in one working tree with no branching, is a **lost write** — not
//  a merge conflict somebody resolves, but one session's work silently vanishing.
//
//  So: a stream writes its controller in a file only it owns, then asks the coordinator to
//  mount it, and the coordinator edits this file alone. One message per stream, once. The
//  alternative considered and rejected was landing stub handlers here in advance (the way
//  Stream 0 landed every `BOT_ROUTES` row): it would need a new error code for "built but not
//  implemented", and a stub that answers like a real endpoint is a screen that looks alive.
//
//  Routes, and who writes the controller behind each:
//    GET  /s/pl/:handle/data   ·  POST /s/pl/:handle/open     — the listing screen   (Stream B)
//    GET  /s/pd/:handle/data                                  — the detail screen    (Stream B)
//    POST /s/pd/:handle/act                                   — the purchase write   (Stream C)
//    GET  /s/co/:handle/data   ·  POST /s/co/:handle/place    — checkout             (Stream D)
//    GET  /s/ol/:handle/data                                  — order history        (Stream E)
//    GET  /s/sl/:handle/data   ·  POST /s/sl/:handle/open     — shop directory       (Stream E)
//
//  ⚠ **`/s/pd/:handle/act` is Stream C's, not Stream B's, and the split is the point**: the
//  detail screen RENDERS the purchase button and the purchase stream EXECUTES it. Both halves
//  reading one affordance is what keeps the word on the chat card and the word on the screen
//  the same word.
//
//  ⚠ Until a route is mounted its screen's page still loads and shows its own "ask me again"
//  state, because `inapp-page.controller.ts` serves the HTML without checking anything. That
//  is the designed degradation, not a bug to race to close.
//
//  ⛔ **An unmounted controller is not merely idle — it FAILS `test:bot-surface`.** That suite
//  asserts every module file is reachable from the router or the barrel, so a controller a
//  stream has written and the coordinator has not yet mounted turns the shared gate red for
//  every session at once. Mount promptly; do not let written-but-unmounted sit.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shared stylesheet, one segment deep.
 *
 * ⚠ **Declared before `/p/:handle` and `/s/:kind/:handle` for legibility, not for
 * correctness** — it is one segment and they are two and three, so no ordering here can make
 * one swallow another. That is the same property `/s/` was given for, and it is stated twice
 * because the defect it guards against has shipped twice.
 *
 * ⚠ **The only static asset this router serves, and it is named literally.** `express.static`
 * over `public/` would also publish every screen's HTML on a second set of URLs — reachable
 * with no handle, none of the route-scoped headers, and none of the framing relaxations that
 * make a page work inside Telegram.
 */
router.get('/shell.css', InAppPageController.stylesheet);

/** The page. One handler, five screens, one copy of the headers that keep it from blanking. */
router.get('/s/:kind/:handle', InAppPageController.page);

/**
 * The words, before any data.
 *
 * ⚠ Deliberately answers even for a handle that cannot be resolved — a page must be able to
 * say "ask me again" in the customer's own language, and it cannot learn the language from the
 * request that just failed.
 */
router.get('/s/:kind/:handle/copy', InAppPageController.copy);

// ─────────────────────────────────────────────────────────────────────────────
//  The screens' own data endpoints, mounted by the coordinator as each lands.
//
//  ⚠ **Declared AFTER `/s/:kind/:handle` and that is safe, because these are three segments
//  deep and it is two.** Express matches on segment count first, so `/s/pl/ia_x/data` cannot
//  be swallowed by `/s/:kind/:handle` at any ordering. `/copy` above proves the same shape.
//
//  ⚠ Each is pinned to ONE literal kind rather than taking `:kind`, deliberately. The store's
//  `read` already refuses a mismatched kind, but a route that accepted any kind would send a
//  checkout handle into a listing controller before that check ever ran — and defence that
//  depends on the callee remembering is defence somebody eventually forgets.
// ─────────────────────────────────────────────────────────────────────────────

/** Product listing — the browse grid. */
router.get('/s/pl/:handle/data', ProductListingController.data);

/**
 * Mint a detail session for one product and answer with its URL.
 *
 * ⚠ A POST rather than a link per card: a grid of 24 cards would otherwise mean 24 sessions
 * written for a customer who taps at most one. It also inherits the membership check — the
 * stored session is the authority on what this page was allowed to offer.
 */
router.post('/s/pl/:handle/open', ProductListingController.open);

/** Product detail — options, variants, and the affordance the button renders from. */
router.get('/s/pd/:handle/data', ProductDetailController.data);

/**
 * The two sections beside the product itself.
 *
 * ⚠ **`similar` is a POST and `reviews` is a GET, and that asymmetry is deliberate rather than
 * sloppy**: opening the similar grid MINTS a listing session — a credential — while reading
 * reviews mints nothing and pages with a query string.
 *
 * ⚠ **The page treats a failed reviews fetch as "no section"**, so a bad minute on this read
 * costs a customer the reviews and never the product page.
 */
router.post('/s/pd/:handle/similar', ProductDetailController.similar);
router.get('/s/pd/:handle/reviews', ProductDetailController.reviews);

/**
 * The purchase button on the detail screen was pressed.
 *
 * ⚠ **Stream C's handler on Stream B's screen, and the split is the whole design.** The screen
 * RENDERS the affordance and the purchase stream EXECUTES it, so one function decides the rung
 * for the chat card and the screen alike — which is why a customer sees the same word in both
 * places. Putting this in the detail controller would give the button two owners.
 *
 * ⚠ **The page sends a variant id and never a verb.** The server re-resolves the rung from the
 * product, discarding whatever the page thought it was. A page is a thing a customer can edit.
 */
router.post('/s/pd/:handle/act', BotPurchaseController.screenAct);

/**
 * Bookings — the list, and the picker that becomes an appointment.
 *
 * ⚠ **`confirm` SPENDS its handle** (201), so a double tap cannot take two slots. The two
 * reads are repeatable: `slotData` with no `?date` answers the days that HAVE times, and with
 * `?date=YYYY-MM-DD` answers that day's times.
 *
 * ⚠ **The pay screen (`bp`) is deliberately NOT mounted here yet** — the bookings stream sends
 * it as its own request when the screen lands. A mounted route beats a reserved one: a route
 * pointing at a handler that does not exist stops the server for every session at boot.
 */
router.get('/s/bl/:handle/data', BookingScreensController.listData);
router.get('/s/bk/:handle/data', BookingScreensController.slotData);
router.post('/s/bk/:handle/confirm', BookingScreensController.confirm);

/**
 * Paying for an appointment — the deposit, or the balance a vendor has since settled.
 *
 * ⚠ **`bp` waited for this read rather than being reserved with the other two**, and the wait
 * was the point: the session holds NO amount, because a balance moves the moment a vendor
 * settles the appointment. The figure is resolved at read and **again at pay**, so a screen
 * drawn from a stale session cannot charge a stale number. Mounting a route before that read
 * existed would have been a payment screen with nothing honest to show.
 *
 * ⚠ **`pay` SPENDS the handle**, like `/s/co/:handle/place` and `/s/bk/:handle/confirm`.
 *
 * ⛔ **Neither route claims an OUTCOME** — not "failed", and not "payment received" either. A
 * screen that announces a result on its own authority is the same fault in the cheerful
 * direction, and the easier one to add later: the verdict comes from the gateway, to the chat.
 */
router.get('/s/bp/:handle/data', BookingScreensController.payData);
router.post('/s/bp/:handle/pay', BookingScreensController.pay);

/**
 * The support form — one screen that opens a request.
 *
 * ⚠ **Mounted as a PAIR, and `submit` SPENDS its handle** (`consume`, not `read`) exactly as
 * `/s/co/:handle/place` does — so a double tap cannot open two support requests for one
 * problem. Reading the form is repeatable; sending it happens once.
 */
router.get('/s/tf/:handle/data', TicketFormController.data);
router.post('/s/tf/:handle/submit', TicketFormController.submit);

/**
 * Checkout — the basket, the masked address, and the write that places the order.
 *
 * ⚠ **Mounted as a PAIR, deliberately.** The page is useless with only the read, and dangerous
 * to reason about with only the write. They land together or not at all.
 *
 * ⚠ `place` is the one route on this whole mount that SPENDS its handle — `consume`, not
 * `read` — so a double-tap, a refresh and a forwarded URL all find it gone. There is no
 * `Idempotency-Key` here to fall back on: this is browser traffic, and a browser sends what
 * the page sends.
 */
router.get('/s/co/:handle/data', CheckoutController.data);
router.post('/s/co/:handle/place', CheckoutController.place);

/** Order history — the full list, beyond the five the chat shows. */
router.get('/s/ol/:handle/data', OrderListingController.data);

/**
 * The shop directory, and one tap into a shop.
 *
 * ⚠ `open` is the `sl` analogue of the listing's: tapping a shop mints a `pl` session pinned
 * to that shop and answers with a same-origin URL. The alternative — linking out to the
 * storefront — would leave the WebView, losing the Telegram context, the theme and the ability
 * to close cleanly, which is the whole reason a screen beats a link here.
 */
router.get('/s/sl/:handle/data', StoreListingController.data);
router.post('/s/sl/:handle/open', StoreListingController.open);

export default router;
