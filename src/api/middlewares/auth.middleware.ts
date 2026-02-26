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
 *
 * This dual-source resolution means existing Bearer-token API clients are NOT broken.
 */
function extractToken(req: Request): string | null {
  // 1. Cookie (browser clients with credentials: 'include')
  const cookieToken = req.cookies?.[AUTH_COOKIE.ACCESS];
  if (cookieToken) return cookieToken;

  // 2. Authorization header (mobile apps, API clients, CLI tools)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.split(' ')[1];
  }

  return null;
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized: Missing token' });
    return;
  }

  let payload: AuthUserPayload;

  try {
    payload = jwt.verify(token, process.env.JWT_SECRET || 'secret') as AuthUserPayload;
  } catch (err: any) {
    // Access token is expired — attempt a silent, transparent refresh
    if (err.name === 'TokenExpiredError') {
      const refreshToken = req.cookies?.[AUTH_COOKIE.REFRESH];

      if (!refreshToken) {
        res.status(401).json({ error: 'Unauthorized: Access token expired and no refresh token present' });
        return;
      }

      try {
        const refreshed = await authService.rotateRefreshToken(refreshToken);
        // Issue new access_token cookie transparently
        res.cookie(AUTH_COOKIE.ACCESS, refreshed.accessToken, accessCookieOptions);
        payload = jwt.decode(refreshed.accessToken) as AuthUserPayload;
      } catch {
        res.status(401).json({ error: 'Unauthorized: Session expired, please log in again' });
        return;
      }
    } else {
      // Token is corrupted, tampered, or uses an invalid signature — hard reject
      res.status(401).json({ error: 'Unauthorized: Invalid token' });
      return;
    }
  }

  // 1. Load User
  const user = await userRepo.findById(payload.userId);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized: User not found' });
    return;
  }

  // 2. Load Role Entity
  let entity = null;
  const role = payload.role;

  if (role === 'customer') entity = await customerRepo.findByUserId(user.id);
  else if (role === 'vendor') entity = await vendorRepo.findByUserId(user.id);
  else if (role === 'agency') entity = await agencyRepo.findByUserId(user.id);
  else if (role === 'agent') entity = await agentRepo.findByUserId(user.id);
  else if (role === 'admin') entity = await adminRepo.findByUserId(user.id);

  if (!entity) {
    res.status(401).json({ error: 'Unauthorized: Role profile not found' });
    return;
  }

  // 3. Attach to Request
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
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Forbidden: Insufficient permissions' });
      return;
    }
    next();
  };
};
