import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { normalizeReferralCode } from '../domain/referral-rules';
import { referralLinksOf } from '../dto/referral-partner.dto';
import { ReferralPartnerModel } from '../models/referral-partner.model';
import { referralSettingsService } from '../services/referral-settings.service';

/**
 * `GET /api/public/referral/:code`: what the page behind a referral link needs in order to send a
 * customer to the bot with the code in place (customers register there, not on a form).
 *
 * ⛔ **No authentication, so it says nothing about the partner**: not a name, not a status. `valid`
 * only decides whether the links carry the code. A suspended partner's link answers `valid: false`
 * and the person registers normally, as the owner's document requires.
 */
const router = Router();

router.get(
  '/referral/:code',
  asyncHandler(async (req: Request, res: Response) => {
    const code = normalizeReferralCode(req.params.code);
    const settings = await referralSettingsService.get();
    const valid = !!code && settings.enabled && !!(await ReferralPartnerModel.exists({ code, status: 'active' }));
    sendSuccess(res, { valid, code: valid ? code : null, ...referralLinksOf(valid ? code : null) });
  })
);

export default router;
