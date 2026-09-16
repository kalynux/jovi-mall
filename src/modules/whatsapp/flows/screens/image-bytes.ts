import sharp from 'sharp';
import { getStorageProvider } from '../../../../core/storage/storage.instance';
import type { ImageSource } from '../../../bot-surface/miniapp/surfaces/image-source';
import {
    FLOW_IMAGE_MAX_BASE64_CHARS,
    FLOW_IMAGE_MAX_SOURCE_BYTES,
    mayShowImageToCustomer,
} from './image-policy';

/**
 * Load a product picture as the base64 a Flow `Image` needs, or null.
 *
 * ── ⚠ EVERY FAILURE IS NULL, BECAUSE THE PICTURE IS OPTIONAL AND THE SCREEN IS NOT ──
 * The product screen has a no-image twin for exactly this. A slow storage read, an unreadable
 * file, a provider that can't stream, or a picture that won't shrink under Meta's cap all cost
 * the customer the photo and nothing else. Throwing would cost them the whole product screen
 * over a decoration.
 *
 * ── ⚠ READ FROM STORAGE, NEVER FETCHED OVER HTTP ────────────────────────────
 * The bytes come through `getStorageProvider().getDownloadStream(key)`, not a request to the
 * image's public URL. Fetching our own URL server-side goes through the CDN for nothing, and on
 * a development box that URL is a Tailscale address the server can't reach even though a phone
 * can.
 *
 * ── THE SIZE LADDER ─────────────────────────────────────────────────────────
 * Product photos are routinely several hundred KB to several MB, far over Meta's 300 KB cap, so
 * almost every picture is re-encoded. Two attempts, then give up rather than send a picture
 * degraded past recognition.
 */

/** Meta times out the whole exchange, so the picture gets a budget well inside it. */
const IMAGE_BUDGET_MS = 3000;

const ATTEMPTS: ReadonlyArray<{ width: number; quality: number }> = [
    { width: 720, quality: 70 },
    { width: 480, quality: 55 },
];

export async function loadFlowImage(image: ImageSource | null): Promise<string | null> {
    // ⛔ The access refusal runs BEFORE any read. See `image-policy.ts`.
    if (!mayShowImageToCustomer(image)) return null;

    const work = encode(image).catch(() => null);
    const timeout = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), IMAGE_BUDGET_MS).unref();
    });
    return Promise.race([work, timeout]);
}

async function encode(image: ImageSource): Promise<string | null> {
    const provider = getStorageProvider();
    if (!provider.supportsDownloadStream()) return null;

    const original = await readBounded(await provider.getDownloadStream(image.key));
    if (!original) return null;

    for (const { width, quality } of ATTEMPTS) {
        const out = await sharp(original)
            .rotate()
            .resize({ width, withoutEnlargement: true })
            .jpeg({ quality })
            .toBuffer();
        const base64 = out.toString('base64');
        if (base64.length <= FLOW_IMAGE_MAX_BASE64_CHARS) return base64;
    }
    return null;
}

/**
 * Buffer a stream, refusing past the source cap.
 *
 * ⚠ **Bounded while reading, not after.** The stored `size` is a claim about the file. A stream
 * that runs past it is stopped at the cap rather than buffered in full and then rejected.
 */
async function readBounded(stream: NodeJS.ReadableStream): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += buffer.length;
        if (total > FLOW_IMAGE_MAX_SOURCE_BYTES) {
            // Stop the underlying read too. Leaving the loop alone would leave an open storage
            // stream behind on every oversized picture.
            const destroyable = stream as NodeJS.ReadableStream & { destroy?: () => void };
            destroyable.destroy?.();
            return null;
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}
