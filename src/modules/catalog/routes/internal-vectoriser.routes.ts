import { Router } from 'express';
import { requireServiceToken } from '../../agents/middlewares/service-token.middleware';
import { InternalVectoriserController } from '../controllers/internal-vectoriser.controller';

/**
 * Internal vectoriser API — mounted at /api/internal/vectoriser.
 *
 * The FOURTH member of the `/internal` family, after `/agents`, `/shipments` and
 * `/bot`. The caller is the n8n `wi-mall-vectoriser` workflow.
 * Contract: `api-doc/n8n/vectoriser/README.md` § 2–4.
 *
 * ── One credential, and why not two ──────────────────────────────────────────
 *
 * Guarded by `requireServiceToken` — the existing `INTERNAL_SERVICE_TOKEN`, the
 * same value geo-tracker presents on the two mounts above. No new shared secret,
 * and that is a judgement about what is behind the door rather than about
 * convenience.
 *
 * The bot surface demanded a SECOND credential (`BOT_WEBHOOK_SECRET`) because a
 * leaked service token would otherwise open every customer's basket, order
 * history and support thread. Nothing of that class is reachable here. The
 * writes this door accepts are `vectorisationStatus`, `vectorisedDataId` and a
 * credit refund on a failed attempt — the same value class as
 * `/internal/agents`. The read it serves is product catalogue data, which is
 * already public on the storefront, with one exception noted below.
 *
 * ⚠ **The exception, and it is the thing to watch on this route.**
 * `/payloads` returns the full \`buildPayload\` entry, and that entry carries each
 * variant's **bargain window** — `minPrice` is the real selling price and
 * `maxPrice` the ceiling haggling may reach, i.e. the negotiating agent's hand.
 * The workflow deliberately keeps those numbers OUT of the embedded text and
 * parks them in `metadata.bargain_windows` (README § 5). Anything that later
 * serves this data onward — the product-search tool above all — must strip that
 * field before it reaches a customer-facing model. This door hands it to a
 * server; it must not become a door that hands it to a chat.
 *
 * ── Read/write, and the asymmetry with the other internal doors ──────────────
 *
 * `/internal/shipments` is read-only on principle: geo-tracker has no business
 * writing the shipment model. That principle does not transfer here. The
 * vectoriser is the ONLY party that knows whether a product was indexed —
 * jovi-mall handed the work over and got a 202 — so the callback write is the
 * work being reported back, not a peer reaching into a model it does not own.
 *
 * ⚠ **Deliberately NOT on the maintenance-mode exemption list**
 * (`modules/system/domain/maintenance-mode.ts`), unlike `/internal/agents`,
 * `/internal/shipments` and `/tracking`. Those three are exempt because blocking
 * them turns a jovi-mall maintenance window into a geo-tracker OUTAGE — watchers
 * dropped, sessions failing authorization. Nothing here has that property: n8n
 * is not serving anybody in real time.
 *
 * The cost of blocking it is real but bounded and recoverable — a report lost
 * during the window leaves those products at `pending`, which locks them against
 * editing (`require-product-editable.middleware`) and leaves any debited credit
 * unrefunded, until `scripts/reconcile-vectorisation.ts` sweeps them up. That is
 * a maintenance-window consequence worth knowing before opening a long one; it
 * is not somebody else's outage, which is the bar this list holds.
 */
const router = Router();

router.use(requireServiceToken);

/**
 * POST /api/internal/vectoriser/payloads
 * Body: { product_ids: string[] } → { products, missing }
 *
 * Needed only by the spreadsheet path (`POST <base>/file`), where a row that is
 * just an id has to be resolved into a full product. jovi-mall's own submits
 * send the payload with the request and never call this.
 */
router.post('/payloads', InternalVectoriserController.getPayloads);

/**
 * POST /api/internal/vectoriser/callback
 * Body: the report in README § 3.
 *
 * The asynchronous half of every submit. This is the only route in the service
 * that writes `vectorisationStatus: 'completed'`.
 */
router.post('/callback', InternalVectoriserController.receiveCallback);

export default router;
