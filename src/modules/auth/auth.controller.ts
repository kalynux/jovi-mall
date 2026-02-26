import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AuthService } from './auth.service';
import { LoginSchema, RegisterSchema, AddRoleSchema, AuthMeSchema } from './auth.schemas';
import {
  AUTH_COOKIE,
  accessCookieOptions,
  refreshCookieOptions,
  clearCookieOptions,
} from '../../config/cookie.config';

const authService = new AuthService();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(AUTH_COOKIE.ACCESS, accessToken, accessCookieOptions);
  res.cookie(AUTH_COOKIE.REFRESH, refreshToken, refreshCookieOptions);
}

function clearAuthCookies(res: Response) {
  res.clearCookie(AUTH_COOKIE.ACCESS, clearCookieOptions);
  res.clearCookie(AUTH_COOKIE.REFRESH, clearCookieOptions);
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class AuthController {

  static async register(req: Request, res: Response) {
    try {
      const input = RegisterSchema.parse(req.body);
      const { user, role, role_entity, accessToken, refreshToken, ...rest } = await authService.register(input);

      setAuthCookies(res, accessToken, refreshToken);

      res.status(201).json({ user, role, role_entity });
    } catch (error: any) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: 'Validation Error', details: error.errors });
        return;
      }
      res.status(400).json({ error: error.message });
    }
  }

  static async login(req: Request, res: Response) {
    try {
      const input = LoginSchema.parse(req.body);
      const { user, role, role_entity, accessToken, refreshToken } = await authService.login(input);

      setAuthCookies(res, accessToken, refreshToken);

      // Return user payload — no tokens in body
      res.status(200).json({ user, role, role_entity });
    } catch (error: any) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: 'Validation Error', details: error.errors });
        return;
      }
      res.status(401).json({ error: error.message });
    }
  }

  /**
   * POST /api/auth/logout
   * Clears both auth cookies. Client must also discard any in-memory tokens.
   */
  static async logout(req: Request, res: Response) {
    clearAuthCookies(res);
    res.status(200).json({ success: true, message: 'Logged out successfully' });
  }

  static async me(req: Request, res: Response) {
    const user = (req as any).auth?.user;
    const role = (req as any).auth?.role;
    const role_entity = (req as any).auth?.role_entity;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.status(200).json({ user, role, role_entity });
  }

  static async authMe(req: Request, res: Response) {
    try {
      const userId = req.auth?.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const { role } = req.params;
      const input = AuthMeSchema.parse({ userId, role });
      const { user, role: resolvedRole, role_entity, accessToken, refreshToken } = await authService.authMe(input);

      // Re-issue cookies scoped to chosen role
      setAuthCookies(res, accessToken, refreshToken);

      res.status(200).json({ user, role: resolvedRole, role_entity });
    } catch (error: any) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: 'Validation Error', details: error.errors });
        return;
      }
      res.status(401).json({ error: error.message });
    }
  }

  static async addRole(req: Request, res: Response) {
    try {
      const userId = req.auth?.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const input = AddRoleSchema.parse(req.body);
      const { user, role, role_entity, accessToken, refreshToken } = await authService.addRole(userId, input);

      // Issue cookies scoped to the newly added role
      setAuthCookies(res, accessToken, refreshToken);

      res.status(201).json({ user, role, role_entity });
    } catch (error: any) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: 'Validation Error', details: error.errors });
        return;
      }
      res.status(400).json({ error: error.message });
    }
  }

  static async sendEmailVerification(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const role = (req as any).role;
      if (!user || !role) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await authService.sendEmailVerification(user.userId, role);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async verifyEmail(req: Request, res: Response) {
    try {
      const { token } = req.query;
      if (!token || typeof token !== 'string') {
        res.status(400).json({ error: 'Missing token' });
        return;
      }
      const result = await authService.verifyEmail(token);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }

  static async requestWaVerification(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      const role = (req as any).role;
      if (!user || !role) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const { wa_phone_id } = req.body;
      if (!wa_phone_id) {
        res.status(400).json({ error: 'wa_phone_id is required' });
        return;
      }

      const result = await authService.issueWaVerificationCode(user.userId, role, wa_phone_id);
      res.status(200).json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  }
}
