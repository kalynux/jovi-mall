import type { RichDoc } from '../../core/richtext';

/**
 * AI listing copy — the vendor dashboard's "Generate" button beside a product or
 * service description. Contract: api-doc/vendor/ai-listing-copy.md.
 *
 * jovi-mall owns the vendor, the photos, the credits, the category list and the
 * check of what comes back. The n8n `UP-wi-mall-ai-listing-copy` workflow owns the
 * system prompt and the model. Nothing here saves a product.
 */

/** What the vendor can ask for. Each one costs `AI_COPY_FIELD_COST` on its own. */
export const AI_COPY_FIELDS = ['description', 'tags', 'seoTitle', 'seoDescription', 'categories'] as const;
export type AiCopyField = (typeof AI_COPY_FIELDS)[number];

/** The languages the storefront renders in. The model writes in exactly one. */
export const AI_COPY_LANGUAGES = ['en', 'fr', 'es', 'pt', 'ar'] as const;
export type AiCopyLanguage = (typeof AI_COPY_LANGUAGES)[number];

/** Sent to the workflow, which puts it in the prompt ("Write ONLY in French"). */
export const LANGUAGE_NAMES: Readonly<Record<AiCopyLanguage, string>> = Object.freeze({
  en: 'English',
  fr: 'French',
  es: 'Spanish',
  pt: 'Portuguese',
  ar: 'Arabic',
});

export type AiCopyTarget = 'product' | 'service';
export type AiCopyProductType = 'physical' | 'digital';

export interface AiCopyCategorySuggestion {
  /** Present when the suggestion is an existing category. */
  id?: string;
  name: string;
}

/** Only the fields that came back usable. A requested field missing here is in `failed`. */
export interface AiCopyResults {
  description?: { descriptionRich: RichDoc };
  tags?: string[];
  seoTitle?: string;
  seoDescription?: string;
  categories?: AiCopyCategorySuggestion[];
}

export interface AiCopyResponseData {
  results: AiCopyResults;
  failed: AiCopyField[];
  creditsCharged: number;
  balance: number;
  generationId: string;
}

// ─── The n8n contract ────────────────────────────────────────────────────────

/** The body jovi-mall POSTs to the workflow. */
export interface AiCopyWorkflowRequest {
  generationId: string;
  target: AiCopyTarget;
  productType: AiCopyProductType | null;
  language: AiCopyLanguage;
  languageName: string;
  fields: AiCopyField[];
  input: {
    name: string;
    /** "physical product" · "digital product" · "service" — what the prompt calls it. */
    type: string;
    currentCategories: string[];
    vendorNotes: string;
  };
  /** Existing categories the model may pick from. Absent unless `categories` was asked for. */
  candidates?: Array<{ id: string; name: string }>;
  /** Regenerate only: last time's text for the requested field. */
  previous?: Record<string, unknown>;
  /** 1–4 `data:image/jpeg;base64,…` URLs, already shrunk. The first is the main photo. */
  images: string[];
}

/**
 * What the workflow answers on success. `output` is UNTRUSTED model output in roughly
 * the requested shape; `sanitizeOutput` decides what survives.
 */
export interface AiCopyWorkflowResponse {
  success: boolean;
  promptVersion?: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  output?: Record<string, unknown>;
  error?: string;
}
