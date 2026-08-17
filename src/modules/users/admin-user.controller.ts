import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { actorFromRequest } from '../../core/types/actor-source.types';
import { adminCallerActor } from '../../api/middlewares/admin-caller.middleware';
import { adminCredentialDeliveryService } from '../messaging-login/services/admin-credential-delivery.service';
import { AdminUserService, toAdminUserDto } from './admin-user.service';
import {
  AdminSendCredentialSchema,
  AdminSuspendUserSchema,
  AdminUpdateUserContactSchema,
} from './admin-user.validator';

/**
 * Platform-user administration, for the wi-admin backend.
 *
 * Reads are deliberately absent: wi-admin queries `users` directly, because a read
 * protects no invariant and routing it through here would put an HTTP hop in front of a
 * `find()`. Only the three writes live here — the operations whose meaning is bound up
 * with this service's auth path.
 */

const adminUserService = new AdminUserService();

export class AdminUserController {
  /**
   * PATCH /users/:userId — change the login identifiers.
   *
   * Answers the whole user, not just the changed fields: the caller needs the resulting
   * state to render, and returning a partial forces it to re-read what it just wrote.
   */
  static updateContact = asyncHandler(async (req: Request, res: Response) => {
    const input = AdminUpdateUserContactSchema.parse(req.body);
    const user = await adminUserService.updateContact(req.params.userId, input);

    sendSuccess(res, toAdminUserDto(user), { message: 'User contact details updated' });
  });

  /** POST /users/:userId/suspend — body `{ reason }`. */
  static suspend = asyncHandler(async (req: Request, res: Response) => {
    const input = AdminSuspendUserSchema.parse(req.body);
    const user = await adminUserService.suspend(
      req.params.userId,
      input.reason,
      // The administrator's id comes from `X-Actor-Id` and belongs to the wi-admin
      // database, so the stamp records `source: 'admin'` and snapshots the name — a
      // cross-database join to resolve it does not exist and never will.
      actorFromRequest(req)
    );

    sendSuccess(res, toAdminUserDto(user), { message: 'Account suspended' });
  });

  /** POST /users/:userId/restore — lift a suspension. */
  static restore = asyncHandler(async (req: Request, res: Response) => {
    const user = await adminUserService.restore(req.params.userId);

    sendSuccess(res, toAdminUserDto(user), { message: 'Account restored' });
  });

  /**
   * POST /users/:userId/password-reset-link — body `{ channel }`.
   *
   * Sends the party a link to set a new password. Any role: a password belongs to the
   * `users` row, and vendors and agencies are precisely the people who have one to forget.
   *
   * The response is deliberately thin — channel, a MASKED destination, and the two
   * timestamps. It carries no token and no link, because an operator who could read one
   * could use it.
   */
  static sendPasswordResetLink = asyncHandler(async (req: Request, res: Response) => {
    const { channel } = AdminSendCredentialSchema.parse(req.body);

    const result = await adminCredentialDeliveryService.send(
      'password_reset',
      req.params.userId,
      channel,
      // The wi-admin administrator id from `X-Actor-Id`. It resolves in no collection
      // here — it is used only to key the per-operator rate limit.
      adminCallerActor(req)?.id ?? null
    );

    sendSuccess(res, result, { message: `Password-reset link sent by ${channel}` });
  });

  /**
   * POST /users/:userId/login-link — body `{ channel }`.
   *
   * Sends a customer a way to sign in without a password. **Customers only**, and the
   * refusal for everybody else is `USER_LOGIN_LINK_ROLE_UNSUPPORTED` rather than a silent
   * downgrade: a session for a vendor or an agency reaches money and other people's data,
   * and no administrator gets to mint one on their behalf.
   */
  static sendLoginLink = asyncHandler(async (req: Request, res: Response) => {
    const { channel } = AdminSendCredentialSchema.parse(req.body);

    const result = await adminCredentialDeliveryService.send(
      'login',
      req.params.userId,
      channel,
      adminCallerActor(req)?.id ?? null
    );

    sendSuccess(res, result, { message: `Sign-in link sent by ${channel}` });
  });
}
