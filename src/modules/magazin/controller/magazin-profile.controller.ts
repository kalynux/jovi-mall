import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { MagazinProfileService } from '../service/magazin-profile.service';
import { UpdateMagazinProfileSchema } from '../validators/magazin.validator';

const magazinProfileService = new MagazinProfileService();

/**
 * Magazin Profile Controller
 *
 * HTTP layer for the agency's business surface (Store-equivalent for agencies).
 *
 * SECURITY:
 * - All routes protected by requireAuth + requireRole(['agency']) middleware
 * - Agency can only access their own magazin (extracted from req.auth.role_entity._id)
 * - No magazinId in routes — identity via token → agency → magazin
 */
export class MagazinProfileController {
  /** GET /api/agency/magazin */
  static getMagazin = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const magazin = await magazinProfileService.getMagazin(agencyId);
    res.json({ success: true, data: magazin });
  });

  /** PATCH /api/agency/magazin */
  static updateMagazin = asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const agencyId = req.auth!.role_entity._id.toString();
    const input = UpdateMagazinProfileSchema.parse(req.body);
    const magazin = await magazinProfileService.updateMagazin(agencyId, input);
    res.json({ success: true, data: magazin, message: 'Magazin profile updated successfully' });
  });
}
