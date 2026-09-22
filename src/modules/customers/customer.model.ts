import mongoose, { Schema, Document } from 'mongoose';
import { GeoPointSchema, IGeoPoint } from '../../core/types/geo.types';
import { GeoAddressSchema, IGeoAddress } from '../../core/types/geo-address.types';
import { FixedOnboardingStep } from '../../core/constants/onboarding-steps';
import { MODELS, COLLECTIONS } from '../../core/database/collections';
import {
  BOT_ONBOARDING_STATES,
  BOT_ONBOARDING_STEP_VALUES,
  BotOnboardingRecord,
} from '../bot-surface/domain/bot-onboarding';

// ─── Saved Address Sub-Schema ─────────────────────────────────────────────────

const SavedAddressSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },         // e.g. "Home", "Work"
    address_line1: { type: String, required: true, trim: true },
    address_line2: { type: String, default: null, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, default: null, trim: true },
    country: { type: String, default: 'CM', trim: true, uppercase: true },
    is_default: { type: Boolean, default: false },
    /**
     * @deprecated Bare coordinate kept for backward compatibility. Prefer `geo`
     * (the full GeoAddress); `geo.coordinates` is the canonical point.
     *
     * ⚠ `default: undefined`, never `default: null` — see `GeoPointSchema`. This
     * array is 2dsphere-indexed, so an explicit `null` beside a real point makes
     * the WHOLE customer document unwritable. That is not theoretical: the schema
     * default used to be `null`, `addAddress` never sets the field, and every seeded
     * customer has a geocoded first address — so adding a second address 500'd for
     * exactly the people most likely to try, and took every other write to that
     * customer down with it.
     */
    location: { type: GeoPointSchema, default: undefined },
    /**
     * Canonical geospatial address — formatted address + coordinates + provider
     * place id + structured admin components. Populated when the customer picks
     * a result from address search; null on legacy/plain-text entries.
     */
    geo: { type: GeoAddressSchema, default: null },
  },
  { _id: true }
);

// ─── Preferences Sub-Schema ───────────────────────────────────────────────────

const PreferencesSchema = new Schema(
  {
    language: { type: String, default: 'en', trim: true },        // BCP-47 e.g. "en", "fr"
    currency: { type: String, default: 'XAF', trim: true },       // ISO-4217
    marketing_opt_in: { type: Boolean, default: false },
    ai_tone: { type: [String], default: [] },                     // e.g. ["friendly", "concise"]
    ads_compact_mode: { type: Boolean, default: false },
    compact_mode: { type: Boolean, default: false },
  },
  { _id: false }
);

// ─── Saved Payment Method Sub-Schema ─────────────────────────────────────────

/**
 * Saved payment methods store a reference to a gateway-managed instrument.
 * No raw card/account numbers are stored here; the payment gateway handles
 * tokenization and PCI compliance. We store only the display metadata.
 */
const SavedPaymentMethodSchema = new Schema(
  {
    provider: { type: String, required: true, trim: true },       // "stripe", "paystack", "mtn_momo"
    gateway_customer_id: { type: String, required: true, trim: true }, // Gateway's customer/wallet ID
    gateway_instrument_id: { type: String, required: true, trim: true }, // Gateway's card/instrument ID
    display_label: { type: String, required: true, trim: true },  // e.g. "MTN •••• 1234" for UI
    method_type: {
      type: String,
      required: true,
      enum: ['card', 'mobile_money', 'bank_transfer'],
    },
    is_default: { type: Boolean, default: false },
  },
  { _id: true }
);

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ICustomerSavedAddress {
  _id: mongoose.Types.ObjectId;
  label: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string | null;
  country: string;
  is_default: boolean;
  /**
   * @deprecated Prefer `geo.coordinates`.
   * Optional because the key is OMITTED rather than stored null — see the schema.
   */
  location?: IGeoPoint | null;
  /** Canonical geospatial address; null on legacy/plain-text entries. */
  geo: IGeoAddress | null;
}

export interface ICustomerPreferences {
  language: string;
  currency: string;
  marketing_opt_in: boolean;
  ai_tone: string[];
  ads_compact_mode: boolean;
  compact_mode: boolean;
}

export interface ICustomerSavedPaymentMethod {
  _id: mongoose.Types.ObjectId;
  provider: string;
  gateway_customer_id: string;
  gateway_instrument_id: string;
  display_label: string;
  method_type: 'card' | 'mobile_money' | 'bank_transfer';
  is_default: boolean;
}

export interface ICustomer extends Document {
  user_id: mongoose.Types.ObjectId;
  email?: string;
  email_verified: boolean;
  phone?: string;
  phone_verified: boolean;
  name: string;
  /**
   * Profile avatar as a File reference — registers in `file_references` and is
   * deletion-protected. Canonical going forward; `avatar_url` is the deprecated
   * read-fallback for legacy/OAuth string avatars.
   */
  avatar_file_id: mongoose.Types.ObjectId | null;
  /** @deprecated Prefer `avatar_file_id`. Kept as a read-fallback for legacy avatars. */
  avatar_url: string | null;
  bio: string | null;
  saved_addresses: ICustomerSavedAddress[];
  date_of_birth: Date | null;
  preferences: ICustomerPreferences;
  recent_product_code: string | null;
  saved_payment_methods: ICustomerSavedPaymentMethod[];
  timezone: string;
  status: 'active' | 'pending_verification' | 'inactive';
  /**
   * Always 0 for customers — no onboarding flow.
   * Stored for API consistency with other roles.
   *
   * ⚠ Still true, and `bot_onboarding` below is NOT a contradiction of it: that field is
   * a chat-collection checklist on a different axis. See its own comment.
   */
  onboarding_step: number;
  /**
   * The chat-collected profile checklist (GAP-002).
   *
   * Present only on accounts created from a messaging channel — null on every customer who
   * registered through `POST /auth/register`, which collected name, phone and email at the
   * form. Null therefore means "this account was never onboarded through a chat", not
   * "nothing has been collected".
   *
   * ⚠ **`skipped` is why this is stored rather than derived.** Every other onboarding in
   * this service recomputes its step from field presence, and that works because a
   * dashboard can show the same form again for free. A chat cannot: a null email
   * indistinguishable from a declined one means the bot asks for an email on every message
   * for the rest of the account's life. See `bot-surface/domain/bot-onboarding.ts`.
   */
  bot_onboarding: ICustomerBotOnboarding | null;
  /**
   * The bot conversation memory's EPOCH — which generation of chat memory the automation layer
   * should read for this customer. 0 until an administrator first resets it.
   *
   * ⚠ **The memory itself is NOT here, and this service never touches it.** It lives in the
   * automation layer's own Redis; n8n folds this number into its memory key (epoch 0 keeps the
   * original key, epoch N appends `:e<N>`), so bumping it makes the old memory unreachable at once
   * and the old keys lapse on their own TTL. Written ONLY by `BotMemoryService.reset`, with `$inc`
   * so two concurrent resets cannot land on one number. Read on every inbound message by
   * `/identity/sync`, from the document that route already loads — no extra query.
   */
  bot_memory_epoch: number;
  /** When an administrator last reset the bot's memory for this customer. Null: never. */
  bot_memory_reset_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * ── The `steps` ARRAY is deliberately not a keyed object ─────────────────────
 * A `{ phone: ..., name: ... }` map would put the step vocabulary in the Mongoose paths,
 * so adding a step would be a schema change and removing one would leave an orphan path
 * nothing reads. As an array with an `enum`'d discriminator, the vocabulary lives in ONE
 * declaration (`BOT_ONBOARDING_STEP_VALUES`) that both the enum and the domain spread from,
 * and `normalizeOnboarding` completes whatever is stored into the current checklist.
 */
export interface ICustomerBotOnboarding {
  /** Derived and stored together with `steps`, never written apart — see the repository. */
  complete: boolean;
  steps: BotOnboardingRecord[];
  /** Which channel the account was created from. Audit only; nothing branches on it. */
  source_channel: string | null;
  started_at: Date;
  /** Stamped the moment `complete` first becomes true; never cleared afterwards. */
  completed_at: Date | null;
}

const BotOnboardingStepSchema = new Schema<BotOnboardingRecord>(
  {
    // Spread from the single declaration in `bot-surface/domain/bot-onboarding.ts`.
    // Never type the literals here — the agent notification stack kept two copies of one
    // vocabulary, they drifted, and every contract notification threw a ValidationError
    // that nobody saw because the write was fire-and-forget.
    step: { type: String, enum: [...BOT_ONBOARDING_STEP_VALUES], required: true },
    state: { type: String, enum: [...BOT_ONBOARDING_STATES], required: true },
    at: { type: Date, default: null },
  },
  { _id: false }
);

const BotOnboardingSchema = new Schema<ICustomerBotOnboarding>(
  {
    complete: { type: Boolean, default: false },
    steps: { type: [BotOnboardingStepSchema], default: [] },
    source_channel: { type: String, default: null, trim: true },
    started_at: { type: Date, required: true, default: () => new Date() },
    completed_at: { type: Date, default: null },
  },
  { _id: false }
);

// ─── Mongoose Schema ──────────────────────────────────────────────────────────

const CustomerSchema = new Schema<ICustomer>(
  {
    user_id: { type: Schema.Types.ObjectId, ref: MODELS.USER, required: true, unique: true },
    email: { type: String, trim: true, lowercase: true },
    email_verified: { type: Boolean, default: false },
    phone: { type: String, trim: true },
    phone_verified: { type: Boolean, default: false },
    name: { type: String, required: true },
    avatar_file_id: { type: Schema.Types.ObjectId, ref: MODELS.FILE, default: null },
    avatar_url: { type: String, default: null },
    bio: { type: String, default: null },
    saved_addresses: { type: [SavedAddressSchema], default: [] },
    date_of_birth: { type: Date, default: null },
    preferences: {
      type: PreferencesSchema,
      default: () => ({
        language: 'en',
        currency: 'XAF',
        marketing_opt_in: false,
        ai_tone: [],
        ads_compact_mode: false,
        compact_mode: false,
      }),
    },
    recent_product_code: { type: String, default: null },
    saved_payment_methods: { type: [SavedPaymentMethodSchema], default: [] },
    timezone: { type: String, default: 'Africa/Douala', required: true },
    status: {
      type: String,
      enum: ['active', 'pending_verification', 'inactive'],
      default: 'pending_verification',
    },
    onboarding_step: {
      type: Number,
      default: FixedOnboardingStep.COMPLETED,
      min: 0,
      max: 0, // Customers are always COMPLETED; enforced at app layer too
    },
    /**
     * `default: null`, never `default: () => ({})`. "Registered at the form" and "created
     * from a chat and asked nothing yet" are different facts, and an empty sub-document
     * would spell them the same way — which would make every pre-existing customer look
     * like an abandoned chat onboarding to the surface that reads this.
     */
    bot_onboarding: { type: BotOnboardingSchema, default: null },
    /**
     * Defaults, so no data migration: a document written before these fields existed reads as
     * epoch 0 / never reset (a hydrated read applies the default, and `$inc` on an absent field
     * starts from 0). No index — nothing queries by either.
     */
    bot_memory_epoch: { type: Number, default: 0, min: 0 },
    bot_memory_reset_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Geospatial indexes for customer saved addresses (legacy bare point + GeoAddress)
CustomerSchema.index({ 'saved_addresses.location': '2dsphere' }, { sparse: true });
CustomerSchema.index({ 'saved_addresses.geo.coordinates': '2dsphere' }, { sparse: true });

export const CustomerModel = mongoose.model<ICustomer>(MODELS.CUSTOMER, CustomerSchema, COLLECTIONS.CUSTOMER);
