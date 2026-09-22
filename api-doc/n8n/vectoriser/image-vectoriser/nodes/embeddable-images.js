// ── embeddableImages(payload) ───────────────────────────────────────────────
// NOT a node of its own. This function is pasted into the existing
// `build all texts` Code node of wi-mall-vectoriser (inside its `buildProductText(p)`), and its result is set as
// `metadata.image_files` beside `metadata.primary_image`. That is the whole change to
// the text flow: one more metadata key. The trigger on product_vectors turns it
// into product_image_vectors rows in the same transaction as the text upsert
// (product_vectors.sql, "metadata.image_files → rows").
//
// It does NOT go into the embedded TEXT -- README § 5's rule that image URLs are
// tokens with no meaning still holds.
//
// Which images, and why:
//   · pictures only: PNG / JPEG / WEBP / GIF -- the four Voyage accepts. A video
//     in the gallery (video/mp4) and a digital asset (variants[].digitalConfig.asset,
//     never read here) are skipped by construction, not by a filter someone has
//     to remember.
//   · https only: Voyage fetches the URL itself from the public internet. An
//     http:// URL is a dev laptop's storage, which Voyage can never reach, and
//     queuing it would only burn five attempts.
//   · gallery first, then each variant's own photos, in payload order. Position
//     0 is the product's primary image, and the drainer embeds every product's
//     position 0 before anyone's position 1.
//   · deduplicated by file id: a gallery photo reused on a variant is one image.
//   · at most MAX_IMAGES_PER_PRODUCT. At the free tier's 2 images a minute, six is
//     three minutes of the drainer per product; the cap bounds the queue a single
//     vendor with 40 photos could otherwise build.
//   · url null means the platform withheld the address (quota-blocked file). It is
//     skipped rather than guessed.

const EMBEDDABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES_PER_PRODUCT = 6;

function embeddableImages(p) {
  const out = [];
  const seen = new Set();
  const take = (f, variantId) => {
    if (!f || typeof f !== 'object' || out.length >= MAX_IMAGES_PER_PRODUCT) return;
    const fileId = f.id != null ? String(f.id) : '';
    const url = typeof f.url === 'string' ? f.url.trim() : '';
    const mime = String(f.mimeType || '').toLowerCase().split(';')[0].trim();
    if (!fileId || seen.has(fileId)) return;
    if (!/^https:\/\//i.test(url)) return;
    if (!EMBEDDABLE_IMAGE_TYPES.has(mime)) return;
    seen.add(fileId);
    out.push({ file_id: fileId, url, variant_id: variantId, mime_type: mime });
  };
  for (const f of Array.isArray(p?.images) ? p.images : []) take(f, null);
  for (const v of Array.isArray(p?.variants) ? p.variants : []) {
    for (const f of Array.isArray(v?.files) ? v.files : []) take(f, v?.id != null ? String(v.id) : null);
  }
  return out;
}

// In `build all texts` → buildProductText(p), in the `metadata` object, beside `images`:
//   image_files: embeddableImages(p),

if (typeof module !== 'undefined') module.exports = { embeddableImages, EMBEDDABLE_IMAGE_TYPES, MAX_IMAGES_PER_PRODUCT };
