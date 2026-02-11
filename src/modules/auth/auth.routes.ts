import { Router } from 'express';
import { AuthController } from './auth.controller';
import { requireAuth } from '../../api/middlewares/auth.middleware';

const router = Router();

router.post('/register', AuthController.register);
router.post('/login', AuthController.login);
router.get('/me', requireAuth, AuthController.me);
router.post('/send-email-verification', requireAuth, AuthController.sendEmailVerification);
router.get('/verify-email', AuthController.verifyEmail);
router.post('/request-wa-verification', requireAuth, AuthController.requestWaVerification);

export { router as authRouter };
