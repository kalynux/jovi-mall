import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { tokenEnvelope } from '../../core/auth/token.issuer';
import { messagingLoginService } from './services/messaging-login.service';
import {
  RedeemMagicCodeSchema,
  RedeemMagicLinkSchema,
} from './validators/messaging-login.validator';

/**
 * Redeeming a passwordless sign-in from a client that cannot hold a cookie —
 * mounted at `/api/auth/mobile/magic`.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The cookie twin beside this file used to say bearer clients were out of scope,
 * and that was right until there was a customer app. There is one now, and the
 * gap it left was total rather than partial: a customer holds a system-generated
 * password that is disclosed to nobody, so `POST /auth/mobile/login` can never
 * work for one. These two routes are the ONLY way a customer authenticates, so
 * without a bearer twin the app could not sign anybody in at all.
 *
 * Two facts make the cookie path unusable inside a Capacitor WebView, and
 * neither is fixable on the client. Its origin is `capacitor://localhost` or
 * `https://localhost`, which makes our cookie third-party and blocked by
 * default; and `Set-Cookie` is a forbidden response-header name in the Fetch
 * standard, stripped from every `Response.headers` object in every engine, so
 * the client cannot scrape the token out either. It needs the pair in the body.
 *
 * ── What is shared, and what is not ──────────────────────────────────────────
 *
 * Both handlers call the SAME `messagingLoginService` method their cookie twin
 * calls. Every rule that matters — the single-use token, the attempt counter
 * keyed on the identifier, the deliberate collapse of four failure cases into
 * one `MAGIC_CODE_INVALID`, the account gate — lives in that service and applies
 * here without anyone remembering to apply it. The duplication against
 * `messaging-login.controller.ts` is the parse line and the service call, and
 * that is the honest price of not branching inside a shared handler.
 *
 * ── The one rule for this file ───────────────────────────────────────────────
 *
 * **No `setAuthCookies`, no `res.cookie`, anywhere in it** — the same rule
 * `controllers/mobile-auth.controller.ts` states, for the same reason: setting a
 * cookie a client provably cannot read is dead weight that makes every
 * debugging session harder. `test:messaging-login` scans this file for both.
 *
 * ── Still a POST, and still the strict rate-limit bucket ─────────────────────
 *
 * Neither property changes here. The link points at our own page rather than at
 * the API because WhatsApp and Telegram fetch URLs to build preview cards, so a
 * GET that signs you in is spent by the crawler before the user ever taps it.
 * And these present a bearer secret and mint a session — that is what a login
 * is — so they inherit the 20/min credential bucket by NOT being named in
 * `rate-limit/auth-paths.ts`, which is an allowlist.
 */
export class MobileMessagingLoginController {
  /** `POST /api/auth/mobile/magic/link` — the bearer twin of `/auth/magic/link`. */
  static redeemLink = asyncHandler(async (req: Request, res: Response) => {
    const { token } = RedeemMagicLinkSchema.parse(req.body ?? {});

    const { user, role, accessToken, refreshToken } = await messagingLoginService.redeemLink(token);

    sendSuccess(
      res,
      { role, user, tokens: tokenEnvelope({ accessToken, refreshToken }) },
      { message: 'Signed in' },
    );
  });

  /** `POST /api/auth/mobile/magic/code` — the bearer twin of `/auth/magic/code`. */
  static redeemCode = asyncHandler(async (req: Request, res: Response) => {
    const { identifier, code } = RedeemMagicCodeSchema.parse(req.body ?? {});

    const { user, role, accessToken, refreshToken } = await messagingLoginService.redeemCode(
      identifier,
      code,
    );

    sendSuccess(
      res,
      { role, user, tokens: tokenEnvelope({ accessToken, refreshToken }) },
      { message: 'Signed in' },
    );
  });
}
