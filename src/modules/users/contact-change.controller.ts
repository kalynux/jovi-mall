import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { contactChangeService, ContactChangeActor } from './services/contact-change.service';
import {
  ConfirmEmailChangeSchema,
  RequestEmailChangeSchema,
  RequestPhoneChangeSchema,
} from './user.validator';

/**
 * Self-service contact change — the HTTP surface (Phase 6 · 6.D.1).
 *
 * Split from `UserController` rather than added to it because the two halves of this flow
 * do not share a guard: the five verbs below are mounted under `/api/me` behind
 * `requireAuth`, while `confirmEmail` is mounted on the **auth** router with none. Keeping
 * them in one file is what makes that asymmetry visible in one place — see `confirmEmail`
 * for why it must be reachable without a session.
 */

/** The caller, resolved from the verified token. Never from a body. */
function actorFrom(req: Request): ContactChangeActor {
  return {
    userId: req.auth!.user._id.toString(),
    role: req.auth!.role,
    roleEntityId: req.auth!.role_entity._id.toString(),
  };
}

export class ContactChangeController {
  /** GET /api/me/contact — what the account signs in with, and what is in flight. */
  static getState = asyncHandler(async (req: Request, res: Response) => {
    const state = await contactChangeService.getState(req.auth!.user._id.toString());
    sendSuccess(res, state);
  });

  /** PATCH /api/me/email — open a change. `login_email` does not move here. */
  static requestEmail = asyncHandler(async (req: Request, res: Response) => {
    const input = RequestEmailChangeSchema.parse(req.body);
    const pending = await contactChangeService.requestEmailChange(actorFrom(req), input.email);

    sendSuccess(res, { pendingEmail: pending }, { message: 'Check the new address for a confirmation link. Until you confirm it, you still sign in with your current email.' });
  });

  /**
   * POST /api/auth/email-change/confirm — spend the token.
   *
   * ⚠ **No `requireAuth`, deliberately.** The link is read in a mail client, which is
   * routinely not the browser that started the change and often not on the same device.
   * Requiring a session would make the flow fail for exactly the people it is for. The
   * token is the credential and it names the account; this handler reads no `req.auth`,
   * and the service it calls takes no actor.
   *
   * Mounted on the auth router so it inherits the credential rate-limit bucket — it spends
   * a bearer secret, which is what that bucket is for. `rate-limit/auth-paths.ts` is an
   * allowlist, so not naming it there is how it gets the strict counter.
   */
  static confirmEmail = asyncHandler(async (req: Request, res: Response) => {
    const input = ConfirmEmailChangeSchema.parse(req.body);
    const result = await contactChangeService.confirmEmailChange(input.token);

    sendSuccess(res, result, { message: 'Your email address has been changed. Use it to sign in from now on.' });
  });

  /** DELETE /api/me/email/pending — abandon a change. */
  static cancelEmail = asyncHandler(async (req: Request, res: Response) => {
    await contactChangeService.cancelPending(actorFrom(req), 'email');
    sendSuccess(res, null, { message: 'The pending email change has been cancelled.' });
  });

  /** PATCH /api/me/phone — open a change. `login_phone` does not move here. */
  static requestPhone = asyncHandler(async (req: Request, res: Response) => {
    const input = RequestPhoneChangeSchema.parse(req.body);
    const pending = await contactChangeService.requestPhoneChange(actorFrom(req), input.phone);

    // The storefront confirms with a WhatsApp CODE (`/phone/verify/*`), not by messaging the bot
    // from the new number — owner decision 2026-09-21. The copy points at the code.
    sendSuccess(res, { pendingPhone: pending }, { message: 'Confirm the change with the code we send to that number on WhatsApp. Until you do, you still sign in with your current number.' });
  });

  /**
   * POST /api/me/phone/confirm — complete a change, once the number is proved.
   *
   * Authenticated, unlike the email confirm, and takes no body: there is no token to
   * present. The proof is a property of the account (a WhatsApp connection whose identity
   * is the pending number), so the session is what makes it lookupable at all.
   */
  static confirmPhone = asyncHandler(async (req: Request, res: Response) => {
    const result = await contactChangeService.confirmPhoneChange(actorFrom(req));
    sendSuccess(res, result, { message: 'Your phone number has been changed. Use it to sign in from now on.' });
  });

  /** DELETE /api/me/phone/pending — abandon a change. */
  static cancelPhone = asyncHandler(async (req: Request, res: Response) => {
    await contactChangeService.cancelPending(actorFrom(req), 'phone');
    sendSuccess(res, null, { message: 'The pending phone change has been cancelled.' });
  });
}
