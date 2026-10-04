import sharp from 'sharp';
import { Types } from 'mongoose';
import { FileModel } from '../../catalog/models/file.model';
import { getStorageProvider } from '../../../core/storage';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { aiCopyConfig } from '../../../config/ai-copy.config';

/**
 * Load the vendor's chosen photos and shrink them for the model.
 *
 * ⚠ The photos usually come from a brand-new upload that no product uses yet — the vendor
 * picks them in the popup BEFORE the product exists. So "in use" is deliberately not
 * checked: ownership, not attachment, is the rule.
 *
 * Every check runs BEFORE the charge, so a bad photo costs the vendor nothing.
 *
 * Why shrink here rather than send a URL: the CDN serves originals (no resizing), and a phone
 * photo is 3–5 MB. 1024 px on the long side as JPEG is ~100–200 KB, carries everything the
 * model can use, and keeps image tokens — the bulk of this call's cost — predictable. Measured
 * 2026-10-04 on the dev laptop with a worst-case 8.3 MB 4000×3000 JPEG (pure noise, so nothing
 * compresses): 174 ms for one, 243 ms for four in parallel. Not re-measured on the 2-vCPU VPS;
 * expect a small multiple of that — still well under a second against 5–15 s in the model.
 */
export async function loadImagesForModel(vendorId: string, fileIds: string[]): Promise<string[]> {
  const rows = await FileModel.find({
    _id: { $in: fileIds.map((id) => new Types.ObjectId(id)) },
  })
    .select('_id key mimeType size ownerType ownerId deletedAt')
    .lean();
  const byId = new Map(rows.map((r) => [r._id.toString(), r]));

  const invalid = (fileId: string, reason: string) =>
    createAppError(ERROR_CODES.AI_COPY_IMAGE_INVALID, 422, undefined, { fileId, reason });

  // Validate every row first, so a bad id is reported before any bytes are fetched.
  for (const id of fileIds) {
    const f = byId.get(id);
    // "Not yours" and "does not exist" answer the same, so the route cannot be used to probe
    // other vendors' file ids.
    if (!f || f.ownerType !== 'vendor' || String(f.ownerId) !== vendorId) throw invalid(id, 'not_found');
    if (f.deletedAt) throw invalid(id, 'deleted');
    if (!String(f.mimeType || '').startsWith('image/')) throw invalid(id, 'not_an_image');
    if ((f.size ?? 0) > aiCopyConfig.imageMaxSourceBytes) throw invalid(id, 'too_large');
  }

  const storage = getStorageProvider();
  return Promise.all(
    fileIds.map(async (id) => {
      const f = byId.get(id)!;
      try {
        const bytes = await storage.getBuffer(f.key);
        const jpeg = await sharp(bytes, { limitInputPixels: 50_000_000 })
          .rotate() // honour EXIF orientation before it is stripped
          .resize(aiCopyConfig.imageMaxSide, aiCopyConfig.imageMaxSide, { fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }) // transparent PNGs would turn black in JPEG
          .jpeg({ quality: 80 })
          .toBuffer();
        return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
      } catch {
        throw invalid(id, 'unreadable');
      }
    }),
  );
}
