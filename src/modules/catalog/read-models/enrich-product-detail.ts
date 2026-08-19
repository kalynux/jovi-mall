import { Product } from '../repositories/mappers/product.mapper';
import { Variant } from '../repositories/mappers/variant.mapper';
import { FileRepositoryMongo } from '../repositories/mongo/file.repository.mongo';
import { DigitalAssetModel } from '../../digital-delivery/models/digital-asset.model';
import { IStorageProvider } from '../../../core/storage/storage-provider.interface';
import { FileDetail, AssetDetail } from './product-detail.read-model';
import { toFileDetail } from './file-detail.resolver';
import { PickupLocationDetail, PickupLocationDetailResolver } from './pickup-location-detail.resolver';
import { BargainRange, isBargainEffective } from '../domain/services/bargain-price.rule';

/**
 * Fetch File documents for an array of IDs and map them to `FileDetail`.
 * Files not found (deleted, invalid ID) are silently omitted.
 *
 * Built through `toFileDetail` rather than by hand — one of three sites that assembled the
 * shape themselves, which is how a rule living at the "single choke point" reached only some
 * of the platform's files. ADR-A01 D-2's public/authorized split is decided in one place.
 */
async function buildFileDetails(
  fileIds: string[],
  fileRepo: FileRepositoryMongo,
  storage: IStorageProvider,
): Promise<FileDetail[]> {
  if (fileIds.length === 0) return [];
  const results = await Promise.all(fileIds.map(id => fileRepo.findById(id)));
  return results
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .map(f => toFileDetail(f, storage));
}

function humanFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

function mimeSubtype(mime: string): string {
  const slash = mime.indexOf('/');
  return slash === -1 ? mime : mime.slice(slash + 1);
}

/**
 * Enriched product response — replaces bare id references with populated details.
 *
 * - `files` replaces `fileIds` (gallery/cover images with URLs)
 * - `pickup` populates `delivery.pickupLocation`'s address (the raw ids stay on
 *   `delivery` for a client that round-trips the object back on a PATCH)
 * - `digitalConfig` retains only the product-wide `isActive` toggle.
 *   Per-variant asset/limits are surfaced via EnrichedVariant.digital.
 */
export type EnrichedProduct = Omit<Product, 'fileIds'> & {
  files: FileDetail[];
  /** Null for products with no pickup location (digital, service, unconfigured). */
  pickup: PickupLocationDetail | null;
};

/**
 * `pickupResolver` is required, not optional. Every call site wants it, and an
 * optional parameter is how one of them ends up returning a product without
 * `pickup` while the rest return one with it — a wire-shape difference no
 * consumer can see coming. Required makes a new call site a compile error.
 */
export async function enrichProduct(
  product: Product,
  fileRepo: FileRepositoryMongo,
  storage: IStorageProvider,
  pickupResolver: PickupLocationDetailResolver,
): Promise<EnrichedProduct> {
  const [files, pickup] = await Promise.all([
    buildFileDetails(product.fileIds, fileRepo, storage),
    pickupResolver.resolve(product),
  ]);
  const { fileIds: _dropped, ...rest } = product;
  return { ...rest, files, pickup };
}

/**
 * Enriched variant response — replaces bare fileIds with populated file details
 * and resolves the digital asset reference (if any) into a populated AssetDetail.
 *
 * - `files` replaces `fileIds` (variant-specific images with URLs)
 * - `displayName` falls back to "<asset.originalName> - <format> - <size>" when
 *   variant.name is unset (or to the product title as a final fallback if no asset yet)
 * - `digital` populates the asset + limits for digital variants
 * - `bargainable` reports whether the stored bargain window is currently in effect
 */
export type EnrichedVariant = Omit<Variant, 'fileIds' | 'digitalConfig' | 'bargain'> & {
  files: FileDetail[];
  displayName: string;
  digital?: {
    asset?: AssetDetail;
    maxDownloads: number | null;
    expiresAfterDays: number | null;
  };
  /**
   * The configured haggling window, absent when none is set. Still returned when
   * `bargainable` is false — the vectorisation flag makes a window inert, never
   * deletes it, and a vendor must be able to see and edit what they configured.
   */
  bargain?: BargainRange;
  /**
   * `product.vectorisationEnabled && bargain != null`. Always present, so a client
   * never has to infer "is this live?" from the window's mere existence.
   */
  bargainable: boolean;
};

/**
 * @param parent the variant's product. Required, not optional: an optional
 *   parameter is how one call site ends up returning a variant without
 *   `bargainable` while the rest return one with it — a wire-shape difference no
 *   consumer can see coming. Every call site already holds the Product from the
 *   ownership `findById` above it, so this costs no query.
 */
export async function enrichVariant(
  variant: Variant,
  fileRepo: FileRepositoryMongo,
  storage: IStorageProvider,
  parent: Pick<Product, 'title' | 'vectorisationEnabled'>,
): Promise<EnrichedVariant> {
  const files = await buildFileDetails(variant.fileIds, fileRepo, storage);

  let digital: EnrichedVariant['digital'];
  let asset: AssetDetail | undefined;
  if (variant.digitalConfig) {
    if (variant.digitalConfig.assetId) {
      const doc = await DigitalAssetModel.findOne({
        _id: variant.digitalConfig.assetId,
        deletedAt: null,
      }).lean();
      if (doc) {
        asset = {
          id: doc._id.toString(),
          originalName: doc.originalName,
          mimeType: doc.mimeType,
          size: doc.size,
        };
      }
    }
    digital = {
      asset,
      maxDownloads: variant.digitalConfig.maxDownloads ?? null,
      expiresAfterDays: variant.digitalConfig.expiresAfterDays ?? null,
    };
  }

  // Display name fallback: explicit name -> asset-derived label -> product title -> sku.
  let displayName = variant.name ?? '';
  if (!displayName && asset) {
    displayName = `${asset.originalName} - ${mimeSubtype(asset.mimeType)} - ${humanFileSize(asset.size)}`;
  }
  if (!displayName) {
    displayName = parent.title || variant.sku;
  }

  // `bargain` must be destructured OUT and conditionally re-added: the domain type
  // carries `| null` as a write-time clear signal, which this wire type does not.
  const { fileIds: _dropped, digitalConfig: _dc, bargain, ...rest } = variant;
  return {
    ...rest,
    files,
    displayName,
    digital,
    ...(bargain ? { bargain } : {}),
    bargainable: isBargainEffective(parent.vectorisationEnabled, bargain),
  };
}

export async function enrichVariants(
  variants: Variant[],
  fileRepo: FileRepositoryMongo,
  storage: IStorageProvider,
  parent: Pick<Product, 'title' | 'vectorisationEnabled'>,
): Promise<EnrichedVariant[]> {
  return Promise.all(variants.map(v => enrichVariant(v, fileRepo, storage, parent)));
}
