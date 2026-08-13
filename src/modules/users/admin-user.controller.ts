import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { actorFromRequest } from '../../core/types/actor-source.types';
import { AdminUserService, toAdminUserDto } from './admin-user.service';
import { AdminSuspendUserSchema, AdminUpdateUserContactSchema } from './admin-user.validator';

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
}
