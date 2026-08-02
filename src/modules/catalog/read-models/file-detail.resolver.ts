import { FileDetail } from './product-detail.read-model';
import { IStorageProvider } from '../../../core/storage';

/**
 * Minimal file shape this resolver needs. `FileRepositoryMongo.findManyByIds`
 * (and `IFileRepository`) satisfy `FileLookup` structurally, so callers don't
 * need to import a concrete repository type here.
 */
interface FileLike {
  id: string;
  key: string;
  mimeType: string;
  size: number;
  originalName?: string;
}
export interface FileLookup {
  findManyByIds(ids: string[]): Promise<FileLike[]>;
}

/**
 * Map a stored file record to the canonical `FileDetail` wire shape
 * (`{ id, key, url, mimeType, size, originalName }`) — the SAME shape product
 * media/thumbnails and vendor branding return. This is the single way any
 * referenced file should be surfaced in an API response; never a bare URL string.
 */
export function toFileDetail(file: FileLike, storage: IStorageProvider): FileDetail {
  return {
    id: file.id,
    key: file.key,
    url: storage.getPublicUrl(file.key),
    mimeType: file.mimeType,
    size: file.size,
    originalName: file.originalName,
  };
}

/**
 * Batch-resolve file ids to `FileDetail` objects, keyed by id. Deduplicates,
 * issues one lookup, and omits missing/deleted files from the map. Use for
 * list/enrichment paths (orders, tickets, rosters, agency browse, …).
 */
export async function resolveFileDetails(
  fileIds: Array<string | null | undefined>,
  fileRepo: FileLookup,
  storage: IStorageProvider,
): Promise<Map<string, FileDetail>> {
  const ids = [...new Set(fileIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const files = await fileRepo.findManyByIds(ids);
  return new Map(files.map((f) => [f.id, toFileDetail(f, storage)]));
}

/**
 * Resolve a single file id to a `FileDetail`, or `null` when the slot is unset
 * or the file no longer exists. Use for single-entity responses (profiles).
 */
export async function resolveFileDetail(
  fileId: string | null | undefined,
  fileRepo: FileLookup,
  storage: IStorageProvider,
): Promise<FileDetail | null> {
  if (!fileId) return null;
  const [file] = await fileRepo.findManyByIds([fileId]);
  return file ? toFileDetail(file, storage) : null;
}
