import { Router } from 'express';
import { NegotiationToolsController } from '../controllers/negotiation-tools.controller';

/**
 * The bargaining sub-agent's read tools — mounted at `/api/internal/negotiation/tools`.
 *
 * A sub-router of `internal-negotiation.routes.ts`, so it inherits that mount's
 * `requireServiceToken` rather than declaring a second guard. One door, one credential.
 *
 * ── ⚠ THIS SUB-ROUTER NARROWS THE PARENT'S "NOTHING SENSITIVE HERE" CLAIM ───────
 *
 * The parent router's header justifies a single credential on the grounds that it serves
 * *"one static document … containing no personal data, no prices and no vendor
 * identifiers"*. **That is true of `/playbook` and false of everything below.** These
 * routes return prices, stock, store identity and — on a bargainable variant — the vendor's
 * **floor**, which is the one number two other places on the platform exist to strip
 * (`product_search()`'s `metadata - 'bargain_windows'`, and n8n's `Shape Result`
 * allowlist). BARGAINING-AGENT-PLAN D-2 lifts that rule for this sub-agent alone, through
 * this tool, and records it as a decision rather than an oversight.
 *
 * The credential still stands, and the reason is the one `internal-vectoriser.routes.ts`
 * already gives about `/payloads`: `INTERNAL_SERVICE_TOKEN` is the right class of secret
 * for catalogue data handed to a **server**. What would demand a second secret — the bot
 * surface's `BOT_WEBHOOK_SECRET` — is a door onto a *customer's* cart, orders and
 * addresses, and there is none of that here: **no route below reads an identity of any
 * kind.** A leaked token exposes vendor floors, which is a real loss and a bounded one.
 *
 * ── POST, WHERE THE PLAYBOOK ROUTE BESIDE IT IS A GET ───────────────────────────
 *
 * `/playbook` is a GET because it takes one optional key and carries no identity. Both
 * halves are different here. The inputs are structured (numbers, enums, a flag) and one of
 * them is `query` — **the customer's own words, forwarded verbatim**. A search phrase in a
 * query string is written into every access log and proxy record on the path, which is the
 * same objection `/internal/bot` raises about a phone number, weaker but pointing the same
 * way. A body costs nothing and closes it.
 *
 * ── NOT ON THE MAINTENANCE-MODE EXEMPTION LIST ─────────────────────────────────
 *
 * Same reasoning as the parent's, and it survives the extra surface: blocking these stops
 * bargaining for the length of the window, the sub-agent hands back, and customers are
 * still served — they pay the asking price. A degradation, not somebody else's outage,
 * which is the bar that list holds.
 */
const router = Router();

/** `get_product_details` — the agent's truth source: variants, windows, real stock, images. */
router.post('/product-details', NegotiationToolsController.productDetails);

/** `find_alternative_product` — price-bounded substitutes. The budget bounds the FLOOR. */
router.post('/alternatives', NegotiationToolsController.findAlternatives);

/** `find_complementary_products` — bundle candidates from real co-purchase history. */
router.post('/complements', NegotiationToolsController.findComplements);

/** `quote_delivery` — the delivery PROMISE (D-7). No fee, no ETA, never `absorbedByVendor`. */
router.post('/delivery-promise', NegotiationToolsController.quoteDelivery);

/** `check_promotion` — the deliberate stub. Always `{ available: false }`. */
router.post('/promotion', NegotiationToolsController.checkPromotion);

export default router;
