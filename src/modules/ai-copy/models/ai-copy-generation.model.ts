import mongoose, { Schema, Document, Types } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';

/**
 * One row per `POST /api/vendor/ai/listing-copy` that reached the charge.
 *
 * What support reads when a vendor says "I paid and got nothing": what was asked,
 * what failed, what was charged, which prompt version and model answered, and how
 * long it took. The photos are NOT stored — their ids are enough.
 *
 * `_id` is minted before the charge and used as the ledger `ref`, so a credit
 * transaction and its generation join on `credit_transactions.ref = _id`.
 */
export type AiCopyOutcome =
  | 'succeeded'   // every requested field came back
  | 'partial'     // some did; the rest were refunded
  | 'failed'      // the model answered and nothing was usable — all refunded
  | 'unavailable'; // the workflow could not be reached, or timed out — all refunded

export interface IAiCopyGeneration extends Document {
  vendorId: Types.ObjectId;
  listingId: Types.ObjectId | null;
  target: 'product' | 'service';
  productType: 'physical' | 'digital' | null;
  language: string;
  fields: string[];
  failed: string[];
  outcome: AiCopyOutcome;
  /** Net: charged up front minus refunded. Equals the number of fields returned. */
  creditsCharged: number;
  imageFileIds: Types.ObjectId[];
  promptVersion: string | null;
  /** The OpenRouter slug that answered (primary or fallback). `model` is taken by mongoose. */
  modelId: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Why a call failed or was refused, in words for support. Never shown to the vendor. */
  errorReason: string | null;
  createdAt: Date;
}

const AiCopyGenerationSchema = new Schema<IAiCopyGeneration>(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: MODELS.VENDOR, required: true },
    listingId: { type: Schema.Types.ObjectId, default: null },
    target: { type: String, enum: ['product', 'service'], required: true },
    productType: { type: String, enum: ['physical', 'digital', null], default: null },
    language: { type: String, required: true },
    fields: { type: [String], required: true },
    failed: { type: [String], default: [] },
    outcome: { type: String, enum: ['succeeded', 'partial', 'failed', 'unavailable'], required: true },
    creditsCharged: { type: Number, required: true },
    imageFileIds: { type: [Schema.Types.ObjectId], default: [] },
    promptVersion: { type: String, default: null },
    modelId: { type: String, default: null },
    latencyMs: { type: Number, required: true },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    errorReason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// "What did this vendor generate, newest first" — the only read support needs. Built by
// `migrate:declared-indexes` (autoIndex is off in production).
AiCopyGenerationSchema.index({ vendorId: 1, createdAt: -1 });

export const AiCopyGenerationModel =
  (mongoose.models[MODELS.AI_COPY_GENERATION] as mongoose.Model<IAiCopyGeneration>) ||
  mongoose.model<IAiCopyGeneration>(MODELS.AI_COPY_GENERATION, AiCopyGenerationSchema, COLLECTIONS.AI_COPY_GENERATION);
