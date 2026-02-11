import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AuthService } from './auth.service';
import { LoginSchema, RegisterSchema } from './auth.schemas';

const authService = new AuthService();

export class AuthController {
  static async register(req: Request, res: Response) {
    try {
      const input = RegisterSchema.parse(req.body);
      const result = await authService.register(input);
      res.status(201).json(result);
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
      const result = await authService.login(input);
      res.status(200).json(result);
    } catch (error: any) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: 'Validation Error', details: error.errors });
        return;
      }
      res.status(401).json({ error: error.message });
    }
  }

  static async me(req: Request, res: Response) {
    // Current user is attached by middleware
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    res.status(200).json({ user });
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
