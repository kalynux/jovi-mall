/**
 * Media category definitions — single source of truth shared by:
 *  - the file listing/filter endpoint (GET /api/files ?category=) and
 *  - MediaStorageService (storage usage breakdown aggregation).
 *
 * A file's category is derived from its MIME type: image/video/audio match on
 * the MIME prefix; document/archive match a curated set; everything else is
 * `other`.
 */

export type MediaCategory = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'other';

export const MEDIA_CATEGORIES: MediaCategory[] = [
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'other',
];

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'text/plain',
  'text/csv',
  'application/epub+zip',
];

export const ARCHIVE_MIME_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
];

/**
 * MongoDB matchers for filtering a `mimeType` field by broad category. Used as a
 * `$match`/find filter (e.g. `GET /api/files?category=image`).
 */
export const MEDIA_CATEGORY_MATCHERS: Record<MediaCategory, unknown> = {
  image: { $regex: '^image/', $options: 'i' },
  video: { $regex: '^video/', $options: 'i' },
  audio: { $regex: '^audio/', $options: 'i' },
  document: { $in: DOCUMENT_MIME_TYPES },
  archive: { $in: ARCHIVE_MIME_TYPES },
  other: {
    $not: {
      $regex:
        '^(image|video|audio)/|^application/(pdf|msword|rtf|zip|x-zip-compressed|x-rar-compressed|vnd\\.rar|x-7z-compressed|x-tar|gzip|epub\\+zip|vnd\\.(ms-excel|ms-powerpoint|openxmlformats-officedocument\\.(wordprocessingml\\.document|spreadsheetml\\.sheet|presentationml\\.presentation)))$|^text/(plain|csv)$',
      $options: 'i',
    },
  },
};

/**
 * In-process twin of `categorySwitchExpr`: classify a single MIME type.
 * Used by the upload pipeline to pick a file's storage folder from its sniffed
 * type. Branch order MUST match `categorySwitchExpr` below, or a file would be
 * stored under one category and reported under another.
 */
export function resolveMediaCategory(mimeType: string): MediaCategory {
  const mime = (mimeType || '').toLowerCase();

  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (DOCUMENT_MIME_TYPES.includes(mime)) return 'document';
  if (ARCHIVE_MIME_TYPES.includes(mime)) return 'archive';

  return 'other';
}

/**
 * A MongoDB `$switch` expression that maps a `mimeType` field reference to its
 * `MediaCategory`. Use inside an aggregation `$addFields`/`$project` to group by
 * category. `fieldRef` defaults to `'$mimeType'`.
 */
export function categorySwitchExpr(fieldRef = '$mimeType'): Record<string, unknown> {
  return {
    $switch: {
      branches: [
        { case: { $regexMatch: { input: fieldRef, regex: '^image/', options: 'i' } }, then: 'image' },
        { case: { $regexMatch: { input: fieldRef, regex: '^video/', options: 'i' } }, then: 'video' },
        { case: { $regexMatch: { input: fieldRef, regex: '^audio/', options: 'i' } }, then: 'audio' },
        { case: { $in: [fieldRef, DOCUMENT_MIME_TYPES] }, then: 'document' },
        { case: { $in: [fieldRef, ARCHIVE_MIME_TYPES] }, then: 'archive' },
      ],
      default: 'other',
    },
  };
}
