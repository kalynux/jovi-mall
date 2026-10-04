import { Types } from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { logger } from '../../../core/logging/logger';
import { aiCopyConfig } from '../../../config/ai-copy.config';
import { AI_COPY_FIELD_COST } from '../../billing/config/credit.config';
import { creditWalletService, CreditWalletService } from '../../billing/services/credit-wallet.service';
import { ProductModel } from '../../catalog/models/product.model';
import { categoryCatalogCache } from '../../categories/services/category-catalog.cache';
import { CategoryCandidate, searchCategories } from '../../categories/domain/category-match';
import { AiCopyRequest } from '../validators/ai-copy.validator';
import { AiCopyGenerationModel, AiCopyOutcome } from '../models/ai-copy-generation.model';
import { loadImagesForModel } from './ai-copy-images';
import { callAiCopyWorkflow, WorkflowVerdict } from '../clients/ai-copy-workflow.client';
import { sanitizeOutput } from '../domain/ai-copy-output';
import { AiCopyField, AiCopyResponseData, AiCopyWorkflowRequest, LANGUAGE_NAMES } from '../ai-copy.types';

/** Below this many live categories the model sees the whole list; above it, the best matches. */
const WHOLE_LIST_UP_TO = 80;
const CANDIDATES_MAX = 50;

/**
 * Pick the existing categories the model may choose from.
 *
 * The owner's rule (2026-10-04): existing categories first, a new name only if nothing fits.
 * That only works if the model can SEE the existing ones, and a list of thousands would drown
 * the prompt — so a large catalogue is narrowed with the same search behind
 * `GET /vendor/categories?q=`, run on the name and on each word of the notes.
 */
export function pickCandidates(
  catalog: readonly CategoryCandidate[],
  title: string,
  notes: string | undefined,
): CategoryCandidate[] {
  if (catalog.length <= WHOLE_LIST_UP_TO) return [...catalog];
  const out = new Map<string, CategoryCandidate>();
  const queries = [title, ...title.split(/\s+/), ...(notes ?? '').split(/[\s,;.]+/)].filter((q) => q.length >= 3);
  for (const q of queries) {
    for (const hit of searchCategories(q, catalog, CANDIDATES_MAX)) {
      out.set(hit.category.id, hit.category);
      if (out.size >= CANDIDATES_MAX) return [...out.values()];
    }
  }
  return [...out.values()];
}

/** What the prompt calls the thing. */
function typeNoun(body: AiCopyRequest): string {
  if (body.target === 'service') return 'service';
  return body.productType === 'digital' ? 'digital product' : 'physical product';
}

/**
 * Everything `generate` reaches outside itself for. Injected so `test:ai-copy` can drive the
 * charge → refund path — the part a vendor's money depends on — without a database or n8n.
 */
export interface AiCopyDeps {
  wallet: Pick<CreditWalletService, 'debit' | 'credit' | 'getBalance'>;
  listingBelongsTo: (listingId: string, vendorId: string) => Promise<boolean>;
  loadImages: (vendorId: string, fileIds: string[]) => Promise<string[]>;
  loadCatalog: () => Promise<readonly CategoryCandidate[]>;
  callWorkflow: (payload: AiCopyWorkflowRequest) => Promise<WorkflowVerdict>;
  writeLog: (row: Record<string, unknown>) => Promise<unknown>;
  enabled: () => boolean;
}

const defaultDeps: AiCopyDeps = {
  wallet: creditWalletService,
  listingBelongsTo: async (listingId, vendorId) =>
    !!(await ProductModel.findOne({ _id: listingId, vendorId, deletedAt: null }).select('_id').lean()),
  loadImages: loadImagesForModel,
  loadCatalog: () => categoryCatalogCache.list(),
  callWorkflow: callAiCopyWorkflow,
  writeLog: (row) => AiCopyGenerationModel.create(row),
  enabled: () => aiCopyConfig.enabled,
};

export class AiCopyService {
  private readonly deps: AiCopyDeps;
  private readonly wallet: AiCopyDeps['wallet'];

  constructor(deps: Partial<AiCopyDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
    this.wallet = this.deps.wallet;
  }

  /**
   * Charge → ask the model → check → refund what failed → log.
   *
   * Every refusal that can happen without the model (validation, ownership, photos, an empty
   * wallet, the feature switched off) happens BEFORE the charge. After the charge, every exit
   * path refunds what the vendor did not receive — that ordering is the whole promise of
   * "You weren't charged".
   */
  async generate(vendorId: string, body: AiCopyRequest): Promise<AiCopyResponseData> {
    if (!this.deps.enabled()) {
      throw createAppError(ERROR_CODES.AI_COPY_UNAVAILABLE, 503, undefined, { reason: 'disabled' });
    }

    if (body.listingId) {
      // Same answer as the product routes for a listing that is not this vendor's.
      if (!(await this.deps.listingBelongsTo(body.listingId, vendorId))) {
        throw createAppError(ERROR_CODES.CATALOG_PRODUCT_NOT_FOUND, 404);
      }
    }

    const images = await this.deps.loadImages(vendorId, body.input.imageFileIds);

    const wantsCategories = body.fields.includes('categories');
    const catalog = wantsCategories ? await this.deps.loadCatalog() : [];
    const candidates = wantsCategories ? pickCandidates(catalog, body.input.title, body.input.notes) : [];

    const generationId = new Types.ObjectId();
    const ref = generationId.toString();
    const charged = body.fields.length * AI_COPY_FIELD_COST;

    // Up front, before any model money is spent. `BILLING_INSUFFICIENT_CREDITS` (402) passes
    // straight through — the dashboard renders it with a top-up link.
    let balance = charged > 0
      ? (await this.wallet.debit('vendor', vendorId, charged, 'ai_listing_copy', ref)).balance
      : await this.wallet.getBalance('vendor', vendorId);

    const payload: AiCopyWorkflowRequest = {
      generationId: ref,
      target: body.target,
      productType: body.target === 'product' ? body.productType ?? null : null,
      language: body.language,
      languageName: LANGUAGE_NAMES[body.language],
      fields: [...body.fields],
      input: {
        name: body.input.title,
        type: typeNoun(body),
        currentCategories: body.input.categories.map((c) => c.name),
        vendorNotes: body.input.notes ?? '',
      },
      ...(wantsCategories ? { candidates: candidates.map((c) => ({ id: c.id, name: c.name })) } : {}),
      ...(body.previous ? { previous: body.previous } : {}),
      images,
    };

    const started = Date.now();
    const verdict: WorkflowVerdict = await this.deps.callWorkflow(payload);
    const latencyMs = Date.now() - started;

    let results: AiCopyResponseData['results'] = {};
    let failed: AiCopyField[] = [...body.fields];
    let errorReason: string | null = null;
    if (verdict.kind === 'ok') {
      ({ results, failed } = sanitizeOutput(body.fields, verdict.body.output, { candidates, catalog }));
      if (failed.length > 0) errorReason = `unusable: ${failed.join(', ')}`;
    } else {
      errorReason = verdict.reason;
    }

    const refund = failed.length * AI_COPY_FIELD_COST;
    if (refund > 0) {
      try {
        balance = (await this.wallet.credit('vendor', vendorId, refund, 'refund', 'ai_listing_copy', ref)).balance;
      } catch (err: any) {
        // The vendor is owed this and did not get it. Loud, with everything support needs to
        // credit it by hand — and the call still answers, because failing the request would
        // hide the text they DID pay for.
        logger().error(
          { err: err?.message, vendorId, generationId: ref, refund },
          'ai-copy: REFUND FAILED — vendor owed credits',
        );
        errorReason = `${errorReason ?? ''} · refund of ${refund} failed`.trim();
      }
    }

    const creditsCharged = charged - refund;
    const outcome: AiCopyOutcome =
      verdict.kind === 'unavailable' ? 'unavailable'
        : failed.length === 0 ? 'succeeded'
          : failed.length === body.fields.length ? 'failed'
            : 'partial';

    const answer = verdict.kind === 'unavailable' ? undefined : verdict.body;
    await this.deps.writeLog({
      _id: generationId,
      vendorId: new Types.ObjectId(vendorId),
      listingId: body.listingId ? new Types.ObjectId(body.listingId) : null,
      target: body.target,
      productType: payload.productType,
      language: body.language,
      fields: body.fields,
      failed,
      outcome,
      creditsCharged,
      imageFileIds: body.input.imageFileIds.map((id) => new Types.ObjectId(id)),
      promptVersion: answer?.promptVersion ?? null,
      modelId: answer?.model ?? null,
      latencyMs,
      inputTokens: answer?.usage?.inputTokens ?? null,
      outputTokens: answer?.usage?.outputTokens ?? null,
      errorReason,
    }).catch((err: any) => {
      // The log is for support; losing one row must not cost the vendor the answer.
      logger().warn({ err: err?.message, generationId: ref }, 'ai-copy: generation log write failed');
    });

    if (outcome === 'unavailable') {
      logger().warn({ vendorId, generationId: ref, reason: errorReason }, 'ai-copy: workflow unavailable');
      throw createAppError(ERROR_CODES.AI_COPY_UNAVAILABLE, 503);
    }
    if (outcome === 'failed') {
      logger().warn({ vendorId, generationId: ref, reason: errorReason }, 'ai-copy: nothing usable');
      throw createAppError(ERROR_CODES.AI_COPY_FAILED, 502);
    }

    return { results, failed, creditsCharged, balance, generationId: ref };
  }
}

export const aiCopyService = new AiCopyService();
