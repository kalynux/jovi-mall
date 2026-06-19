/**
 * VectorisationService
 *
 * Responsible for all interactions with the external vectoriser at
 * https://the8n.fante.cloud/vectoriser.
 *
 * Design principles:
 *  - All public methods are safe to call fire-and-forget from controllers.
 *    They catch and log every error internally and never rethrow.
 *  - The product save in MongoDB is ALWAYS completed first; vectorisation
 *    is a side-effect that must never block the HTTP response.
 *  - Retry logic is applied on transient failures only (network errors / 5xx).
 *    4xx responses are not retried (they indicate a payload problem).
 *  - All vectorisation attempts are logged with structured context for
 *    observability and debugging.
 */

import { Types } from 'mongoose';
import { vectoriserConfig } from '../../../../config/vectoriser.config';
import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { getStorageProvider } from '../../../../core/storage/storage.instance';
import { ProductModel, VectorisationStatus } from '../../models/product.model';
import { ProductVariantModel } from '../../models/product-variant.model';
import { ProductOptionModel } from '../../models/product-option.model';
import { ProductOptionValueModel } from '../../models/product-option-value.model';
import { FileModel } from '../../models/file.model';
import { DigitalAssetModel } from '../../../digital-delivery/models/digital-asset.model';
import { VendorModel } from '../../../vendors/vendor.model';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface VectoriserSingleResponse {
  product_id: string;
  vectorised_id: string;
}

export interface VectoriserBulkResponse {
  results: VectoriserSingleResponse[];
}

/** Shape of one entry in the bulk-vectorise payload array */
interface VectoriserPayloadEntry {
  product_id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  type: string;
  status: string;
  slug: string;
  seo: { title?: string; description?: string };
  vendor: Record<string, unknown>;
  variants: Record<string, unknown>[];
  delivery: {
    agency_id: string | null;
    agency: Record<string, unknown> | null;
    source: 'product' | 'vendor_default' | null;
  } | null;
  /** Resolved product-gallery images (URLs + metadata), never raw file IDs. */
  images?: Record<string, unknown>[];
  /** Product-wide digital kill switch (`isActive`). Per-variant asset/limits live on each variant. */
  digitalConfig?: Record<string, unknown>;
}

/** Result returned from vectoriseBulk to callers (e.g. reconciliation script) */
export interface BulkVectorisationResult {
  succeeded: number;
  failed: number;
  total: number;
  errors: Array<{ productId: string; reason: string }>;
}

/** Snapshot of a product's vectorisation columns — returned by prepareForVectorisation. */
export interface ProductVectorisationState {
  vectorisationEnabled: boolean;
  vectorisationStatus: VectorisationStatus;
  vectorisedDataId: string | null;
}

// ─── Logger helper ───────────────────────────────────────────────────────────

/** Structured log helper scoped to vectorisation. */
function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  context: Record<string, unknown> = {},
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    service: 'VectorisationService',
    level,
    message,
    ...context,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ─── Utility: delay ──────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Utility: HTTP fetch with timeout ────────────────────────────────────────

/**
 * Thin fetch wrapper that:
 *  - Attaches the T8N-API-KEY auth header.
 *  - Enforces a request timeout via AbortController.
 *  - Returns the parsed JSON body on success.
 *  - Throws a typed error on non-2xx or timeout, preserving the status code.
 */
async function vectoriserFetch<T>(
  url: string,
  payload: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(vectoriserConfig.apiKey ? { 'T8N-API-KEY': vectoriserConfig.apiKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '<unreadable>');
      const err = new Error(`Vectoriser responded with HTTP ${response.status}: ${errorBody}`);
      (err as any).statusCode = response.status;
      throw err;
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Utility: retry with exponential backoff ──────────────────────────────────

/**
 * Executes `fn` up to `maxAttempts` times.
 * Retries only when the thrown error does NOT have a 4xx statusCode
 * (4xx = client error, retrying won't help).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  context: Record<string, unknown>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const statusCode: number | undefined = err?.statusCode;

      // Do not retry client errors
      if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
        log('error', 'Vectorisation client error — not retrying', {
          ...context,
          attempt,
          statusCode,
          error: err.message,
        });
        throw err;
      }

      if (attempt < maxAttempts) {
        const waitMs = baseDelayMs * attempt;
        log('warn', 'Vectorisation attempt failed — retrying', {
          ...context,
          attempt,
          nextAttemptIn: `${waitMs}ms`,
          error: err.message,
        });
        await delay(waitMs);
      } else {
        log('error', 'Vectorisation exhausted all retries', {
          ...context,
          attempt,
          error: err.message,
        });
      }
    }
  }

  throw lastError;
}

// ─── VectorisationService ────────────────────────────────────────────────────

export class VectorisationService {
  // ── Eligibility check ─────────────────────────────────────────────────────

  /**
   * Returns true when a product meets all vectorisation conditions:
   *  1. status === 'active'
   *  2. vectorisationEnabled === true
   *  3. Has a title, description, category (basic completeness gate)
   */
  isEligible(product: {
    status: string;
    vectorisationEnabled: boolean;
    title?: string;
    description?: string;
    category?: string;
  }): boolean {
    return (
      product.status === 'active' &&
      product.vectorisationEnabled === true &&
      !!product.title &&
      !!product.description &&
      !!product.category
    );
  }

  // ── Payload population ────────────────────────────────────────────────────

  /**
   * Builds a fully-populated payload for a single product.
   * Never sends raw IDs — vendor, variants, and agency objects are all resolved.
   *
   * @throws if the product document cannot be found in MongoDB.
   */
  async buildPayload(productId: string): Promise<VectoriserPayloadEntry | null> {
    // 1. Fetch the raw product document
    const product = await ProductModel.findOne({ _id: productId, deletedAt: null }).lean();
    if (!product) {
      log('warn', 'buildPayload: product not found', { productId });
      return null;
    }

    // 2. Populate vendor
    let vendor: Record<string, unknown> = {};
    let vendorDefaultAgencyId: string | null = null;
    if (product.vendorId) {
      const vendorDoc = await VendorModel.findById(product.vendorId).lean();
      if (vendorDoc) {
        vendor = {
          id: vendorDoc._id.toString(),
          business_name: vendorDoc.business_name,
          display_name: vendorDoc.display_name,
          business_description: vendorDoc.business_description,
          country: vendorDoc.country,
          email: vendorDoc.email,
          status: vendorDoc.status,
        };
        vendorDefaultAgencyId = vendorDoc.default_delivery_agency_id?.toString() ?? null;
      }
    }

    // 3. Populate active variants
    const variantDocs = await ProductVariantModel.find({
      productId: product._id,
      status: 'active',
      deletedAt: null,
    }).lean();

    // 3a. Resolve every ID reference into human-readable data. The AI indexer
    //     cannot interpret raw ObjectIds, so option values, images, digital
    //     assets, and variant delivery agencies are all populated below. Lookups
    //     are batched across the whole variant set to avoid N+1 queries.
    const storage = getStorageProvider();
    const uniq = (ids: string[]) => [...new Set(ids)];

    // Files — product gallery + every variant's images, resolved to URLs.
    const productFileIds = (product.fileIds ?? []).map(id => id.toString());
    const allFileIds = uniq([
      ...productFileIds,
      ...variantDocs.flatMap(v => (v.fileIds ?? []).map(id => id.toString())),
    ]);
    const fileMap = new Map<string, Record<string, unknown>>();
    if (allFileIds.length > 0) {
      const fileDocs = await FileModel.find({ _id: { $in: allFileIds }, deletedAt: null }).lean();
      for (const f of fileDocs) {
        fileMap.set(f._id.toString(), {
          id: f._id.toString(),
          url: storage.getPublicUrl(f.key),
          mimeType: f.mimeType,
          size: f.size,
          originalName: f.originalName ?? null,
        });
      }
    }
    const filesFor = (ids: Types.ObjectId[] = []) =>
      ids.map(id => fileMap.get(id.toString())).filter((f): f is Record<string, unknown> => !!f);

    // Option values → { option: <option name>, value } pairs (e.g. Size → "M").
    const allOptionValueIds = uniq(
      variantDocs.flatMap(v => (v.optionValueIds ?? []).map(id => id.toString())),
    );
    const optionValueMap = new Map<string, Record<string, unknown>>();
    if (allOptionValueIds.length > 0) {
      const valueDocs = await ProductOptionValueModel.find({ _id: { $in: allOptionValueIds }, deletedAt: null }).lean();
      const optionIds = uniq(valueDocs.map(v => v.optionId.toString()));
      const optionDocs = await ProductOptionModel.find({ _id: { $in: optionIds }, deletedAt: null }).lean();
      const optionNameById = new Map(optionDocs.map(o => [o._id.toString(), o.name]));
      for (const v of valueDocs) {
        optionValueMap.set(v._id.toString(), {
          option: optionNameById.get(v.optionId.toString()) ?? null,
          value: v.value,
        });
      }
    }
    const optionsFor = (ids: Types.ObjectId[] = []) =>
      ids.map(id => optionValueMap.get(id.toString())).filter((o): o is Record<string, unknown> => !!o);

    // Digital assets referenced by digital variants → name/type/size (not raw id).
    const allAssetIds = uniq(
      variantDocs
        .map(v => v.digitalConfig?.assetId)
        .filter((id): id is Types.ObjectId => !!id)
        .map(id => id.toString()),
    );
    const assetMap = new Map<string, Record<string, unknown>>();
    if (allAssetIds.length > 0) {
      const assetDocs = await DigitalAssetModel.find({ _id: { $in: allAssetIds }, deletedAt: null }).lean();
      for (const a of assetDocs) {
        assetMap.set(a._id.toString(), {
          id: a._id.toString(),
          originalName: a.originalName,
          mimeType: a.mimeType,
          size: a.size,
        });
      }
    }

    // Variant-level delivery agencies (physical variants that override the default).
    const allVariantAgencyIds = uniq(
      variantDocs
        .map(v => v.deliveryAgencyId)
        .filter((id): id is Types.ObjectId => !!id)
        .map(id => id.toString()),
    );
    const variantAgencyMap = new Map<string, Record<string, unknown>>();
    if (allVariantAgencyIds.length > 0) {
      try {
        const { DeliveryAgencyModel } = await import('../../../delivery/delivery-agency.model');
        const agencyDocs = await DeliveryAgencyModel.find({ _id: { $in: allVariantAgencyIds } }).lean();
        for (const a of agencyDocs) {
          variantAgencyMap.set(a._id.toString(), {
            id: a._id.toString(),
            name: (a as any).name,
            country: (a as any).country,
          });
        }
      } catch {
        log('warn', 'buildPayload: could not load DeliveryAgencyModel for variants', { productId });
      }
    }

    // 3b. Build rich variant objects. Each variant carries its own resolved
    //     options, images, delivery agency, and — when set — its full
    //     digitalConfig / serviceConfig block. Type-specific config lives ON the
    //     variant that owns it, not hoisted to the product.
    const variants: Record<string, unknown>[] = variantDocs.map(v => {
      const variant: Record<string, unknown> = {
        id: v._id.toString(),
        sku: v.sku,
        name: v.name ?? null,
        price: v.price,
        compareAtPrice: v.compareAtPrice ?? null,
        stock: v.stock,
        isInfiniteStock: v.isInfiniteStock,
        weight: v.weight ?? null,
        length: v.length ?? null,
        width: v.width ?? null,
        height: v.height ?? null,
        optionSignature: v.optionSignature,
        options: optionsFor(v.optionValueIds),
        files: filesFor(v.fileIds),
      };

      const variantAgency = v.deliveryAgencyId ? variantAgencyMap.get(v.deliveryAgencyId.toString()) : undefined;
      if (variantAgency) {
        variant.deliveryAgency = variantAgency;
      }

      if (v.digitalConfig) {
        variant.digitalConfig = {
          maxDownloads: v.digitalConfig.maxDownloads ?? null,
          expiresAfterDays: v.digitalConfig.expiresAfterDays ?? null,
          asset: v.digitalConfig.assetId ? assetMap.get(v.digitalConfig.assetId.toString()) ?? null : null,
        };
      }

      if (v.serviceConfig) {
        variant.serviceConfig = v.serviceConfig;
      }

      return variant;
    });

    const productImages = filesFor(product.fileIds);

    // 4. Resolve product-level delivery agency. Delivery is set per product, not per variant.
    //    Fallback chain: product.delivery.agency_id → vendor.default_delivery_agency_id.
    //    Mirrors the order pipeline behaviour documented on the Product model.
    const productAgencyId = product.delivery?.agency_id?.toString() ?? null;
    const effectiveAgencyId = productAgencyId ?? vendorDefaultAgencyId;
    const agencySource: 'product' | 'vendor_default' | null = productAgencyId
      ? 'product'
      : vendorDefaultAgencyId
        ? 'vendor_default'
        : null;

    let agency: Record<string, unknown> | null = null;
    if (effectiveAgencyId) {
      try {
        const { DeliveryAgencyModel } = await import('../../../delivery/delivery-agency.model');
        const agencyDoc = await DeliveryAgencyModel.findById(effectiveAgencyId).lean();
        if (agencyDoc) {
          agency = {
            id: agencyDoc._id.toString(),
            name: (agencyDoc as any).name,
            country: (agencyDoc as any).country,
          };
        } else {
          agency = { id: effectiveAgencyId };
        }
      } catch {
        log('warn', 'buildPayload: could not load DeliveryAgencyModel', { productId });
        agency = { id: effectiveAgencyId };
      }
    }

    const delivery: VectoriserPayloadEntry['delivery'] = {
      agency_id: effectiveAgencyId,
      agency,
      source: agencySource,
    };

    return {
      product_id: product._id.toString(),
      title: product.title,
      description: product.description,
      category: product.category,
      tags: product.tags ?? [],
      type: product.type,
      status: product.status,
      slug: product.slug,
      seo: product.seo ?? {},
      vendor,
      variants,
      images: productImages,
      delivery,
      ...(product.digitalConfig ? { digitalConfig: product.digitalConfig as Record<string, unknown> } : {}),
    };
  }

  // ── Prep + Execute split ──────────────────────────────────────────────────

  /**
   * Pre-flight: eligibility check, status setup, and payload build.
   *
   * This is the only place that writes 'pending' status for single-product
   * vectorisation — controllers must NOT pre-write 'pending'. That removes the
   * old redundancy between controller + service.
   *
   * Behaviour:
   *  - Product missing: returns { payload: null } with a neutral snapshot.
   *  - Product not eligible: flips vectorisationEnabled=false and resets
   *    vectorisationStatus='not_started' (per platform policy — the frontend
   *    surfaces an "Enable" CTA once the product becomes eligible again).
   *  - Eligible but payload build fails: writes status='failed'.
   *  - Eligible & payload OK: writes status='pending' and returns the payload
   *    plus a snapshot the controller can return to the client.
   *
   * Designed to be awaited by the controller; once it returns, the controller
   * responds to the user, then fire-and-forget calls executePreparedVectorisation.
   */
  async prepareForVectorisation(productId: string): Promise<{ payload: VectoriserPayloadEntry | null; state: ProductVectorisationState }> {
    const ctx = { productId };

    const product = await ProductModel.findOne({ _id: productId, deletedAt: null }).lean();
    if (!product) {
      log('warn', 'prepareForVectorisation: product not found', ctx);
      return {
        payload: null,
        state: { vectorisationEnabled: false, vectorisationStatus: 'not_started', vectorisedDataId: null },
      };
    }

    if (!this.isEligible(product)) {
      // Policy: ineligible product cannot stay opted-in. Reset both flag and
      // status so the frontend can offer "Enable" once the product is ready.
      await ProductModel.updateOne(
        { _id: productId },
        { $set: { vectorisationEnabled: false, vectorisationStatus: 'not_started' } },
      );
      log('info', 'prepareForVectorisation: ineligible — vectorisation disabled', {
        ...ctx,
        status: product.status,
        vectorisationEnabled: product.vectorisationEnabled,
      });
      return {
        payload: null,
        state: {
          vectorisationEnabled: false,
          vectorisationStatus: 'not_started',
          vectorisedDataId: product.vectorisedDataId ?? null,
        },
      };
    }

    // Mark pending now — concurrent edits are locked out by requireProductEditable
    // from this point forward.
    await ProductModel.updateOne({ _id: productId }, { $set: { vectorisationStatus: 'pending' } });

    const payload = await this.buildPayload(productId);
    if (!payload) {
      await ProductModel.updateOne({ _id: productId }, { $set: { vectorisationStatus: 'failed' } });
      log('error', 'prepareForVectorisation: payload build failed', ctx);
      return {
        payload: null,
        state: {
          vectorisationEnabled: true,
          vectorisationStatus: 'failed',
          vectorisedDataId: product.vectorisedDataId ?? null,
        },
      };
    }

    log('info', 'prepareForVectorisation: ready', ctx);
    return {
      payload,
      state: {
        vectorisationEnabled: true,
        vectorisationStatus: 'pending',
        vectorisedDataId: product.vectorisedDataId ?? null,
      },
    };
  }

  /**
   * Execute a previously-prepared vectorisation: POST the payload to the
   * external service and persist the result.
   *
   * IMPORTANT: Fire-and-forget — swallows all errors internally and never rejects.
   * Pair with prepareForVectorisation().
   */
  async executePreparedVectorisation(productId: string, payload: VectoriserPayloadEntry): Promise<void> {
    const ctx = { productId };

    try {
      const response = await withRetry(
        () =>
          vectoriserFetch<VectoriserSingleResponse>(
            vectoriserConfig.baseUrl,
            payload,
            vectoriserConfig.timeoutSingleMs,
          ),
        vectoriserConfig.maxRetries,
        vectoriserConfig.retryBaseDelayMs,
        ctx,
      );

      await ProductModel.updateOne(
        { _id: productId },
        {
          $set: {
            vectorisedDataId: response.vectorised_id,
            vectorisationStatus: 'completed',
          },
        },
      );

      log('info', 'executePreparedVectorisation: completed', {
        ...ctx,
        vectorisedDataId: response.vectorised_id,
      });
    } catch (err: any) {
      try {
        await ProductModel.updateOne(
          { _id: productId },
          { $set: { vectorisationStatus: 'failed' } },
        );
      } catch (dbErr: any) {
        log('error', 'executePreparedVectorisation: failed to write failure status to DB', {
          ...ctx,
          dbError: dbErr.message,
        });
      }

      log('error', 'executePreparedVectorisation: failed', {
        ...ctx,
        error: err.message,
        stack: err.stack,
      });
    }
  }

  // ── Set enabled (consolidated toggle) ─────────────────────────────────────

  /**
   * Apply a desired vectorisationEnabled state to a product.
   *
   * Outcomes:
   *  - 'noop'       — already in the requested state, or (when enabling) already
   *                   enabled with status pending|completed.
   *  - 'enabled'    — flipped to true and prep produced a payload; caller should
   *                   fire-and-forget executePreparedVectorisation(productId, payload).
   *  - 'ineligible' — flipped to true but prepareForVectorisation found the product
   *                   ineligible and reset the flag back to false.
   *  - 'disabled'   — flipped to false; caller should fire-and-forget
   *                   deleteVectorisation(productId).
   *
   * Throws CATALOG_PRODUCT_NOT_FOUND if the product is missing or not owned by
   * the given vendor. All other outcomes resolve normally so the controller can
   * pick the right HTTP status + message.
   */
  async setEnabled(
    productId: string,
    vendorId: string,
    desiredEnabled: boolean,
  ): Promise<{
    outcome: 'noop' | 'enabled' | 'ineligible' | 'disabled';
    state: ProductVectorisationState;
    payload: VectoriserPayloadEntry | null;
  }> {
    const product = await ProductModel.findOne({ _id: productId, vendorId, deletedAt: null })
      .select('vectorisationEnabled vectorisationStatus vectorisedDataId')
      .lean();
    if (!product) {
      throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
    }

    const currentSnapshot: ProductVectorisationState = {
      vectorisationEnabled: product.vectorisationEnabled,
      vectorisationStatus: product.vectorisationStatus,
      vectorisedDataId: product.vectorisedDataId ?? null,
    };

    if (desiredEnabled) {
      const alreadyDone = product.vectorisationEnabled
        && (product.vectorisationStatus === 'pending' || product.vectorisationStatus === 'completed');
      if (alreadyDone) {
        return { outcome: 'noop', state: currentSnapshot, payload: null };
      }

      // Flip the flag before prepare so its eligibility check sees the right value.
      await ProductModel.updateOne({ _id: productId }, { $set: { vectorisationEnabled: true } });
      const { payload, state } = await this.prepareForVectorisation(productId);
      if (payload) {
        return { outcome: 'enabled', state, payload };
      }
      return { outcome: 'ineligible', state, payload: null };
    }

    if (!product.vectorisationEnabled) {
      return { outcome: 'noop', state: currentSnapshot, payload: null };
    }

    await ProductModel.updateOne({ _id: productId }, { $set: { vectorisationEnabled: false } });
    return {
      outcome: 'disabled',
      state: { ...currentSnapshot, vectorisationEnabled: false },
      payload: null,
    };
  }

  // ── Single vectorisation (fire-and-forget convenience wrapper) ────────────

  /**
   * Convenience: prepare + execute in one call. Used by callers that don't
   * need to gate their HTTP response on the prep step (createProduct,
   * updateProduct, bulk paths).
   *
   * IMPORTANT: Call fire-and-forget (void, no await).
   */
  async vectoriseSingle(productId: string): Promise<void> {
    const { payload } = await this.prepareForVectorisation(productId);
    if (payload) {
      await this.executePreparedVectorisation(productId, payload);
    }
  }

  // ── Deletion (fire-and-forget) ────────────────────────────────────────────

  /**
   * Delete vectorised data for a product on the external service.
   *
   * Endpoint:  POST <baseUrl>/delete
   * Payload:   { product_id, vectorised_id }
   *
   * Flow:
   *  1. Look up the product and short-circuit if it was never vectorised.
   *  2. Call the upstream /delete endpoint (best-effort, no retry).
   *  3. Clear vectorisedDataId locally + reset vectorisationStatus to 'not_started'.
   *
   * IMPORTANT: This is a fire-and-forget operation — call it with `void`.
   * The local state is always reset, even if the upstream call fails, so the
   * product is left in a clean state from the platform's perspective.
   */
  async deleteVectorisation(productId: string): Promise<void> {
    const ctx = { productId };

    try {
      const product = await ProductModel.findOne({ _id: productId, deletedAt: null })
        .select('vectorisedDataId vectorisationStatus')
        .lean();

      if (!product) {
        log('warn', 'deleteVectorisation: product not found — skipping', ctx);
        return;
      }

      // Nothing to delete upstream if we never had a vectorised id.
      const vectorisedId = product.vectorisedDataId;
      if (vectorisedId) {
        try {
          await vectoriserFetch<unknown>(
            `${vectoriserConfig.baseUrl}/delete`,
            { product_id: productId, vectorised_id: vectorisedId },
            vectoriserConfig.timeoutSingleMs,
          );
          log('info', 'deleteVectorisation: upstream delete acknowledged', ctx);
        } catch (err: any) {
          // Non-critical — local state will still be reset below.
          log('warn', 'deleteVectorisation: upstream delete failed (non-critical)', {
            ...ctx,
            error: err.message,
          });
        }
      } else {
        log('info', 'deleteVectorisation: no vectorisedDataId — local reset only', ctx);
      }

      // Always reset local state.
      await ProductModel.updateOne(
        { _id: productId },
        {
          $set: {
            vectorisedDataId: null,
            vectorisationStatus: 'not_started',
          },
        },
      );
    } catch (err: any) {
      log('error', 'deleteVectorisation: unexpected failure', {
        ...ctx,
        error: err.message,
        stack: err.stack,
      });
    }
  }

  // ── Status-only notification ──────────────────────────────────────────────

  /**
   * Notify the vectoriser that a product's status has changed.
   *
   * Called when:
   *  - product status changes (active → archived, active → suspended, etc.)
   *
   * Only sends if the product already has a vectorisedDataId.
   * Uses the /vectoriser/status endpoint (no full payload needed).
   *
   * This is non-critical — a failure is logged but NOT retried.
   * The reconciliation script will handle any gaps.
   *
   * IMPORTANT: Call fire-and-forget (void, no await) from controllers.
   */
  async notifyStatusChange(productId: string, newStatus: string): Promise<void> {
    const ctx = { productId, newStatus };

    try {
      const product = await ProductModel.findOne({ _id: productId, deletedAt: null })
        .select('vectorisedDataId vectorisationStatus')
        .lean();

      if (!product?.vectorisedDataId) {
        // Product was never vectorised — nothing to update on the vectoriser side
        log('info', 'notifyStatusChange: product has no vectorisedDataId — skipping', ctx);
        return;
      }

      const payload = {
        product_id: productId,
        vectorised_id: product.vectorisedDataId,
        new_status: newStatus,
      };

      await vectoriserFetch<unknown>(
        `${vectoriserConfig.baseUrl}/status`,
        payload,
        vectoriserConfig.timeoutSingleMs,
      );

      log('info', 'notifyStatusChange: status notified', ctx);
    } catch (err: any) {
      // Non-critical — log but do not retry or rethrow
      log('warn', 'notifyStatusChange: failed to notify vectoriser (non-critical)', {
        ...ctx,
        error: err.message,
      });
    }
  }

  // ── Bulk vectorisation ────────────────────────────────────────────────────

  /**
   * Vectorise multiple products in a single batch request.
   *
   * Flow:
   *  1. Filter to only eligible products.
   *  2. Build payloads for all eligible products in parallel.
   *  3. POST array payload to /vectoriser.
   *  4. Bulk-write the returned vectorised IDs into MongoDB.
   *
   * Unlike vectoriseSingle, this method returns a result object (callers
   * such as the reconciliation script and the admin endpoint need the summary).
   *
   * @param productIds - Array of product IDs to attempt vectorisation for.
   */
  async vectoriseBulk(productIds: string[]): Promise<BulkVectorisationResult> {
    const errors: Array<{ productId: string; reason: string }> = [];
    const ctx = { count: productIds.length };

    log('info', 'vectoriseBulk: starting', ctx);

    if (productIds.length === 0) {
      return { succeeded: 0, failed: 0, total: 0, errors: [] };
    }

    // 1. Fetch all requested products and filter eligible ones
    const products = await ProductModel.find({
      _id: { $in: productIds },
      deletedAt: null,
    }).lean();

    const eligibleProducts = products.filter(p => this.isEligible(p));
    const skippedIds = products
      .filter(p => !this.isEligible(p))
      .map(p => p._id.toString());

    for (const id of skippedIds) {
      errors.push({ productId: id, reason: 'Not eligible for vectorisation (status, flag, or completeness)' });
    }

    // Also catch IDs that weren't found in DB at all
    const foundIds = new Set(products.map(p => p._id.toString()));
    for (const id of productIds) {
      if (!foundIds.has(id)) {
        errors.push({ productId: id, reason: 'Product not found' });
      }
    }

    if (eligibleProducts.length === 0) {
      log('info', 'vectoriseBulk: no eligible products', { ...ctx, skipped: skippedIds.length });
      return { succeeded: 0, failed: errors.length, total: productIds.length, errors };
    }

    // 2. Mark all eligible products as pending
    await ProductModel.updateMany(
      { _id: { $in: eligibleProducts.map(p => p._id) } },
      { $set: { vectorisationStatus: 'pending' } },
    );

    // 3. Build payloads in parallel (individual failures are caught per-product)
    const payloadResults = await Promise.allSettled(
      eligibleProducts.map(p => this.buildPayload(p._id.toString())),
    );

    const payloads: VectoriserPayloadEntry[] = [];
    const payloadIdMap: string[] = []; // parallel array — payloads[i] ↔ payloadIdMap[i]

    for (let i = 0; i < payloadResults.length; i++) {
      const result = payloadResults[i];
      const productId = eligibleProducts[i]._id.toString();

      if (result.status === 'rejected' || result.value === null) {
        errors.push({
          productId,
          reason: result.status === 'rejected' ? result.reason?.message ?? 'Payload build error' : 'Payload build returned null',
        });
        await ProductModel.updateOne({ _id: productId }, { $set: { vectorisationStatus: 'failed' } });
      } else {
        payloads.push(result.value);
        payloadIdMap.push(productId);
      }
    }

    if (payloads.length === 0) {
      log('error', 'vectoriseBulk: all payload builds failed', ctx);
      return { succeeded: 0, failed: errors.length, total: productIds.length, errors };
    }

    // 4. POST batch to vectoriser with retry
    let responses: VectoriserSingleResponse[];
    try {
      const raw = await withRetry(
        () =>
          vectoriserFetch<VectoriserSingleResponse[] | VectoriserBulkResponse>(
            vectoriserConfig.baseUrl,
            payloads,
            vectoriserConfig.timeoutBulkMs,
          ),
        vectoriserConfig.maxRetries,
        vectoriserConfig.retryBaseDelayMs,
        { ...ctx, operation: 'bulk' },
      );

      // Accept both array and { results: [] } shapes from the vectoriser
      responses = Array.isArray(raw) ? raw : (raw as VectoriserBulkResponse).results ?? [];
    } catch (err: any) {
      // Entire batch failed — mark all pending products as failed
      await ProductModel.updateMany(
        { _id: { $in: payloadIdMap } },
        { $set: { vectorisationStatus: 'failed' } },
      );
      for (const id of payloadIdMap) {
        errors.push({ productId: id, reason: `Batch request failed: ${err.message}` });
      }
      log('error', 'vectoriseBulk: batch request failed', { ...ctx, error: err.message });
      return { succeeded: 0, failed: errors.length, total: productIds.length, errors };
    }

    // 5. Bulk-write the returned vectorised IDs
    let succeeded = 0;
    await Promise.allSettled(
      responses.map(async entry => {
        try {
          await ProductModel.updateOne(
            { _id: entry.product_id },
            {
              $set: {
                vectorisedDataId: entry.vectorised_id,
                vectorisationStatus: 'completed',
              },
            },
          );
          succeeded++;
        } catch (dbErr: any) {
          errors.push({
            productId: entry.product_id,
            reason: `DB write failed: ${dbErr.message}`,
          });
        }
      }),
    );

    // Mark any products that the vectoriser did not return a result for as failed
    const returnedIds = new Set(responses.map(r => r.product_id));
    const missingIds = payloadIdMap.filter(id => !returnedIds.has(id));
    if (missingIds.length > 0) {
      await ProductModel.updateMany(
        { _id: { $in: missingIds } },
        { $set: { vectorisationStatus: 'failed' } },
      );
      for (const id of missingIds) {
        errors.push({ productId: id, reason: 'Vectoriser did not return a result for this product' });
      }
    }

    log('info', 'vectoriseBulk: completed', {
      ...ctx,
      succeeded,
      failed: errors.length,
    });

    return {
      succeeded,
      failed: errors.length,
      total: productIds.length,
      errors,
    };
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

/**
 * Module-level singleton — import this in controllers and scripts
 * instead of instantiating a new VectorisationService each time.
 */
export const vectorisationService = new VectorisationService();
