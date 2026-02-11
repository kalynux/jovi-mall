import { Router } from 'express';
import { BrowserAuthController } from '../controllers/browser-auth.controller';
import { requireJsonContent } from '../../../api/middlewares/session.middleware';

const router = Router();
const controller = new BrowserAuthController();

/**
 * POST /auth/browser/login
 * Browser-only login with cookie-based sessions
 */
router.post('/login', requireJsonContent, (req, res) => controller.login(req, res));

/**
 * POST /auth/browser/logout
 * Destroys session and clears cookie
 */
router.post('/logout', requireJsonContent, (req, res) => controller.logout(req, res));

export const browserAuthRoutes = router;
