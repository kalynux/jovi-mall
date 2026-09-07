import { Types } from 'mongoose';
import { ProductModel } from '../models/product.model';
import { ProductVariantModel } from '../models/product-variant.model';
import { FileDetail } from './product-detail.read-model';
import { FileLookup, resolveFileDetails } from './file-detail.resolver';
import { IStorageProvider } from '../../../core/storage';

/**
 * One thing to find pictures of: the variant that was actually sold, and the
 * product it belongs to. `variantId` is optional because some callers only hold
 * a product reference (a shipment item carries `product_id`; the variant lives
 * on the order-item snapshot it joins to, which legacy rows may not have).
 */
export interface ProductImageRef {
  productId: string;
  variantId?: string | null;
}

/** Map key for a (product, variant) pair. Use it on both sides of the lookup. */
export function productImageKey(productId: string, variantId?: string | null): string {
  return `${productId}:${variantId ?? ''}`;
}

/**
 * Is this resolved file something a client can actually render as a picture?
 *
 * Two rules, and they are deliberately one predicate so every gallery on the platform
 * answers the question identically:
 *
 *  - it must be a genuine `image/*` — `fileIds` is generic media and may hold a video or
 *    a spec sheet, and a video's URL in an `<img>` is a broken thumbnail;
 *  - it must not be **quota-blocked** — the owner is over their plan's storage cap and
 *    this file falls outside it, so there is no URL to render (`modules/plan-quota/`).
 *
 * ⚠ A blocked file is treated exactly as a non-image is: **skipped, not substituted**. It
 * is not an error and it is not a missing file — the owner's plan simply does not reach
 * this far down their library, and it returns unchanged when they upgrade. This is what
 * makes "the product stays listed and shows only the images that still fit" true without a
 * single edit to any DTO.
 */
export function isRenderableImage(file: FileDetail | undefined): file is FileDetail {
  return !!file && file.access !== 'quota_blocked' && !!file.mimeType?.startsWith('image/');
}

/**
 * Batch-resolve `(product, variant)` pairs to their pictures — what the thing
 * being sold looks like, for anyone who has to recognise it in the physical
 * world (an agent picking a parcel off a counter, most of all).
 *
 * Returns the whole gallery per pair, **thumbnail first**, so one resolver
 * serves both readers: a list or an offer takes `[0]`, a detail view takes the
 * lot. Pairs with no usable image are ABSENT from the map — read it as
 * `map.get(key) ?? []`.
 *
 * **Variant first, product second — as a fallback, not a merge.** The variant is
 * the sellable unit, so its own media is the truthful picture of what is in the
 * box: a red T-shirt must not show the blue one. When the variant has media, it
 * is the whole gallery; the product's is used only when the variant has none,
 * which is also the normal case (most variants carry no media, and a simple-mode
 * product has exactly one variant anyway). Appending the product's shots after
 * the variant's would reintroduce the wrong colour halfway down the gallery.
 *
 * **Only renderable images qualify** — see `isRenderableImage`. `fileIds` is generic
 * product media and may hold a video or a spec sheet; the first entry is the
 * thumbnail *by convention*, not by type. Quota-blocked files are skipped by the
 * same predicate, so a vendor over their storage cap keeps a listing that shows
 * however many of its pictures still fit inside the plan.
 *
 * ⚠ A variant whose media is *entirely* blocked therefore falls back to the
 * product's gallery, exactly as a variant carrying only a video already does. That
 * is the pre-existing behaviour for "no usable media" and is kept deliberately —
 * but note it is the one case where the variant-first rule below can show a
 * neighbouring colour, so a caller that must never do that should check `access`
 * itself rather than relying on the gallery being empty.
 *
 * **Resolved live, never snapshotted.** Order items snapshot title/sku/price
 * because those are the terms of the sale and must not drift; an image is not a
 * term of the sale, it is an aid to recognising the object, so the *current*
 * picture is the more useful one. Live resolution also means every order that
 * already exists gets images with no backfill. A vendor who removes their media
 * (or whose files were swept by file-cleanup) simply resolves to no image.
 */
export async function resolveProductImages(
  refs: ProductImageRef[],
  fileRepo: FileLookup,
  storage: IStorageProvider,
): Promise<Map<string, FileDetail[]>> {
  const result = new Map<string, FileDetail[]>();
  if (refs.length === 0) return result;

  const productIds = [...new Set(refs.map(r => r.productId).filter(id => Types.ObjectId.isValid(id)))];
  const variantIds = [
    ...new Set(
      refs
        .map(r => r.variantId)
        .filter((id): id is string => !!id && Types.ObjectId.isValid(id))
    ),
  ];

  const [variants, products] = await Promise.all([
    variantIds.length > 0
      ? ProductVariantModel.find({ _id: { $in: variantIds } }).select('fileIds').lean().exec()
      : Promise.resolve([] as any[]),
    productIds.length > 0
      ? ProductModel.find({ _id: { $in: productIds } }).select('fileIds').lean().exec()
      : Promise.resolve([] as any[]),
  ]);

  const toIdList = (docs: any[]): Map<string, string[]> =>
    new Map(docs.map(d => [d._id.toString(), (d.fileIds ?? []).map((f: any) => f.toString())]));

  const variantFileIds = toIdList(variants as any[]);
  const productFileIds = toIdList(products as any[]);

  // One File query for every candidate across every ref — the whole point of a
  // batch resolver. Soft-deleted files are dropped by the repository.
  const candidates = new Set<string>();
  for (const ids of variantFileIds.values()) for (const id of ids) candidates.add(id);
  for (const ids of productFileIds.values()) for (const id of ids) candidates.add(id);
  const fileById = await resolveFileDetails([...candidates], fileRepo, storage);

  const imagesOf = (fileIds: string[] | undefined): FileDetail[] =>
    (fileIds ?? []).map(id => fileById.get(id)).filter(isRenderableImage);

  for (const ref of refs) {
    const variantImages = ref.variantId ? imagesOf(variantFileIds.get(ref.variantId)) : [];
    const images = variantImages.length > 0 ? variantImages : imagesOf(productFileIds.get(ref.productId));
    if (images.length > 0) result.set(productImageKey(ref.productId, ref.variantId), images);
  }

  return result;
}
