import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { setAuthCookies } from '../../config/cookie.config';
import { messagingLoginService } from './services/messaging-login.service';
import {
  RedeemMagicCodeSchema,
  RedeemMagicLinkSchema,
} from './validators/messaging-login.validator';

/**
 * Redeeming a passwordless sign-in (mounted at `/api/auth/magic`).
 *
 * Both handlers set the two auth cookies and return no tokens in the body —
 * the same session model as `POST /auth/login`, minted by the same
 * `issueTokenPair`, with the same lifetimes and the same revocation.
 *
 * ── BEARER CLIENTS ARE OUT OF SCOPE, DELIBERATELY ────────────────────────────
 * The magic link opens the system browser and the code is typed on the website,
 * so cookies are right for both. A Capacitor WebView cannot use them — if the
 * customer app needs this it needs an `/api/auth/mobile/magic/*` twin returning
 * `data.tokens`, exactly as the mobile namespace does elsewhere. Not built until
 * asked for, rather than half-built now.
 */
export class MessagingLoginController {
  /**
   * `POST /api/auth/magic/link`
   *
   * A POST, and the storefront page — not the chat client — is what calls it.
   * WhatsApp and Telegram FETCH link URLs to build preview cards, so a GET that
   * signed you in would be spent by the crawler before the user ever tapped.
   * See `buildMagicLinkUrl`.
   */
  static redeemLink = asyncHandler(async (req: Request, res: Response) => {
    const { token } = RedeemMagicLinkSchema.parse(req.body ?? {});

    const { user, role, accessToken, refreshToken } = await messagingLoginService.redeemLink(token);

    setAuthCookies(res, accessToken, refreshToken);
    sendSuccess(res, { role, user }, { message: 'Signed in' });
  });

  /** `POST /api/auth/magic/code` — the code, typed beside a phone number or email. */
  static redeemCode = asyncHandler(async (req: Request, res: Response) => {
    const { identifier, code } = RedeemMagicCodeSchema.parse(req.body ?? {});

    const { user, role, accessToken, refreshToken } = await messagingLoginService.redeemCode(
      identifier,
      code
    );

    setAuthCookies(res, accessToken, refreshToken);
    sendSuccess(res, { role, user }, { message: 'Signed in' });
  });
}
