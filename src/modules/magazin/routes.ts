import { Router } from 'express';
import { requireAuth, requireRole } from '../../api/middlewares/auth.middleware';
import { MagazinProfileController } from './controller/magazin-profile.controller';

const router = Router();

/**
 * Magazin Profile Routes — the agency's business surface (Store-equivalent).
 *
 * All routes require authentication and the agency role. The agency can only
 * access/modify their own magazin.
 *
 * CRITICAL: No magazinId in routes. Identity flow: token → agency → magazin.
 */
router.use(requireAuth);
router.use(requireRole(['agency']));

/** GET /api/agency/magazin — get authenticated agency's magazin */
router.get('/', MagazinProfileController.getMagazin);

/**
 * PATCH /api/agency/magazin — update authenticated agency's magazin
 *
 * Body: { name?, logoFileId?, description?, supportEmail?, supportPhone?, supportWhatsapp?, version }
 * logoFileId is the id of a file uploaded via POST /api/files/upload ('' or null
 * clears the slot); the response returns the resolved `logo` file object.
 */
router.patch('/', MagazinProfileController.updateMagazin);

export default router;
