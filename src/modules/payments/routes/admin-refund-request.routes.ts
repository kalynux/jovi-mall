import { RequestHandler, Router } from 'express';
import multer from 'multer';
import { AdminRefundRequestController } from '../controllers/admin-refund-request.controller';

/**
 * Multer's ceilings protect PROCESS MEMORY (the file is buffered whole) and are not the policy.
 * The policy — MIME types, transforms, the virus scan — is `getRefundProofUploadConfig()`, applied
 * inside the intake pipeline. The two must not drift: one file, 10 MB, in both.
 */
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
export const uploadRefundProof = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: MAX_PROOF_BYTES },
}).single('file');

/**
 * `/api/internal/admin/refunds` — the refund queue's writes (REFUND-FLOW-PLAN § 11.7), served to
 * wi-admin only, behind `requireAdminCaller` (passed in as `guards`, the factory shape every
 * internal-admin router follows). Contract: `api-doc/admin/refunds.md`.
 *
 * Route order: the literal `/eligibility` and `/proofs…` paths are declared before the
 * `/:id/<verb>` ones. None of them can collide today (every `:id` route has a second segment),
 * and declaring literals first keeps it that way if a `GET /:id` is ever added.
 *
 * ⚠ The proof upload is `POST /proofs` HERE, never `/files/upload`: that route writes `by-type`,
 * whose trees are all public. `test:refund-admin-api` source-scans for it.
 */
export function buildAdminRefundRequestRouter(guards: RequestHandler[] = []): Router {
  const router = Router();
  if (guards.length > 0) router.use(...guards);

  router.get('/eligibility', AdminRefundRequestController.eligibility);

  router.post('/proofs', uploadRefundProof, AdminRefundRequestController.uploadProof);
  router.get('/proofs/:fileId', AdminRefundRequestController.streamProof);

  router.post('/', AdminRefundRequestController.create);
  router.post('/:id/approve', AdminRefundRequestController.approve);
  router.post('/:id/reject', AdminRefundRequestController.reject);
  router.post('/:id/retry', AdminRefundRequestController.retry);
  router.post('/:id/settle-external', AdminRefundRequestController.settleExternal);
  router.post('/:id/resolve-unknown', AdminRefundRequestController.resolveUnknown);

  return router;
}
