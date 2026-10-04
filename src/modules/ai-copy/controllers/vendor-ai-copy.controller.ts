import { Request, Response } from 'express';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { sendSuccess } from '../../../core/responses';
import { AiCopyRequestSchema } from '../validators/ai-copy.validator';
import { aiCopyService } from '../services/ai-copy.service';

export class VendorAiCopyController {
  /**
   * POST /api/vendor/ai/listing-copy — write a listing's description, tags, SEO fields
   * and/or categories from its name, photos and the vendor's notes. Saves nothing.
   * Contract: api-doc/vendor/ai-listing-copy.md.
   */
  static generate = asyncHandler(async (req: Request, res: Response) => {
    const body = AiCopyRequestSchema.parse(req.body);
    const vendorId = req.auth!.role_entity._id.toString();
    const data = await aiCopyService.generate(vendorId, body);
    sendSuccess(res, data);
  });
}
