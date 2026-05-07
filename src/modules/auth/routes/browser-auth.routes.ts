import { Router } from 'express';
import { BrowserAuthController } from '../controllers/browser-auth.controller';
import { requireJsonContent } from '../../../api/middlewares/session.middleware';

const router = Router();
const controller = new BrowserAuthController();

/**
 * Browser auth routes mounted at /api/auth/browser/*
 * These mirror the main /api/auth/* endpoints but exist in a
 * parallel namespace to support OAuth redirect flows that need a
 * stable login URL for browser-based clients.
 *
 * All routes use requireJsonContent for CSRF mitigation:
 * browsers cannot send application/json cross-origin without CORS preflight.
 */

/** POST /api/auth/browser/login — issue JWT cookies for browser clients */
router.post('/login', requireJsonContent, (req, res, next) => controller.login(req, res, next));

/** POST /api/auth/browser/refresh — issue new access_token cookie */
router.post('/refresh', requireJsonContent, (req, res, next) => controller.refresh(req, res, next));

/** POST /api/auth/browser/logout — clear both auth cookies */
router.post('/logout', requireJsonContent, (req, res, next) => controller.logout(req, res, next));

export const browserAuthRoutes = router;
