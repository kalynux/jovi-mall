import type { ImageSource } from '../../../bot-surface/miniapp/surfaces/image-source';

/**
 * Whether a product picture may be put into a WhatsApp form at all. Pure, so the suite asserts
 * it without importing storage or sharp.
 *
 * ── ⛔ A CUSTOMER-DISPLAY RULE, AND A MEMORY NOTE SAYS THE OPPOSITE ABOUT ANOTHER ONE ──
 * There is a standing note on this platform: "`quota_blocked` withholds the ADDRESS, not the
 * file — never pre-empt the content call on access". **That note is about a different route and
 * a different audience**: the administrator's audited content read, where refusing on `access`
 * once broke six dashboard screens. It does not apply here.
 *
 * This is the other case. The picture goes to a **customer**, inside a form, as bytes. A
 * `quota_blocked` image is one the platform has taken off the shelf. An `authorized` one is
 * private by definition (identity documents, delivery proofs). Encoding either into a form
 * would get it back to a customer through a side door, after the platform stopped serving its
 * address. So anything that is not `public` is refused, **before a byte is read**, never
 * filtered after encoding.
 *
 * Someone will read the admin note, find this refusal, and want to "fix" it. The two rules
 * protect opposite audiences, and `image-source.ts` states the same distinction beside the type.
 *
 * ⛔ **LOAD-BEARING FOR `authorized`, NOT A SPARE BELT.** backend-fc proved it against real file
 * records on 2026-09-16: a product picture stored under a private folder reaches this path as
 * `access: 'authorized'` with no URL, because the gallery filter upstream (`isRenderableImage`)
 * removes only quota-blocked and non-image files, not private storage. Encoding the bytes would
 * go around the missing URL entirely, so this check is the ONLY thing between a private file and
 * a customer's screen. (`quota_blocked` is filtered upstream and never arrives. It is refused here
 * as well.)
 */
export function mayShowImageToCustomer(image: ImageSource | null): image is ImageSource {
    return (
        image !== null
        && image.access === 'public'
        && image.mimeType.startsWith('image/')
        && image.size > 0
        && image.size <= FLOW_IMAGE_MAX_SOURCE_BYTES
    );
}

/**
 * The largest stored original this path will read.
 *
 * Bounds how much a single form open can make the server download and decode. A 40 MB camera
 * original would be resized to under 300 KB anyway, but reading and decoding it costs CPU on a
 * shared 2 vCPU box, on a path Meta times out.
 */
export const FLOW_IMAGE_MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/**
 * Meta's cap on an `Image` `src`: "up to 300kb".
 *
 * ⚠ **Applied to the base64 STRING, not the raw bytes.** Base64 is a third larger, and Meta's
 * wording doesn't say which it measures. Holding the encoded string under the cap satisfies
 * both readings; holding only the raw bytes under it satisfies one.
 */
export const FLOW_IMAGE_MAX_BASE64_CHARS = 300_000;
