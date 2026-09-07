/**
 * VectorisationService
 *
 * Responsible for all interactions with the external vectoriser — the n8n
 * `wi-mall-vectoriser` workflow, at `vectoriserConfig.baseUrl`.
 *
 * ── The submit path is ASYNCHRONOUS, and that is the thing to know ───────────
 *
 * `POST <baseUrl>` answers **202** with `{ job_id, accepted[], rejected[] }` and
 * has embedded nothing yet. The per-product outcome arrives minutes later on
 * `POST /api/internal/vectoriser/callback`. So this service no longer learns
 * whether a product was indexed; it learns only whether the work was *taken on*.
 *
 * That splits the old single write into two, in two different requests:
 *
 *   here     — `pending` + a `vectorisationJob` claim ticket on the product
 *   callback — `completed` (+ `vectorisedDataId`) or `failed` (+ the refund)
 *
 * ⚠ **Both lists in the 202 must be read.** `accepted` means *genuinely pending,
 * wait for the callback*. `rejected` — and equally, silence: an id in neither
 * list — means *this one is already over*, because no callback will ever mention
 * it. Treating a 202 as success is how a product sits at `pending` forever with
 * the vendor's credit spent, and `pending` also locks the product against
 * editing (`require-product-editable.middleware`).
 *
 * Why async at all: Voyage plus a pgvector write for a few hundred products does
 * not fit inside `VECTORISER_TIMEOUT_BULK_MS`, and under the old synchronous
 * design a dropped connection lost the whole batch with every product left
 * `pending`. See `api-doc/n8n/vectoriser/README.md` § 2–4.
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
import { StoreModel } from '../../../store/models/store.model';
import { creditWalletService } from '../../../billing/services/credit-wallet.service';
import { VECTORISATION_COST } from '../../../billing/config/credit.config';
import { toFileDetail } from '../../read-models/file-detail.resolver';

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The **202** answered by `POST <baseUrl>` — the only thing a submit returns now.
 *
 * `accepted` and `rejected` are the whole contract: an id in `accepted` gets a
 * callback, an id anywhere else does not. A `rejected` entry may carry
 * `product_id: null` — that is the vectoriser naming a payload entry it could not
 * link back to a product at all ("no product_id on entry 2").
 */
export interface VectoriserAcceptedResponse {
  success?: boolean;
  job_id: string | number;
  accepted?: string[];
  rejected?: Array<{ product_id: string | null; reason: string }>;
  callback_url?: string;
}

/** One product's outcome inside a callback report. */
export interface VectoriserCallbackResult {
  product_id: string;
  status: string;
  vectorised_id?: string | null;
  error?: string | null;
}

/** The body of `POST /api/internal/vectoriser/callback` — README § 3. */
export interface VectoriserCallbackReport {
  job_id: string;
  finished_at?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  results: VectoriserCallbackResult[];
}

/** What `applyCallbackReport` did, per product and in total. */
export interface CallbackApplyResult {
  jobId: string;
  /** Rows whose claim ticket matched and whose outcome was written. */
  applied: number;
  /** Marked `completed` (a subset of `applied`). */
  completed: number;
  /** Marked `failed` (a subset of `applied`). */
  failed: number;
  /** Credits actually returned to a vendor wallet. */
  refunded: number;
  /**
   * Results whose claim ticket did NOT match — a duplicate or late report, a
   * product deleted meanwhile, or an attempt already resolved. Not an error.
   */
  ignored: string[];
  /** Results carrying a status this service does not know. Written nowhere, logged loudly. */
  unknown: Array<{ product_id: string; status: string }>;
}

/** Shape of one entry in the bulk-vectorise payload array */
export interface VectoriserPayloadEntry {
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

/**
 * Result returned from vectoriseBulk to callers (the admin endpoint and the
 * reconciliation script).
 *
 * ⚠ The first field was `succeeded` until the vectoriser went async, and the
 * rename is the point: nothing here has been indexed yet. `accepted` counts
 * products the vectoriser **took on** — their real outcome lands later, on the
 * callback. Keeping the old name would have left every caller reporting
 * "N succeeded" about work that had not started.
 */
export interface BulkVectorisationResult {
  /** Taken on by the vectoriser and now `pending` a callback. NOT "indexed". */
  accepted: number;
  /** Over already: ineligible, not found, payload build failed, or rejected at the gate. */
  failed: number;
  total: number;
  errors: Array<{ productId: string; reason: string }>;
}

/** What `buildPayloadsFor` answers — the body of `POST /internal/vectoriser/payloads`. */
export interface PayloadBatch {
  products: VectoriserPayloadEntry[];
  /** Ids that produced no payload: not found, or the build threw. */
  missing: string[];
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
 *  - Attaches the VECTORISER_API_KEY auth header.
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
        ...(vectoriserConfig.apiKey ? { 'VECTORISER_API_KEY': vectoriserConfig.apiKey } : {}),
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
        // Business name/description live on the Store (source of truth).
        const store = await StoreModel.findOne({ vendor_id: vendorDoc._id }).select('name description').lean();
        vendor = {
          id: vendorDoc._id.toString(),
          business_name: store?.name ?? null,
          display_name: vendorDoc.display_name,
          business_description: store?.description ?? null,
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
        // The payload shape is the vectoriser's own, not a `FileDetail` — but the URL
        // DECISION is the platform's, so it is taken from the shared resolver and the
        // fields this service wants are picked off the result.
        //
        // ⚠ This used to re-implement that decision inline, and the copy went stale in
        // exactly the way a copy does: it grew the private-tree rule (ADR-A01 D-2) and
        // would have had to grow the plan-quota rule separately, so an owner over their
        // storage cap would have had blocked images published to an external service —
        // the one place on the platform still handing them out. `test:uploads` now
        // refuses any `getPublicUrl` call outside the resolver, which is what makes a
        // third copy impossible rather than merely discouraged.
        const detail = toFileDetail(
          {
            id: f._id.toString(),
            key: f.key,
            mimeType: f.mimeType,
            size: f.size,
            originalName: f.originalName,
            quotaBlockedAt: f.quotaBlockedAt,
          },
          storage,
        );
        fileMap.set(f._id.toString(), {
          id: detail.id,
          url: detail.url,
          mimeType: detail.mimeType,
          size: detail.size,
          originalName: detail.originalName ?? null,
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
        // The haggling window the negotiating agent bargains within. Null when the
        // vendor configured none. No `bargainable` flag is sent: this payload is
        // only built for products that passed `isEligible`, which already requires
        // vectorisationEnabled === true, so a window reaching the indexer is
        // effective by construction.
        bargain: v.bargain ? { minPrice: v.bargain.minPrice, maxPrice: v.bargain.maxPrice } : null,
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
        { $set: { vectorisationEnabled: false, vectorisationStatus: 'not_started', vectorisationJob: null } },
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
    // from this point forward. The claim ticket goes with it: a new attempt is
    // starting, so a late callback for the PREVIOUS job must no longer match.
    await ProductModel.updateOne(
      { _id: productId },
      { $set: { vectorisationStatus: 'pending', vectorisationJob: null } },
    );

    const payload = await this.buildPayload(productId);
    if (!payload) {
      await ProductModel.updateOne(
        { _id: productId },
        { $set: { vectorisationStatus: 'failed', vectorisationJob: null } },
      );
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
   * vectoriser and record what it SAID — which is not what it did.
   *
   * The answer is a 202. On `accepted` this writes the claim ticket and leaves
   * the product `pending`; the outcome, the `vectorisedDataId` and (on failure)
   * the refund all land later in `applyCallbackReport`. On `rejected` — or on an
   * id the 202 mentions in neither list — the attempt is over now, because no
   * callback will ever name it, so it is failed and refunded here.
   *
   * IMPORTANT: Fire-and-forget — swallows all errors internally and never rejects.
   * Pair with prepareForVectorisation().
   */
  async executePreparedVectorisation(productId: string, payload: VectoriserPayloadEntry): Promise<void> {
    const ctx = { productId };

    // Resolve the owning vendor so the vectorisation can be billed in credits.
    const product = await ProductModel.findById(productId).select('vendorId').lean();
    if (!product) {
      log('warn', 'executePreparedVectorisation: product not found', ctx);
      return;
    }
    const vendorId = product.vendorId.toString();

    // Charge credits up-front so unpaid usage can't slip through. If the vendor
    // can't cover it, skip vectorisation and surface a distinct status the
    // frontend can use to prompt a top-up. (Refunded below if the call fails.)
    // VECTORISATION_COST = 0 means free — skip billing entirely (no ledger noise).
    if (VECTORISATION_COST > 0) {
      try {
        await creditWalletService.debit('vendor', vendorId, VECTORISATION_COST, 'vectorisation', productId);
      } catch (err: any) {
        if (err?.code === ERROR_CODES.BILLING_INSUFFICIENT_CREDITS) {
          await ProductModel.updateOne(
            { _id: productId },
            { $set: { vectorisationStatus: 'skipped_no_credits', vectorisationJob: null } },
          ).catch(() => undefined);
          log('warn', 'executePreparedVectorisation: skipped — insufficient credits', { ...ctx, vendorId });
          return;
        }
        await ProductModel.updateOne(
          { _id: productId },
          { $set: { vectorisationStatus: 'failed', vectorisationJob: null } },
        ).catch(() => undefined);
        log('error', 'executePreparedVectorisation: credit debit failed', { ...ctx, error: err.message });
        return;
      }
    }

    const billed = VECTORISATION_COST > 0;

    let response: VectoriserAcceptedResponse;
    try {
      response = await withRetry(
        () =>
          vectoriserFetch<VectoriserAcceptedResponse>(
            vectoriserConfig.baseUrl,
            payload,
            vectoriserConfig.timeoutSingleMs,
          ),
        vectoriserConfig.maxRetries,
        vectoriserConfig.retryBaseDelayMs,
        ctx,
      );
    } catch (err: any) {
      await this.failAndRefund(productId, vendorId, billed, `Request failed: ${err.message}`, {
        ...ctx,
        stack: err.stack,
      });
      return;
    }

    const jobId = String(response?.job_id ?? '');
    const accepted = new Set((response?.accepted ?? []).map(String));

    if (!accepted.has(productId)) {
      // Rejected at the gate, or simply absent from both lists. Either way no
      // callback is coming, so this attempt is over NOW.
      //
      // One entry was sent, so any rejection reason in the answer is this
      // product's — including one the vectoriser could not attach to an id and
      // reported as `product_id: null`.
      const reason =
        response?.rejected?.find(r => String(r?.product_id ?? '') === productId)?.reason ??
        response?.rejected?.[0]?.reason ??
        'Vectoriser accepted no products and gave no reason';
      await this.failAndRefund(productId, vendorId, billed, `Rejected by the vectoriser: ${reason}`, ctx);
      return;
    }

    if (!jobId) {
      // Accepted with no job id is unusable: the callback matches on it, so
      // nothing could ever resolve this product. Fail it here rather than leave
      // it pending forever — `pending` also locks the product against editing.
      await this.failAndRefund(
        productId,
        vendorId,
        billed,
        'Vectoriser accepted the product but returned no job_id',
        ctx,
      );
      return;
    }

    await ProductModel.updateOne(
      { _id: productId },
      {
        $set: {
          vectorisationStatus: 'pending',
          vectorisationJob: { jobId, billed, requestedAt: new Date() },
        },
      },
    );

    log('info', 'executePreparedVectorisation: accepted — awaiting callback', {
      ...ctx,
      jobId,
      billed,
    });
  }

  /**
   * Mark an attempt failed and return the credit if this attempt paid for one.
   *
   * The single exit for every failure VISIBLE BEFORE THE 202 — the request
   * itself, a rejection at the gate, an unusable answer. It exists as a method
   * rather than a catch block because the not-accepted case is not an exception:
   * the vectoriser answered, correctly, that it would not do the work.
   *
   * ⚠ **It must never run for an attempt that was accepted.** An accepted
   * product's failure is reported on the callback and refunded by
   * `applyCallbackReport` off the stored `billed` flag; both firing for one
   * attempt pays the vendor twice.
   */
  private async failAndRefund(
    productId: string,
    vendorId: string,
    billed: boolean,
    reason: string,
    ctx: Record<string, unknown>,
  ): Promise<void> {
    if (billed) {
      await creditWalletService
        .credit('vendor', vendorId, VECTORISATION_COST, 'refund', 'vectorisation', productId)
        .catch((creditErr: any) => {
          log('error', 'executePreparedVectorisation: REFUND FAILED — credit owed to vendor', {
            ...ctx,
            vendorId,
            amount: VECTORISATION_COST,
            error: creditErr?.message,
          });
        });
    }

    try {
      await ProductModel.updateOne(
        { _id: productId },
        { $set: { vectorisationStatus: 'failed', vectorisationJob: null } },
      );
    } catch (dbErr: any) {
      log('error', 'executePreparedVectorisation: failed to write failure status to DB', {
        ...ctx,
        dbError: dbErr.message,
      });
    }

    log('error', 'executePreparedVectorisation: failed', { ...ctx, reason, refunded: billed });
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

      // Always reset local state — including the claim ticket, so a callback for
      // an attempt that was in flight when the vendor switched vectorisation off
      // cannot write `completed` back onto a product that no longer wants it.
      await ProductModel.updateOne(
        { _id: productId },
        {
          $set: {
            vectorisedDataId: null,
            vectorisationStatus: 'not_started',
            vectorisationJob: null,
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
   *  3. POST the array to the vectoriser and read its 202.
   *  4. Write a claim ticket for every ACCEPTED product; fail the rest.
   *
   * ⚠ **Nothing here is indexed when this returns.** Step 4 used to write the
   * returned vectorised ids; there are none now. Accepted products are left
   * `pending`, and `applyCallbackReport` finishes them minutes later. The result
   * field is named `accepted` rather than `succeeded` for exactly that reason.
   *
   * Unlike vectoriseSingle, this method returns a result object (callers
   * such as the reconciliation script and the admin endpoint need the summary).
   *
   * BILLING: intentionally NOT credit-debited. This is an admin-only platform
   * maintenance operation (POST /api/admin/products/bulk-vectorise) that can span
   * every vendor's catalogue — vendors must not be charged for re-vectorisation
   * they did not initiate. Every vendor-facing path (create/update/toggle/retry)
   * funnels through executePreparedVectorisation, which IS debited, so no
   * vendor-accessible route bypasses credits.
   *
   * ⚠ That is why each claim ticket below is written with `billed: false`. The
   * callback refunds off that flag, and the callback body is IDENTICAL for both
   * paths — so a `true` here would hand a vendor a credit they never spent every
   * time an admin sweep failed on their product.
   *
   * @param productIds - Array of product IDs to attempt vectorisation for.
   */
  async vectoriseBulk(productIds: string[]): Promise<BulkVectorisationResult> {
    const errors: Array<{ productId: string; reason: string }> = [];
    const ctx = { count: productIds.length };

    log('info', 'vectoriseBulk: starting', ctx);

    if (productIds.length === 0) {
      return { accepted: 0, failed: 0, total: 0, errors: [] };
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
      return { accepted: 0, failed: errors.length, total: productIds.length, errors };
    }

    // 2. Mark all eligible products as pending, and drop any stale claim ticket
    // from an earlier attempt — a late callback for the OLD job must not be able
    // to resolve the new one.
    await ProductModel.updateMany(
      { _id: { $in: eligibleProducts.map(p => p._id) } },
      { $set: { vectorisationStatus: 'pending', vectorisationJob: null } },
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
        await ProductModel.updateOne(
          { _id: productId },
          { $set: { vectorisationStatus: 'failed', vectorisationJob: null } },
        );
      } else {
        payloads.push(result.value);
        payloadIdMap.push(productId);
      }
    }

    if (payloads.length === 0) {
      log('error', 'vectoriseBulk: all payload builds failed', ctx);
      return { accepted: 0, failed: errors.length, total: productIds.length, errors };
    }

    // 4. POST batch to vectoriser with retry
    let response: VectoriserAcceptedResponse;
    try {
      response = await withRetry(
        () =>
          vectoriserFetch<VectoriserAcceptedResponse>(
            vectoriserConfig.baseUrl,
            payloads,
            vectoriserConfig.timeoutBulkMs,
          ),
        vectoriserConfig.maxRetries,
        vectoriserConfig.retryBaseDelayMs,
        { ...ctx, operation: 'bulk' },
      );
    } catch (err: any) {
      // Entire batch failed — mark all pending products as failed
      await ProductModel.updateMany(
        { _id: { $in: payloadIdMap } },
        { $set: { vectorisationStatus: 'failed', vectorisationJob: null } },
      );
      for (const id of payloadIdMap) {
        errors.push({ productId: id, reason: `Batch request failed: ${err.message}` });
      }
      log('error', 'vectoriseBulk: batch request failed', { ...ctx, error: err.message });
      return { accepted: 0, failed: errors.length, total: productIds.length, errors };
    }

    // 5. Split the 202 into "now genuinely pending" and "already over".
    //
    // Rejection reasons are keyed by product id where the vectoriser could read
    // one. Entries with `product_id: null` are payloads it could not link back to
    // a product at all — they cannot be attributed to any id here, so they are
    // counted and logged rather than pinned on an arbitrary victim.
    const jobId = String(response?.job_id ?? '');
    const acceptedIds = new Set((response?.accepted ?? []).map(String));
    const rejectionReasons = new Map<string, string>();
    let unattributedRejections = 0;
    for (const entry of response?.rejected ?? []) {
      const id = entry?.product_id == null ? '' : String(entry.product_id);
      if (id) rejectionReasons.set(id, entry.reason);
      else unattributedRejections++;
    }

    // No job id means no callback can ever be matched to these products, so an
    // "accepted" list without one is not something to wait on.
    const acceptedSet = new Set(jobId ? payloadIdMap.filter(id => acceptedIds.has(id)) : []);
    const acceptedForThisJob = [...acceptedSet];
    const notAccepted = payloadIdMap.filter(id => !acceptedSet.has(id));

    if (acceptedForThisJob.length > 0) {
      // billed: false — this path never debits. See the BILLING note above.
      await ProductModel.updateMany(
        { _id: { $in: acceptedForThisJob } },
        {
          $set: {
            vectorisationStatus: 'pending',
            vectorisationJob: { jobId, billed: false, requestedAt: new Date() },
          },
        },
      );
    }

    if (notAccepted.length > 0) {
      await ProductModel.updateMany(
        { _id: { $in: notAccepted } },
        { $set: { vectorisationStatus: 'failed', vectorisationJob: null } },
      );
      const fallback = jobId
        ? 'Not in the accepted list — no callback will ever report this product'
        : 'Vectoriser returned no job_id, so no callback could be matched';
      for (const id of notAccepted) {
        errors.push({ productId: id, reason: rejectionReasons.get(id) ?? fallback });
      }
    }

    log('info', 'vectoriseBulk: submitted — outcomes arrive on the callback', {
      ...ctx,
      jobId: jobId || null,
      accepted: acceptedForThisJob.length,
      failed: errors.length,
      unattributedRejections,
    });

    return {
      accepted: acceptedForThisJob.length,
      failed: errors.length,
      total: productIds.length,
      errors,
    };
  }

  // ── The internal door: payload fetch + the async callback ─────────────────

  /**
   * Build payloads for a list of product ids — the body of
   * `POST /api/internal/vectoriser/payloads`.
   *
   * ⚠ **No eligibility filter, deliberately.** This serves the SPREADSHEET path:
   * a human named these ids in a file, and a row silently dropped because the
   * product is a draft is a row they will never learn about. `buildPayload`
   * either produces a payload or it does not, and everything else comes back in
   * `missing` for the caller to report. Eligibility is a jovi-mall-initiated
   * concern (`prepareForVectorisation`), not a lookup concern.
   *
   * ⚠ **It writes nothing.** No status, no credit, no claim ticket. A product
   * only becomes `pending` when the vectoriser's 202 says it was accepted, and
   * that answer comes back to `applyCallbackReport`, not here.
   *
   * Chunked rather than one `Promise.all` over the whole list: `buildPayload`
   * runs the better part of a dozen queries per product, so a 500-id sheet
   * unbounded is several thousand concurrent reads against a pool of 100.
   */
  async buildPayloadsFor(productIds: string[]): Promise<PayloadBatch> {
    const products: VectoriserPayloadEntry[] = [];
    const missing: string[] = [];

    const CONCURRENCY = 25;
    for (let i = 0; i < productIds.length; i += CONCURRENCY) {
      const chunk = productIds.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(chunk.map(id => this.buildPayload(id)));

      settled.forEach((result, idx) => {
        const productId = chunk[idx];
        if (result.status === 'fulfilled' && result.value) {
          products.push(result.value);
        } else {
          missing.push(productId);
          if (result.status === 'rejected') {
            log('warn', 'buildPayloadsFor: payload build threw', {
              productId,
              error: result.reason?.message ?? String(result.reason),
            });
          }
        }
      });
    }

    log('info', 'buildPayloadsFor: done', {
      requested: productIds.length,
      built: products.length,
      missing: missing.length,
    });

    return { products, missing };
  }

  /**
   * Apply the vectoriser's asynchronous report — the body of
   * `POST /api/internal/vectoriser/callback`.
   *
   * This is where a product's vectorisation actually FINISHES. The submit paths
   * only ever record that the work was taken on.
   *
   * ── Idempotency, and why it is a compare-and-set ────────────────────────────
   *
   * Every write is `findOneAndUpdate({ _id, 'vectorisationJob.jobId': jobId })`,
   * which CLAIMS the attempt and reports the pre-update document in one round
   * trip. A duplicate report, a report for an attempt already superseded by a
   * newer submit, or one for a product whose vendor switched vectorisation off
   * meanwhile all match zero documents and land in `ignored`. That is the whole
   * mechanism — there is no separate seen-job store.
   *
   * ⚠ **The claim happens BEFORE the refund, and the order is load-bearing.**
   * Refunding first and claiming second lets two deliveries of the same report
   * pay a vendor twice. This way the worst case is a refund that fails after the
   * claim — one credit not returned, logged at error level — rather than credits
   * minted by a retry. Same direction as every other money path here: never pay
   * twice, and make the miss loud.
   *
   * ⚠ **`billed` comes off the claim ticket, never off `VECTORISATION_COST`.**
   * The admin bulk path debits nothing and produces a byte-identical callback
   * body, so reading the current cost instead would refund credits that were
   * never spent.
   *
   * An unrecognised `status` is recorded in `unknown` and written nowhere.
   * Guessing between "completed" and "failed" on a value we do not know is how a
   * product ends up marked indexed with no row behind it — the exact failure the
   * vectoriser's own `RETURNING` guard exists to prevent on the other side.
   */
  async applyCallbackReport(report: VectoriserCallbackReport): Promise<CallbackApplyResult> {
    const jobId = String(report.job_id);
    const out: CallbackApplyResult = {
      jobId,
      applied: 0,
      completed: 0,
      failed: 0,
      refunded: 0,
      ignored: [],
      unknown: [],
    };

    for (const result of report.results) {
      const productId = String(result.product_id ?? '');
      const status = String(result.status ?? '');

      // A malformed id would make Mongoose throw a CastError on the claim, which
      // would abandon the rest of the report. Treat it as unmatchable instead.
      if (!productId || !Types.ObjectId.isValid(productId)) {
        out.unknown.push({ product_id: productId, status });
        log('warn', 'applyCallbackReport: unusable product_id in report', { jobId, productId });
        continue;
      }

      if (status !== 'completed' && status !== 'failed') {
        out.unknown.push({ product_id: productId, status });
        log('error', 'applyCallbackReport: unrecognised result status — nothing written', {
          jobId,
          productId,
          status,
        });
        continue;
      }

      const $set =
        status === 'completed'
          ? {
              // `vectorised_id` IS the product id by design (README § 3) — one
              // logical document per product, so there is no second identity to
              // invent. Falling back to the product id keeps the "has been
              // indexed at least once" flag true even if the field is omitted.
              vectorisedDataId: result.vectorised_id ? String(result.vectorised_id) : productId,
              vectorisationStatus: 'completed' as const,
              vectorisationJob: null,
            }
          : { vectorisationStatus: 'failed' as const, vectorisationJob: null };

      let claimed;
      try {
        claimed = await ProductModel.findOneAndUpdate(
          { _id: productId, 'vectorisationJob.jobId': jobId },
          { $set },
          { new: false, projection: { vendorId: 1, vectorisationJob: 1 } },
        ).lean();
      } catch (dbErr: any) {
        // A DB failure is NOT "ignored" — nothing was claimed, so the product is
        // still pending and a re-delivery of this report would still resolve it.
        out.unknown.push({ product_id: productId, status });
        log('error', 'applyCallbackReport: claim write failed', {
          jobId,
          productId,
          error: dbErr.message,
        });
        continue;
      }

      if (!claimed) {
        out.ignored.push(productId);
        log('info', 'applyCallbackReport: no matching claim — ignored', { jobId, productId, status });
        continue;
      }

      out.applied++;
      if (status === 'completed') {
        out.completed++;
        continue;
      }

      out.failed++;

      const wasBilled = claimed.vectorisationJob?.billed === true;
      if (wasBilled && VECTORISATION_COST > 0) {
        const vendorId = claimed.vendorId?.toString();
        if (!vendorId) {
          log('error', 'applyCallbackReport: refund owed but product has no vendorId', { jobId, productId });
        } else {
          try {
            await creditWalletService.credit(
              'vendor',
              vendorId,
              VECTORISATION_COST,
              'refund',
              'vectorisation',
              productId,
            );
            out.refunded++;
          } catch (creditErr: any) {
            // Loud on purpose: the claim is already spent, so this credit is not
            // coming back on a retry of the same report. It needs a human.
            log('error', 'applyCallbackReport: REFUND FAILED — credit owed to vendor', {
              jobId,
              productId,
              vendorId,
              amount: VECTORISATION_COST,
              error: creditErr.message,
            });
          }
        }
      }

      log('info', 'applyCallbackReport: product failed upstream', {
        jobId,
        productId,
        refunded: wasBilled && VECTORISATION_COST > 0,
        error: result.error ?? null,
      });
    }

    log('info', 'applyCallbackReport: report applied', {
      jobId,
      reported: report.results.length,
      applied: out.applied,
      completed: out.completed,
      failed: out.failed,
      refunded: out.refunded,
      ignored: out.ignored.length,
      unknown: out.unknown.length,
    });

    return out;
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

/**
 * Module-level singleton — import this in controllers and scripts
 * instead of instantiating a new VectorisationService each time.
 */
export const vectorisationService = new VectorisationService();
