import { Router } from 'express';
import { ConnectionController } from './channel-connection.controller';
import { connectionCodeRateLimiter } from '../../api/rate-limit/rate-limit.middleware';

/**
 * Messaging connection routes, mounted under `/api/me` — which applies
 * `requireAuth` at the router level, so nothing here declares a guard.
 *
 * ── THE MOUNT POINT IS A SECURITY DECISION ───────────────────────────────────
 * These deliberately do NOT live under `/api/webhooks/*` beside the bot ingress,
 * where their two predecessors sat. That prefix is exempt from rate limiting and
 * stays reachable during a maintenance window (both for good reasons — a 429 to
 * a payment gateway or to geo-tracker's dispatcher is worse than the load), and
 * the linking endpoints inherited both exemptions by accident of being routed
 * next to a webhook.
 *
 * Redeeming a code is the one endpoint in this feature an attacker would want to
 * hammer: six characters is 2^30, which a few million requests erodes. Under
 * `/api/me` it inherits Layer B (`identityRateLimiter`, attached at the tail of
 * `requireAuth`) on top of the per-account attempt counter in the code store.
 *
 * `test:connections` source-scans for this — the invariant is structural and a
 * regression is invisible in behaviour until somebody is brute-forcing it.
 */
const router = Router();

router.get('/', ConnectionController.list);

/**
 * Redeeming is the only route here that takes a guessable secret, so it is the only one
 * carrying a per-endpoint limiter — three layers deep by the time a request arrives:
 *
 *   Layer A  `globalRateLimiter`         1200/min per IP (volume backstop, in app.ts)
 *   Layer B  `identityRateLimiter`       600-1200/min per account (tail of requireAuth)
 *   Layer C  `connectionCodeRateLimiter` 30/min per IP  ← here
 *   plus     the store's attempt counter 5 per 10 min per account
 *
 * The last two are the security controls and they deliberately key on **different** axes.
 * The attempt counter is tighter but is keyed on the account, and accounts are free to
 * create; the IP bucket is what stops somebody registering their way to unlimited guesses.
 */
router.post('/', connectionCodeRateLimiter, ConnectionController.redeem);

router.delete('/:channel', ConnectionController.disconnect);

export default router;
