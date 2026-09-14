import { Router } from 'express';
import { requireAuth, requireRole } from '../../../api/middlewares/auth.middleware';
import { KycRole } from '../domain/kyc-subject';
import { KycController, uploadKycDocuments } from '../controllers/kyc.controller';

/**
 * `/api/{vendor,agency,agent}/kyc` — the applicant's half of identity verification.
 *
 * ── A FACTORY, and why it cannot be one shared Router instance ────────────────
 * A single `Router` cannot be mounted twice: its `router.use` guards would re-run, so the
 * agent mount would be guarded by `requireRole(['vendor'])` as well. That is the same reason
 * `buildAdminCodRouter(guards)` takes its guard chain as a parameter, and the shape to follow
 * when a fourth role wants this surface.
 *
 * ── There is NO id in any path here ──────────────────────────────────────────
 * Every route is scoped to `req.auth.role_entity._id`. A `:vendorId` would be an
 * authorization decision to get right on a surface whose payload is a photograph of somebody
 * holding their identity card, and there is no caller who needs one — an administrator reads
 * this through wi-admin, over the internal route.
 *
 * ── Route order ──────────────────────────────────────────────────────────────
 * `/documents/:fileId/content` is declared ABOVE `/documents/:slot` and below nothing that
 * could shadow it: three path segments against two, so Express separates them. Keep any new
 * literal above the parameterised siblings — this service has been bitten by route order
 * twice.
 */
export function buildKycRouter(role: KycRole): Router {
    const router = Router();
    const controller = KycController.build(role);

    router.use(requireAuth);
    router.use(requireRole([role]));

    /** The whole record — the documents, the addresses, the verdict. */
    router.get('/', controller.get);

    /**
     * The typed half: the identity number and the geocoded home address.
     *
     * PATCH rather than PUT, and both fields `clearable`: an applicant who typed the wrong
     * number must be able to take it back rather than blank it with a space.
     */
    router.patch('/', controller.updateDetails);

    /**
     * Read back one of the caller's OWN documents.
     *
     * Declared before `/documents/:slot` so `content` is never parsed as a slot. The `kyc/`
     * tree is off `express.static`, so this is the applicant's only door to the bytes — a
     * `FileDetail` from the read above carries `url: null` by construction.
     */
    router.get('/documents/:fileId/content', controller.content);

    /**
     * Upload to a slot. Multipart, field name `documents`.
     *
     * A single-value slot replaces; a multi-value slot appends up to the cap. The slot
     * vocabulary is narrowed to this role's, so an agent naming `store_address_sketch` gets a
     * 400 listing the slots they do have rather than a 200 that stored nothing.
     */
    router.post('/documents/:slot', uploadKycDocuments, controller.attach);

    /** Remove one file from a slot. */
    router.delete('/documents/:slot/:fileId', controller.detach);

    /**
     * Hand the record to the reviewers — and freeze it.
     *
     * ⚠ Accepts an empty record, deliberately. The backend grades nothing here; the
     * administration dashboard computes the estimated verdict and the reviewer decides. See
     * `core/types/kyc-documents.types.ts`.
     */
    router.post('/submit', controller.submit);

    return router;
}
