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
 * ── BEARER CLIENTS HAVE THEIR OWN NAMESPACE NOW ──────────────────────────────
 * This file used to say they were out of scope and would need an
 * `/api/auth/mobile/magic/*` twin if the customer app ever wanted one. It does,
 * and the twin is `mobile-messaging-login.controller.ts`, which returns the same
 * pair in `data.tokens` and sets no cookie.
 *
 * Both call the same `messagingLoginService` methods, so a rule added there
 * applies to both without anyone remembering. **Keep this file the cookie one.**
 * The split exists so browser behaviour is unchanged by construction rather than
 * by a check somebody could get wrong; adding a `tokens` block here would
 * quietly hand every browser a copy of its own session in a readable body.
 * `test:messaging-login` asserts that it does not.
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
