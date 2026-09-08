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
  /**
   * Set when the owner is over their plan storage cap and this file falls outside it.
   * Optional so a caller projecting a narrower shape still compiles — an omitted value
   * reads as "not blocked", which is the correct default for every file that has never
   * been through the quota sweep.
   */
  quotaBlockedAt?: Date | null;
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
 *
 * ── A QUOTA-BLOCKED file gets `url: null` too, and is reported FIRST ──────────
 * When a plan downgrade puts an owner over their storage cap, the files outside the cap are
 * blocked newest-first rather than deleted (`modules/plan-quota/`). Blocking is expressed
 * here, at the same choke point and for the same reason: one rule, forty call sites.
 *
 * ⚠ **The blocked check runs BEFORE the privacy check, and the order is load-bearing.** A
 * blocked file inside a private tree is blocked, not merely authorized. Reporting
 * `authorized` would send a client to the owning entity's byte route to discover the
 * problem, and the answer it got back would describe a permissions failure rather than a
 * billing one — a support conversation about the wrong subject.
 *
 * ⚠ Blocking is **reversible and lossless**. Never treat it as deletion: the row, the bytes
 * and the file's contribution to the owner's used-bytes total all survive, and an upgrade
 * restores exactly the same files. That is the entire difference between this and the
 * cleanup sweep.
 */
export function toFileDetail(file: FileLike, storage: IStorageProvider): FileDetail {
  if (file.quotaBlockedAt) {
    return {
      id: file.id,
      key: file.key,
      url: null,
      access: 'quota_blocked',
      mimeType: file.mimeType,
      size: file.size,
      originalName: file.originalName,
    };
  }
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
 * Add the two COMPUTED fields — `url` and `access` — to a stored file record, leaving every
 * other field on it untouched.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `/api/files/*` answers the stored RECORD (provider, checksum, ownerType, the timestamps,
 * the soft-delete marks…), not a `FileDetail`. Those endpoints carried no `url` at all, so a
 * media library — or an "you just uploaded this, here it is" confirmation — had nowhere to
 * get a thumbnail from. Those are exactly the two screens that show a file BEFORE it is
 * attached to anything, and therefore before any owning entity can return a `FileDetail`
 * for it. Attached files were never the gap; the window before attachment was.
 *
 * This ADDS rather than replaces, deliberately. `GET /api/files` sorts on `createdAt` /
 * `updatedAt`, and a `FileDetail` carries neither — swapping the shape would let a client
 * sort by upload date and never display it. The result is a strict superset of what these
 * endpoints already returned, so no existing consumer breaks.
 *
 * ⚠ **Both fields come from `toFileDetail`, and a second computation here would BE the
 * defect this closed.** The privacy rule, the quota rule and the order between them
 * (blocked outranks private) live in exactly one place. A client left to re-derive them
 * gets them wrong: the vendor dashboard's hand-rolled copy could not express
 * `quota_blocked` at all, and failed OPEN on an unclassified tree where this fails closed.
 */
export function withUrlAndAccess<T extends FileLike>(
  file: T,
  storage: IStorageProvider,
): T & Pick<FileDetail, 'url' | 'access'> {
  const { url, access } = toFileDetail(file, storage);
  return { ...file, url, access };
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
