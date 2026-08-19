import { FileDetail } from './product-detail.read-model';
import { IStorageProvider } from '../../../core/storage';
import { isPrivateStorageKey } from '../../../core/storage/storage-trees';

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
 * (`{ id, key, url, access, mimeType, size, originalName }`) — the SAME shape product
 * media/thumbnails and vendor branding return. This is the single way any
 * referenced file should be surfaced in an API response; never a bare URL string.
 *
 * ── A PRIVATE file gets `url: null` (ADR-A01 D-2) ─────────────────────────────
 * This function is the single choke point every `FileDetail` on the platform passes through,
 * which is why the rule lives here and not at forty call sites.
 *
 * `express.static` no longer serves the private trees, so a public URL for one would be a link
 * to a 404 — and, far worse, a link a client would keep rendering while believing it worked.
 * `access` names which kind of file this is and `url` is `null` for the authorized ones.
 *
 * **Why `null` rather than the authorized route's path.** The plan offers both and this is the
 * one that cannot be got wrong by accident: an authorized path is a string that looks exactly
 * like a public URL, so a client keeps `<img src={url}>` and silently renders nothing for
 * every unauthenticated viewer. `null` is a **type change** — `url: string | null` — so every
 * consumer is made to look by the compiler rather than by a changelog somebody skims. The
 * `id` is the handle, and the entity's own authorized read is where the authorization lives
 * (that is the point of ADR-A01 D-2: the scope belongs to the shipment or the ticket, not to
 * a second copy of its rules bolted onto a file route).
 */
export function toFileDetail(file: FileLike, storage: IStorageProvider): FileDetail {
  const isPrivate = isPrivateStorageKey(file.key);
  return {
    id: file.id,
    key: file.key,
    url: isPrivate ? null : storage.getPublicUrl(file.key),
    access: isPrivate ? 'authorized' : 'public',
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
