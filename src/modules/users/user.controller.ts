import { Request, Response } from 'express';
import { UserService } from './user.service';
import { UpdatePasswordSchema } from './user.validator';
import { asyncHandler } from '../../api/middlewares/async-handler';

const userService = new UserService();

/**
 * User Account Controller
 *
 * Role-agnostic account endpoints (mounted at /api/me). The password lives on
 * the User model, not on any role entity, so changing it is the same operation
 * for every role — the owner is resolved from req.auth, like /me/payment-methods.
 */
export class UserController {
  static updatePassword = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user._id.toString();
    const input = UpdatePasswordSchema.parse(req.body);
    await userService.changePassword(userId, input.oldPassword, input.newPassword, {
      role: req.auth!.role,
      roleEntityId: req.auth!.role_entity._id.toString(),
    });
    res.json({ success: true, message: 'Password updated successfully.' });
  });
}
