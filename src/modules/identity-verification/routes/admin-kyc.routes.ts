import { Router, RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../api/middlewares/async-handler';
import { KycRole } from '../domain/kyc-subject';
import { kycSubmissionService } from '../services/kyc-submission.service';

const ParamsSchema = z.object({
    role: z.enum(['vendor', 'agency', 'agent']),
    entityId: z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Must be a 24-character hex id'),
});

/**
 * `/api/internal/admin/kyc/:role/:entityId` — what an administrator reviews.
 *
 * ── ⚠ A DELEGATED read, and that is a deliberate exception ───────────────────
 * ADR-004 D-2 says to read a RECORD directly from `jovi_mall` and to delegate only a
 * VERDICT, and wi-admin does exactly that for the rest of the vendor, agency and agent
 * screens. This one is delegated anyway, for two reasons that are specific to it:
 *
 *   **The documents must pass through `toFileDetail`.** Every file here is in the private
 *   `kyc/` tree, and the rule that turns a private key into `url: null, access: 'authorized'`
 *   lives in this service. wi-admin holds a verbatim copy of the tree table for the media
 *   library (BR-015 L-3) and it is kept in step by a cross-repo source scan — an arrangement
 *   whose own header calls it *the price of L-3*. Paying that price twice, for a payload that
 *   is a photograph of somebody's identity card, buys nothing: a stale copy there publishes a
 *   URL to a national ID scan.
 *
 *   **An agency's business addresses are on the MAGAZIN.** Reading the record directly would
 *   mean wi-admin learning a second collection and a join, for one block on one screen — and
 *   getting the Store/Magazin split right in a second place.
 *
 * ── One route, three roles ───────────────────────────────────────────────────
 * `:role` rather than three mounts, mirroring `KYC_SUBJECTS`. The grading — required vs
 * optional, the estimated verdict, the pre-populated rejection reason — is **wi-admin's and
 * its dashboard's**, exactly as the tier ladder is (ADR-016). Nothing here computes a
 * judgement; see `core/types/kyc-documents.types.ts`.
 *
 * ⚠ **Read-only.** The VERDICT is written where it already was — `POST
 * /api/internal/admin/vendors/:id/kyc/{approve,reject}`, the agency verify route, and
 * `PUT /api/internal/admin/agents/:agentId/kyc`. A second write path for the same field is
 * how two endpoints end up disagreeing about what `legit_verified` means.
 */
export function buildAdminKycRouter(guards: RequestHandler[] = []): Router {
    const router = Router();
    if (guards.length > 0) router.use(...guards);

    router.get(
        '/:role/:entityId',
        asyncHandler(async (req, res) => {
            const { role, entityId } = ParamsSchema.parse(req.params);
            const data = await kycSubmissionService.getForReview(role as KycRole, entityId);
            res.json({ success: true, data });
        }),
    );

    return router;
}
