import { RequestHandler, Router } from 'express';
import { requireServiceToken } from '../agents/middlewares/service-token.middleware';
import { requireBotWebhookSecret } from '../../api/middlewares/bot-webhook.middleware';
import { requireBotIdentity } from './middlewares/bot-identity.middleware';
import { botIdempotency } from './middlewares/bot-idempotency.middleware';
import { attachBotReply } from './middlewares/bot-reply.middleware';
import { BOT_ROUTES } from './domain/bot-route-table';
import { BotIdentityController } from './controllers/bot-identity.controller';
import { BotCartController } from './controllers/bot-cart.controller';
import { BotOrderController } from './controllers/bot-order.controller';
import { BotProfileController } from './controllers/bot-profile.controller';
import { BotGeoController } from './controllers/bot-geo.controller';
import { BotTicketController } from './controllers/bot-ticket.controller';
import { BotFileController } from './controllers/bot-file.controller';
import { BotCatalogController } from './controllers/bot-catalog.controller';
import { BotProductDisplayController } from './controllers/bot-product-display.controller';
import { BotBookingController } from './controllers/bot-booking.controller';
import { BotPaymentMethodController } from './controllers/bot-payment-method.controller';
import { BotReviewController } from './controllers/bot-review.controller';
import { BotNotificationController } from './controllers/bot-notification.controller';
import { BotSupportController } from './controllers/bot-support.controller';
import { BotMessagingController } from './controllers/bot-messaging.controller';
import { BotContactController } from './controllers/bot-contact.controller';
import { BotAccountController } from './controllers/bot-account.controller';
import { BotAuthController } from './controllers/bot-auth.controller';
import { BotCommandController } from './controllers/bot-command.controller';

/**
 * The curated bot surface — mounted at `/api/internal/bot` (GAP-001).
 *
 * ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ───────────────────────────
 * A closed set of named operations the automation layer may perform on a customer's
 * behalf. Every route delegates to the SAME service the customer API calls, with a
 * customer id the backend resolved from a messaging identity. No business logic lives
 * here; only the door is new.
 *
 * **Not a generic proxy.** A route that forwarded arbitrary paths would make whatever the
 * customer API grows next reachable from a chat window with no decision taken — which is
 * the bot-minted-session option wearing a different hat. Every route below was chosen.
 *
 * **Not a session mint.** No customer bearer token is ever issued to the automation layer,
 * and there is no endpoint here that could produce one. That is what keeps a compromised
 * automation layer from becoming a credential store for the entire customer base — which
 * matters more here than it would elsewhere, because a passwordless customer has NO
 * revocation path at all: `password_changed_at` is this service's only lever, and a
 * customer who has never reset has never set it.
 *
 * ── FOUR GUARDS, IN THIS ORDER, AND THE ORDER IS THE DESIGN ─────────────────
 *
 *   1. `requireServiceToken`     — the same `INTERNAL_SERVICE_TOKEN` geo-tracker presents.
 *   2. `requireBotWebhookSecret` — the same `BOT_WEBHOOK_SECRET` the bot webhooks require.
 *   3. `requireBotIdentity`      — resolves the messaging identity to a customer.
 *   4. `botIdempotency`          — demands and honours `Idempotency-Key` on mutations.
 *
 * ⚠ **TWO CREDENTIALS, NOT ONE, AND THAT IS THE POINT OF THE FIRST TWO.** A leaked
 * `INTERNAL_SERVICE_TOKEN` opens the agent and shipment surfaces today. It must not also
 * open every customer's cart, orders and addresses. The two secrets are held by different
 * parts of the deployment and rotate on different schedules, so one compromise is not both.
 *
 * ⚠ Identity resolution runs BEFORE idempotency, and swapping them would be wrong in a way
 * that is easy to miss: an idempotency record is scoped to the RESOLVED caller, so a claim
 * taken before resolution could not be scoped at all — two conversations picking the same
 * key would share a record. It also means a caller whose identity does not resolve never
 * spends a key, and may retry the same one once they do.
 *
 * ── EVERY ROUTE IS A POST, A PATCH OR A DELETE. NONE IS A GET ───────────────
 * The identity envelope is a body, and putting a messaging identifier in a query string
 * writes a real person's phone number into every access log on the path. `GET` is kept
 * only where there is no identity to carry — and on this surface there always is one.
 *
 * ⚠ **Several routes are `DELETE` WITH A BODY**, because the catalogue specifies those verbs
 * and the envelope still has to travel. Express parses a JSON `DELETE` body without
 * complaint, but some HTTP clients and intermediaries drop one — so a caller that finds
 * `identity` missing on exactly those has hit that, not a bug here. Recorded in
 * `api-doc/n8n/bot-surface.md`.
 *
 * ⚠ **This said "three" and then "six", and both were prose nothing asserted.** Count the
 * `DELETE` rows in `BOT_ROUTES` rather than trusting a sentence here — the number has been
 * wrong twice, each time a step added one and nobody re-counted.
 *
 * ── THE ROUTES COME FROM THE TABLE, NOT FROM THIS FILE ──────────────────────
 * `domain/bot-route-table.ts` declares them, and the loop at the bottom mounts them. This
 * file supplies the handlers and nothing else. A route cannot be mounted without a
 * `mutating` classification (so it cannot slip past the idempotency guard or the read-only
 * maintenance rule), and a handler cannot exist without a route (so a controller method
 * nobody reaches fails the boot rather than sitting there looking live). Both directions
 * are checked below — the same closed-registry shape `scripts/migrate.ts` uses for its
 * migration list, for the same reason.
 */

/**
 * Tool name → handler. The catalogue's name is the key, so a row in the table, a tool in
 * `api-doc/n8n/tools/catalog.json` and a handler here are joined by one string.
 */
const HANDLERS: Readonly<Record<string, RequestHandler>> = Object.freeze({
    // ── Identity ─────────────────────────────────────────────────────────────
    identity_resolve_sender: BotIdentityController.resolve,

    // ── Registration and onboarding (GAP-002) ────────────────────────────────
    identity_sync_sender: BotIdentityController.sync,
    identity_submit_onboarding: BotIdentityController.onboarding,

    // ── Cart ─────────────────────────────────────────────────────────────────
    cart_get: BotCartController.get,
    cart_quote: BotCartController.quote,
    cart_add_item: BotCartController.addItem,
    cart_set_item_quantity: BotCartController.setItemQuantity,
    cart_remove_item: BotCartController.removeItem,
    cart_clear: BotCartController.clear,

    // ── Checkout and money ───────────────────────────────────────────────────
    checkout_create_orders: BotCartController.checkout,
    payment_get_transaction: BotCartController.getTransaction,
    payment_create_pay_link: BotCartController.createPayLink,

    // ── Orders ───────────────────────────────────────────────────────────────
    orders_list_groups: BotOrderController.list,
    orders_get_group: BotOrderController.getGroup,
    orders_get_order: BotOrderController.getOrder,
    orders_list_shipments: BotOrderController.listShipments,
    orders_get_cod_code: BotOrderController.getCodCode,
    orders_cancel: BotOrderController.cancel,
    orders_resend_cod_code: BotOrderController.resendCodCode,
    orders_confirm_shipment_delivery: BotOrderController.confirmShipmentDelivery,

    // ── Profile and addresses ────────────────────────────────────────────────
    profile_get_summary: BotProfileController.getSummary,
    profile_update: BotProfileController.update,
    profile_set_language: BotProfileController.setLanguage,
    addresses_list: BotProfileController.listAddresses,
    addresses_add: BotProfileController.addAddress,
    addresses_update: BotProfileController.updateAddress,
    addresses_remove: BotProfileController.removeAddress,
    addresses_set_default: BotProfileController.setDefaultAddress,

    // ── Geo ──────────────────────────────────────────────────────────────────
    geo_search_address: BotGeoController.search,
    geo_reverse_address: BotGeoController.reverse,

    // ── Tickets ──────────────────────────────────────────────────────────────
    tickets_list: BotTicketController.list,
    tickets_create: BotTicketController.create,
    tickets_get: BotTicketController.get,
    tickets_add_note: BotTicketController.addNote,
    tickets_close: BotTicketController.close,
    tickets_add_attachment: BotTicketController.addAttachment,

    // ── Inbound files (Step 7b) ──────────────────────────────────────────────
    files_receive_inbound: BotFileController.receiveInbound,

    // ── Support routing (GAP-004) ────────────────────────────────────────────
    support_resolve_contacts: BotSupportController.context,

    // ── Product cards ────────────────────────────────────────────────────────
    catalog_show_products: BotProductDisplayController.show,
    catalog_display_action: BotProductDisplayController.action,

    // ── Wishlist, recently viewed, digital ───────────────────────────────────
    wishlist_list: BotCatalogController.listWishlist,
    wishlist_add: BotCatalogController.addWishlist,
    wishlist_remove: BotCatalogController.removeWishlist,
    recently_viewed_record: BotCatalogController.recordView,
    recently_viewed_list: BotCatalogController.listRecentlyViewed,
    recently_viewed_clear: BotCatalogController.clearRecentlyViewed,
    digital_list_entitlements: BotCatalogController.listEntitlements,
    digital_create_download_link: BotCatalogController.createDownloadLink,

    // ── Bookings ─────────────────────────────────────────────────────────────
    bookings_list: BotBookingController.list,
    bookings_get_availability: BotBookingController.availability,
    bookings_create: BotBookingController.create,
    bookings_get: BotBookingController.get,
    bookings_get_balance: BotBookingController.balance,
    bookings_payment_status: BotBookingController.paymentStatus,
    bookings_pay: BotBookingController.pay,
    bookings_pay_balance: BotBookingController.payBalance,
    bookings_cancel: BotBookingController.cancel,
    bookings_reschedule: BotBookingController.reschedule,

    // ── Saved payment methods ────────────────────────────────────────────────
    payment_methods_list: BotPaymentMethodController.list,
    payment_methods_add: BotPaymentMethodController.add,
    payment_methods_set_default: BotPaymentMethodController.setDefault,
    payment_methods_remove: BotPaymentMethodController.remove,

    // ── Account access ───────────────────────────────────────────────────────
    commands_dispatch: BotCommandController.dispatch,
    auth_send_login_link: BotAuthController.sendLoginLink,

    // ── Contact changes (MCP parity step 6) ──────────────────────────────────
    contact_get_state: BotContactController.getState,
    contact_change_email: BotContactController.changeEmail,
    contact_cancel_email_change: BotContactController.cancelEmailChange,
    contact_change_phone: BotContactController.changePhone,
    contact_confirm_phone: BotContactController.confirmPhone,
    contact_cancel_phone_change: BotContactController.cancelPhoneChange,

    // ── Connections and account closure (MCP parity step 7) ──────────────────
    connections_list: BotAccountController.listConnections,
    connections_disconnect: BotAccountController.disconnect,
    account_close_preview: BotAccountController.closePreview,
    account_close: BotAccountController.close,

    // ── Reviews ──────────────────────────────────────────────────────────────
    reviews_check_eligibility: BotReviewController.eligibility,
    reviews_list_mine: BotReviewController.list,
    reviews_create: BotReviewController.create,

    // ── Proactive messaging (GAP-012) ────────────────────────────────────────
    messaging_get_window: BotMessagingController.window,
    messaging_notify_customer: BotMessagingController.notify,

    // ── Notification preferences ─────────────────────────────────────────────
    notifications_get_preferences: BotNotificationController.get,
    notifications_update_preferences: BotNotificationController.update,
    notifications_list: BotNotificationController.list,
    notifications_unread_count: BotNotificationController.unreadCount,
    notifications_mark_read: BotNotificationController.markRead,
    notifications_mark_all_read: BotNotificationController.markAllRead,
});

/**
 * The registry is CLOSED, in both directions, and it is checked at import.
 *
 * A table row with no handler would be a 404 on a route the catalogue advertises; a
 * handler with no row would be a controller method that compiles, looks live, and is never
 * reached — the failure mode this service has already met twice on route ordering. Neither
 * is worth discovering at runtime, so the process does not start.
 */
export function assertHandlersCoverRoutes(): void {
    const missing = BOT_ROUTES.filter((route) => typeof HANDLERS[route.tool] !== 'function');
    if (missing.length > 0) {
        // A bare Error, at module load, with no request in flight and nothing above to
        // catch it. An AppError exists to become an HTTP response by the global handler,
        // and there is no response here: the process must refuse to boot.
        // eslint-disable-next-line no-restricted-syntax -- module load, no request
        throw new Error(
            `[BotSurface] no handler for: ${missing.map((r) => r.tool).join(', ')}`,
        );
    }

    const declared = new Set(BOT_ROUTES.map((route) => route.tool));
    const orphans = Object.keys(HANDLERS).filter((tool) => !declared.has(tool));
    if (orphans.length > 0) {
        // eslint-disable-next-line no-restricted-syntax -- module load; see above.
        throw new Error(
            `[BotSurface] handler with no route in BOT_ROUTES: ${orphans.join(', ')}`,
        );
    }
}

assertHandlersCoverRoutes();

const router = Router();

router.use(requireServiceToken);
router.use(requireBotWebhookSecret);
/**
 * ⚠ **`attachBotReply` is mounted TWICE, and neither mount is redundant.** `res.json`
 * wrappers run in REVERSE order of installation, so the two positions buy different things:
 *
 *   here, ABOVE `requireBotIdentity` — that guard refuses by THROWING, and a `next(error)`
 *   skips every ordinary middleware below it. Without this line the three identity refusals
 *   would carry no message at all, which is the case a chat window most needs worded.
 *
 *   below `botIdempotency` — the last wrapper installed is the first to run, so that mount
 *   is what puts `reply` into the body BEFORE the idempotency guard captures it. Otherwise a
 *   replayed 200 comes back with nothing to send and the customer is told nothing.
 *
 * The injection is a no-op on a body that already carries `reply`, so the inner mount simply
 * passes through whatever the outer one produced.
 */
router.use(attachBotReply);
router.use(requireBotIdentity);
router.use(botIdempotency);
router.use(attachBotReply);

for (const route of BOT_ROUTES) {
    const handler = HANDLERS[route.tool];
    switch (route.method) {
        case 'POST':
            router.post(route.path, handler);
            break;
        case 'PATCH':
            router.patch(route.path, handler);
            break;
        case 'DELETE':
            router.delete(route.path, handler);
            break;
        default: {
            // Exhaustiveness: a method added to the table without a mount fails the boot.
            const unreachable: never = route.method;
            // eslint-disable-next-line no-restricted-syntax -- module load; see above.
            throw new Error(`[BotSurface] unmountable method ${String(unreachable)}`);
        }
    }
}

export default router;
