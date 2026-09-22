import { RequestHandler, Router } from 'express';
import { AdminUserController } from './admin-user.controller';

/**
 * Platform-user administration — the write surface wi-admin delegates to.
 *
 * ── Mounted ONCE, unlike every other admin router ─────────────────────────────
 * `buildAdminCodRouter` is instantiated twice, at `/api/admin/cod` for today's dashboard
 * and at `/api/internal/admin/cod` for wi-admin, because that domain has a legacy
 * consumer that must keep working until cutover. This one does not: PHASE-0 found the
 * user domain had **no admin surface anywhere**, so there is no dashboard calling
 * `/api/admin/users` and nothing to keep alive. Adding a public mount would create
 * surface whose only future is the deletion list in Phase 8 (J10).
 *
 * The factory shape is kept anyway — it costs one parameter and it is what the remaining
 * routers look like, so this file does not become the odd one out that somebody has to
 * reshape when it eventually needs a second mount.
 */
function attachRoutes(router: Router): Router {
    /**
     * PATCH /:userId
     * Change the login identifiers. Body: `{ email?, phone? }`, either clearable with
     * `null`/`''`. Refuses an identifier another account holds (409) and refuses to
     * leave the account with neither (422).
     */
    router.patch('/:userId', AdminUserController.updateContact);

    /**
     * POST /:userId/suspend
     * Body: `{ reason }`. Blocks login, refresh and every authenticated request from the
     * next request onward. 409 when the account is not currently active.
     */
    router.post('/:userId/suspend', AdminUserController.suspend);

    /** POST /:userId/restore — lift a suspension. 409 when it is not suspended. */
    router.post('/:userId/restore', AdminUserController.restore);

    /**
     * POST /:userId/password-reset-link  · POST /:userId/login-link
     * Body: `{ channel: 'email' | 'whatsapp' | 'telegram' }`.
     *
     * Account recovery an operator can initiate on somebody's behalf. Both mint through
     * the machinery that already exists — `PasswordResetService.issueResetLinkFor` and
     * `MessagingLoginService.mintForAdministrator` — so the token, its lifetime and its
     * single-use semantics are the ones the self-service and bot paths already have.
     *
     * ⚠ The DESTINATION IS NOT IN THE BODY, and must never be. It is read from the
     * party's own record; a caller who could name it could mail themselves a working
     * credential for another person's account. The response carries a masked destination
     * and no token.
     *
     * The sign-in link is customers only. See the controller.
     */
    router.post('/:userId/password-reset-link', AdminUserController.sendPasswordResetLink);
    router.post('/:userId/login-link', AdminUserController.sendLoginLink);

    /**
     * POST /:userId/bot-memory/reset
     * Body: `{}` (anything else is ignored). Bumps the customer's bot-memory EPOCH so the
     * automation layer's conversation memory for them is unreachable from the next message, and
     * clears any Yes/No question still waiting for a typed answer. Writes nothing else.
     * 200 `{ success, data: { userId, memoryEpoch, resetAt } }`.
     */
    router.post('/:userId/bot-memory/reset', AdminUserController.resetBotMemory);

    return router;
}

/** Build the user admin surface behind an arbitrary guard chain. */
export function buildAdminUserRouter(guards: RequestHandler[]): Router {
    const router = Router();
    router.use(...guards);
    return attachRoutes(router);
}
