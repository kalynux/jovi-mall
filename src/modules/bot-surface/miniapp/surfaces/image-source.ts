import type { FileDetail } from '../../../catalog/read-models/product-detail.read-model';

/**
 * A picture as a STORED FILE — for a renderer that needs the bytes rather than an address.
 *
 * ── ⚠ WHY A URL IS NOT ENOUGH FOR EVERY CHANNEL ─────────────────────────────
 * The Telegram Mini App draws a picture from a URL, fetched by the customer's phone. A WhatsApp
 * Flow cannot: an Image `src` is **base64 bytes inside the encrypted response** ("Base64 of an
 * image", up to 300 KB, at most three per screen — Meta's component reference). So a Flow needs
 * to read the bytes through the storage provider, and fetching our own public URL over HTTP to
 * get them would be the wrong way round — on a development machine that URL is a carrier-NAT
 * address a phone reaches and this server's own outbound fetch may not.
 *
 * These four fields are a strict subset of `FileDetail`, which the reads already hold. With
 * them a renderer can:
 *
 *   - read the bytes with `getStorageProvider().getDownloadStream(key)`, after checking
 *     `supportsDownloadStream()` (not every provider streams — see the storage byte-path gap);
 *   - decide by `size` and `mimeType` whether to send, shrink or skip, **before** fetching;
 *   - refuse by `access`.
 *
 * ── ⚠ `access` HERE IS A DISPLAY RULE, NOT A BYTE-REACHABILITY RULE ─────────
 * Two different rules on this platform read `access`, and confusing them is how a correct
 * refusal gets "fixed" into a leak:
 *
 *   - For an **authorised admin fetching bytes**, `quota_blocked` withholds the *address*, not
 *     the file — the admin content route serves it `200`, and pre-empting that call on `access`
 *     is a known defect that once disabled six dashboard surfaces.
 *   - For **showing a picture to a customer**, a `quota_blocked` image is off the shelf: the
 *     vendor's plan no longer covers it, and `isRenderableImage` already excludes it from every
 *     gallery. A renderer that base64'd one into a customer's view would put it back on the
 *     shelf through a side door.
 *
 * This type serves the second. And in practice a blocked picture never reaches it: both reads
 * take their picture from a gallery that `isRenderableImage` has already filtered. A renderer's
 * own `access !== 'public'` refusal is therefore a belt that should never fire — keep it anyway.
 */
export interface ImageSource {
    /** The storage key — what `getDownloadStream` takes. Never a URL. */
    key: string;
    access: FileDetail['access'];
    mimeType: string;
    /** Bytes, so a renderer can refuse an oversized picture without reading it first. */
    size: number;
}

/** A `FileDetail` → its byte-level description, or null when there is no picture. */
export function toImageSource(file: FileDetail | null | undefined): ImageSource | null {
    if (!file) return null;
    return { key: file.key, access: file.access, mimeType: file.mimeType, size: file.size };
}
