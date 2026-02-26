import { Router } from 'express';
import { AuthController } from './auth.controller';
import { requireAuth } from '../../api/middlewares/auth.middleware';

const router = Router();

// ─── Public ──────────────────────────────────────────────────────────────────
router.post('/register', AuthController.register);
router.post('/login', AuthController.login);
router.get('/verify-email', AuthController.verifyEmail);

// ─── Cookie Token Management ─────────────────────────────────────────────────
/** Clear both auth cookies (always succeeds) */
router.post('/logout', AuthController.logout);

// ─── Authenticated ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, AuthController.me);
router.get('/auth-me/:role', requireAuth, AuthController.authMe);
router.post('/add-role', requireAuth, AuthController.addRole);
router.post('/send-email-verification', requireAuth, AuthController.sendEmailVerification);
router.post('/request-wa-verification', requireAuth, AuthController.requestWaVerification);

export { router as authRouter };
