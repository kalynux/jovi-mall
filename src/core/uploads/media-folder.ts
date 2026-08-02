import {
  MediaCategory,
  resolveMediaCategory,
} from '../../modules/catalog/domain/services/media/media-category';
import { TypeUploadFolder } from './upload-policy.types';

/**
 * Media-type → storage folder.
 *
 * A mechanical mapping onto `MediaCategory` (the same taxonomy that backs
 * `GET /api/files?category=` and the storage-usage breakdown), so a file's
 * folder and its reported category can never disagree. `videos` predates this
 * map — the dedicated video route already wrote there — and is kept as-is.
 */
export const MEDIA_CATEGORY_FOLDERS: Record<MediaCategory, TypeUploadFolder> = {
  image: 'images',
  video: 'videos',
  audio: 'audio',
  document: 'documents',
  archive: 'archives',
  other: 'other',
};

/**
 * Resolve the folder a file belongs in from its own MIME type.
 *
 * Pass the **sniffed** type (`FileContext.mimeType` after the pipeline's
 * processors have run), never the client-claimed one — a spoofed `.jpg` must be
 * filed as whatever it actually is, and a converted png→webp must land in the
 * folder for the bytes actually stored.
 */
export function resolveTypeFolder(mimeType: string): TypeUploadFolder {
  return MEDIA_CATEGORY_FOLDERS[resolveMediaCategory(mimeType)];
}
