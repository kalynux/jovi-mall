import { Router, Request, Response, NextFunction } from 'express';
import { requireServiceToken } from '../../agents/middlewares/service-token.middleware';
import { negotiationPlaybookService } from '../services/negotiation-playbook.service';
import negotiationToolsRoutes from './negotiation-tools.routes';
import { negotiationGateController } from '../controllers/negotiation-gate.controller';

/**
 * Internal negotiation API — mounted at `/api/internal/negotiation`.
 *
 * The FIFTH member of the `/internal` family, after `/agents`, `/shipments`,
 * `/bot` and `/vectoriser`. The caller is the n8n bargaining sub-agent's flow,
 * which fetches the playbook and puts it in the model request's SYSTEM position
 * before the agent node runs.
 *
 * ── One credential, and why not two ──────────────────────────────────────────
 *
 * `requireServiceToken` — the existing `INTERNAL_SERVICE_TOKEN`, same as
 * `/vectoriser` and the two geo-tracker mounts. The bot surface demands a second
 * secret because a leaked service token would otherwise open every customer's
 * basket and order history; nothing of that class is here. This door serves one
 * static document, identical for every customer, containing no personal data, no
 * prices and no vendor identifiers — it is the platform's own instructions to its
 * own agent.
 *
 * ⚠ It is a GET, unlike every route on `/internal/bot`. Those are POSTs because
 * their identity envelope is a body and a messaging identifier in a query string
 * is a real person's phone number written into every access log. There is no
 * identity here at all, so the reason does not apply.
 *
 * ── Deliberately NOT on the maintenance-mode exemption list ──────────────────
 *
 * `/internal/agents`, `/internal/shipments` and `/tracking` are exempt because
 * blocking them turns a jovi-mall maintenance window into a geo-tracker OUTAGE.
 * Nothing here has that property: refusing this read stops bargaining for the
 * duration of the window, the sub-agent hands back to the main agent, and
 * customers are still served — they simply pay the asking price. That is a
 * degradation, not somebody else's outage, which is the bar that list holds.
 *
 * ── Caching ─────────────────────────────────────────────────────────────────
 *
 * The response carries `checksum`, so a caller that already holds a copy can
 * compare rather than re-read. It is deliberately NOT an ETag/304 exchange: the
 * consumer is an n8n HTTP node with no conditional-request handling, and a 304
 * carrying no body would arrive as an empty system prompt.
 */
const router = Router();

router.use(requireServiceToken);

/**
 * `GET /playbook?key=<key>`
 *
 * `key` is optional and defaults to `NEGOTIATION_CONFIG.DEFAULT_PLAYBOOK_KEY`.
 * 503 `NEGOTIATION_PLAYBOOK_NOT_PUBLISHED` when nothing is published — see the
 * service's header for why that is a refusal rather than a fallback.
 */
router.get('/playbook', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const key = typeof req.query.key === 'string' ? req.query.key : undefined;
        const playbook = await negotiationPlaybookService.resolve(key);

        res.json({
            success: true,
            data: {
                key: playbook.key,
                version: playbook.version,
                description: playbook.description,
                compatibility: playbook.compatibility,
                content: playbook.content,
                checksum: playbook.checksum,
                updatedAt: playbook.updatedAt,
            },
        });
    } catch (error) {
        next(error);
    }
});

/**
 * The GATE (Stream A) — the sub-agent's two write-side tools.
 *
 * POST, not GET, and for the bot surface's reason: the body carries a messaging
 * identity, and a real person's phone number in a query string is written into every
 * access log on the path.
 *
 * ⚠ **Neither takes a customerId, and adding one would be account takeover.** The
 * caller passes an identity it OBSERVED on a webhook and the backend resolves who that
 * is, through the SAME `botIdentityService` the bot surface uses — one resolver, two
 * doors (R-8 is about two implementations, not two mounts). Both schemas are
 * `.strict()`, so an id sent anyway is a 400 rather than a silently ignored field.
 */
router.post('/context', negotiationGateController.context);
router.post('/record', negotiationGateController.record);

/**
 * `/tools/*` — the bargaining sub-agent's five READ tools (Stream B).
 *
 * Mounted here rather than beside this router in `api/index.ts` so it inherits the
 * `requireServiceToken` above: one door, one credential, and no second place to forget the
 * guard.
 *
 * ⚠ **The "no personal data, no prices and no vendor identifiers" claim in this file's
 * header describes `/playbook` and does NOT extend below.** The tools return prices, stock
 * and — on a bargainable variant — the vendor's **floor**. `negotiation-tools.routes.ts`
 * carries that decision (BARGAINING-AGENT-PLAN D-2) and the argument for why the credential
 * is nonetheless unchanged.
 */
router.use('/tools', negotiationToolsRoutes);

export default router;
