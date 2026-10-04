import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess } from '../../core/responses';
import { actorFromRequest } from '../../core/types/actor-source.types';
import { clearAuthCookies } from '../../config/cookie.config';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { roleClosureService } from './services/role-closure.service';
import { toAdminRoleClosureDto, toSelfRoleClosureDto } from './role-closure.dto';
import { isClosableRole, ClosableRole } from './role-closure.types';
import {
  ConfirmRoleClosureSchema,
  DeclineRoleClosureSchema,
  RequestRoleClosureSchema,
  RoleClosureParamsSchema,
  RoleClosureUserParamsSchema,
} from './role-closure.validators';

/**
 * Two doors onto one lifecycle (ADR-A10):
 *
 *   `/api/internal/admin/users/:userId/...`  wi-admin, behind `requireAdminCaller` —
 *                                            request, cancel, list. Never confirm.
 *   `/api/me/closure-request...`             the account owner, behind `requireAuth`,
 *                                            signed in AS the role — read, confirm, decline.
 *
 * There is deliberately no admin confirm: the whole point of the request is that the person
 * whose role it is agrees to it (owner decision O-3).
 */
export class RoleClosureAdminController {
  /** POST /users/:userId/roles/:role/closure — body `{ reason }`. 201 with the request. */
  static request = asyncHandler(async (req: Request, res: Response) => {
    const { userId, role } = RoleClosureParamsSchema.parse(req.params);
    const { reason } = RequestRoleClosureSchema.parse(req.body);
    const request = await roleClosureService.request({ userId, role, reason, actor: actorFromRequest(req) });
    sendSuccess(res, toAdminRoleClosureDto(request), {
      status: 201,
      message: 'Closure requested — the user has been asked to confirm',
    });
  });

  /** DELETE /users/:userId/roles/:role/closure — withdraw the pending request. */
  static cancel = asyncHandler(async (req: Request, res: Response) => {
    const { userId, role } = RoleClosureParamsSchema.parse(req.params);
    const request = await roleClosureService.cancel(userId, role, actorFromRequest(req));
    sendSuccess(res, toAdminRoleClosureDto(request), { message: 'Closure request withdrawn' });
  });

  /** GET /users/:userId/closure-requests — every request for the account, newest first. */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const { userId } = RoleClosureUserParamsSchema.parse(req.params);
    const requests = await roleClosureService.listForUser(userId);
    sendSuccess(res, requests.map(toAdminRoleClosureDto));
  });
}

/** The caller's identity, from the session — never from the body or the path. */
function callerOf(req: Request): { userId: string; role: ClosableRole; roleEntityId: string } {
  const role = req.auth!.role;
  if (!isClosableRole(role)) {
    throw createAppError(ERROR_CODES.ROLE_CLOSURE_REQUEST_NOT_FOUND, 404, undefined, { role });
  }
  return {
    userId: req.auth!.user._id.toString(),
    role,
    roleEntityId: req.auth!.role_entity._id.toString(),
  };
}

export class RoleClosureSelfController {
  /**
   * GET /api/me/closure-request — the pending request for the role signed in, or `null`.
   * `data: null` rather than a 404: "nothing is waiting" is the ordinary answer.
   */
  static get = asyncHandler(async (req: Request, res: Response) => {
    const { userId, role, roleEntityId } = callerOf(req);
    const found = await roleClosureService.getForCaller(userId, role, roleEntityId);
    sendSuccess(res, found ? toSelfRoleClosureDto(found.request, found.blockers) : null);
  });

  /**
   * POST /api/me/closure-request/confirm — body `{ "confirm": "CLOSE MY ACCOUNT" }`.
   *
   * The session that confirmed is for a role that no longer exists, so its cookies are
   * cleared on the way out — the same client-side half `UserController.closeAccount` does.
   * A bearer client discards its own pair. The person signs back in with a remaining role,
   * if they have one (`data.outcome.accountClosed` says whether they do).
   */
  static confirm = asyncHandler(async (req: Request, res: Response) => {
    ConfirmRoleClosureSchema.parse(req.body);
    const { userId, role, roleEntityId } = callerOf(req);
    const { request } = await roleClosureService.confirm(userId, role, roleEntityId);
    clearAuthCookies(res);
    sendSuccess(res, toSelfRoleClosureDto(request, null), { message: 'Closed' });
  });

  /** POST /api/me/closure-request/decline — body `{ note? }`. Nothing about the role changes. */
  static decline = asyncHandler(async (req: Request, res: Response) => {
    const { note } = DeclineRoleClosureSchema.parse(req.body ?? {});
    const { userId, role, roleEntityId } = callerOf(req);
    const request = await roleClosureService.decline(userId, role, roleEntityId, note ?? null);
    sendSuccess(res, toSelfRoleClosureDto(request, null), { message: 'Closure declined' });
  });
}
