import { Request, Response } from 'express';
import multer from 'multer';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { CodCashProofFileInput } from '../services/cod-cash-proof.service';

/**
 * The HTTP half of a COD cash proof, shared by the agent's deposit declaration and the
 * agency's remittance declaration.
 *
 * Both declarations are `multipart/form-data`: the image in field `file`, the other fields
 * beside it as text. The 20 MB ceiling only protects process memory; the real per-image cap
 * (10 MB, jpeg/png/webp) is the upload pipeline's (`getCodCashProofUploadConfig`), which
 * answers a clean policy violation.
 */
export const uploadCodCashProof = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 20 * 1024 * 1024 },
}).single('file');

/**
 * The proof from the request, or `400 COD_PROOF_FILE_REQUIRED`.
 *
 * multer passes a JSON request through untouched, so a client still sending the pre-proof
 * JSON body lands here with no file and is told exactly what is missing.
 */
export function requireCodCashProof(req: Request): CodCashProofFileInput {
  if (!req.file) {
    throw createAppError(
      ERROR_CODES.COD_PROOF_FILE_REQUIRED,
      400,
      'A proof image is required — send the request as multipart/form-data with the image in field "file"'
    );
  }
  return { buffer: req.file.buffer, originalName: req.file.originalname, mimeType: req.file.mimetype };
}

/**
 * Stream a proof's bytes. `inline` because it is looked at on a confirm screen, and
 * `no-store` because a receipt is not something any cache should keep.
 */
export function sendCodCashProof(
  res: Response,
  proof: { stream: NodeJS.ReadableStream; mimeType: string; size: number; filename: string }
): void {
  res.setHeader('Content-Type', proof.mimeType);
  res.setHeader('Content-Length', String(proof.size));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(proof.filename)}"`);
  res.setHeader('Cache-Control', 'private, no-store');

  proof.stream.pipe(res);
  proof.stream.on('error', () => {
    // Headers are already out; destroying is what tells the client the image is incomplete.
    res.destroy();
  });
}
