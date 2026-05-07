import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRepository } from '../../modules/users/user.repository';
import { CustomerRepository } from '../../modules/customers/customer.repository';
import { VendorRepository } from '../../modules/vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../modules/delivery/delivery-agency.repository';
import { DeliveryAgentRepository } from '../../modules/delivery/delivery-agent.repository';
import { AdminRepository } from '../../modules/admins/admin.repository';
import { AUTH_COOKIE, accessCookieOptions } from '../../config/cookie.config';
import { AuthService } from '../../modules/auth/auth.service';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

// Module-level singletons
const userRepo = new UserRepository();
const customerRepo = new CustomerRepository();
const vendorRepo = new VendorRepository();
const agencyRepo = new DeliveryAgencyRepository();
const agentRepo = new DeliveryAgentRepository();
const adminRepo = new AdminRepository();
const authService = new AuthService();

export interface AuthUserPayload {
  userId: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: {
        user: import('../../modules/users/user.model').IUser;
        role: string;
        role_entity: any;
      };
      // Deprecated aliases kept for backward compatibility
      user?: import('../../modules/users/user.model').IUser;
      role?: string;
    }
  }
}

/**
 * Resolves a JWT access token from:
 *   1. `access_token` httpOnly cookie (preferred, for browser clients)
 *   2. `Authorization: Bearer <token>` header (fallback, for API / mobile clients)
 */
function extractToken(req: Request): string | null {
  const cookieToken = req.cookies?.[AUTH_COOKIE.ACCESS];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  return null;
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
  }

  let payload: AuthUserPayload;

  try {
    payload = jwt.verify(token, process.env.JWT_SECRET || 'secret') as AuthUserPayload;
  } catch (err: any) {
    // Access token is expired — attempt a silent, transparent refresh
    if (err.name === 'TokenExpiredError') {
      const refreshToken = req.cookies?.[AUTH_COOKIE.REFRESH];

      if (!refreshToken) {
        return next(createAppError(ERROR_CODES.AUTH_TOKEN_EXPIRED, 401));
      }

      try {
        const refreshed = await authService.rotateRefreshToken(refreshToken);
        // Issue new access_token cookie transparently
        res.cookie(AUTH_COOKIE.ACCESS, refreshed.accessToken, accessCookieOptions);
        payload = jwt.decode(refreshed.accessToken) as AuthUserPayload;
      } catch {
        return next(createAppError(ERROR_CODES.AUTH_SESSION_EXPIRED, 401));
      }
    } else {
      // Token is corrupted, tampered, or uses an invalid signature
      return next(createAppError(ERROR_CODES.AUTH_TOKEN_INVALID, 401));
    }
  }

  // Load User
  const user = await userRepo.findById(payload.userId);
  if (!user) {
    return next(createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 401));
  }

  // Load Role Entity
  let entity = null;
  const role = payload.role;

  if (role === 'customer') entity = await customerRepo.findByUserId(user.id);
  else if (role === 'vendor') entity = await vendorRepo.findByUserId(user.id);
  else if (role === 'agency') entity = await agencyRepo.findByUserId(user.id);
  else if (role === 'agent') entity = await agentRepo.findByUserId(user.id);
  else if (role === 'admin') entity = await adminRepo.findByUserId(user.id);

  if (!entity) {
    return next(createAppError(ERROR_CODES.AUTH_ROLE_PROFILE_NOT_FOUND, 401));
  }

  // Attach to Request
  req.auth = { user, role, role_entity: entity };

  // Backward compatibility aliases
  req.user = user;
  req.role = role;
  (req as any).role_entity = entity;

  next();
};

export const requireRole = (allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth?.role) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }

    if (!allowedRoles.includes(req.auth.role)) {
      return next(createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, 'Insufficient permissions', {
        required: allowedRoles,
        actual: req.auth.role,
      }));
    }
    next();
  };
};
