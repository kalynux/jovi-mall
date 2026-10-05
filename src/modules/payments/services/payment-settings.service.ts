import mongoose from 'mongoose';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { PAYMENTS_CONFIG } from '../config/payments.config';
import { PAYMENT_GATEWAY_NAMES, PaymentGatewayName } from '../gateways/gateway.interface';
import { PAYMENT_PROVIDERS, PaymentProvider } from '../domain/payment-provider';
import {
  DEFAULT_PAYMENT_SETTINGS,
  PaymentSettings,
  PaymentSettingsRecord,
  RoutingFacts,
  REFUND_FEE_PERCENT_DEFAULT,
  isValidRefundFeePercent,
  SettingsIssue,
  validateSettingsChange,
} from '../domain/payment-routing';
import { IPaymentSettings, PAYMENT_SETTINGS_ID, PaymentSettingsModel } from '../models/payment-settings.model';

/**
 * The stateful half of payment routing: Mongo for truth, a short in-process cache for cost
 * (ADR-A08 D-3). A copy of `system/services/maintenance.service.ts`, on purpose.
 *
 * ── Why a cache ──────────────────────────────────────────────────────────────
 * Every new charge asks "which aggregator?", and the answer changes a few times a year. So it
 * is cached for `PAYMENT_SETTINGS_CACHE_TTL_MS` (default 5 s), refreshed in the background on
 * the first read after expiry, and replaced eagerly on whichever instance served the write.
 * Other instances may serve up to one TTL of the old answer. That bound is returned to the
 * administrator as `convergenceSeconds`.
 *
 * ── The failure direction ────────────────────────────────────────────────────
 * A failed refresh KEEPS THE LAST KNOWN SETTINGS, and on a cold process that is the defaults,
 * which are exactly the pre-ADR-A08 behaviour. Falling back to the defaults on every Mongo
 * wobble would silently undo an administrator's emergency switch, moving customers back onto
 * the aggregator that was just switched away from because it was failing.
 *
 * ── Why the registry is not imported here ────────────────────────────────────
 * `gateways/registry.ts` imports this module (it reads the settings to decide what a door may
 * charge). Validation needs the registry's facts, so `setPaymentSettings` loads them lazily,
 * or takes them as an argument. A static import would be a cycle.
 */

// ── Store seam ───────────────────────────────────────────────────────────────

/** The document as read back (lean). */
export type PaymentSettingsDocument = Pick<
  IPaymentSettings,
  | '_id'
  | 'collection_aggregator'
  | 'payout_aggregator'
  | 'stripe_enabled'
  | 'providers'
  | 'refund_fee_percent'
  | 'version'
  | 'updated_at'
  | 'updated_by_id'
  | 'updated_by_name'
  | 'reason'
>;

type SettingsFields = Omit<PaymentSettingsDocument, '_id' | 'version'>;

/**
 * The four things this service asks of storage. Mongo in production; a stub in
 * `test:payment-settings`, so the cache and the compare-and-set are tested without a database.
 */
export interface PaymentSettingsStore {
  /** False while the connection is down: the cache then keeps what it has rather than queue a read. */
  ready(): boolean;
  read(): Promise<PaymentSettingsDocument | null>;
  /** Create at `version: 1`. Must reject with a duplicate-key error (code 11000) if it already exists. */
  create(fields: SettingsFields): Promise<PaymentSettingsDocument>;
  /** Write only if the stored version is `expectedVersion`; null on a miss. */
  compareAndSet(expectedVersion: number, fields: SettingsFields): Promise<PaymentSettingsDocument | null>;
}

const mongoStore: PaymentSettingsStore = {
  ready: () => mongoose.connection.readyState === 1,
  read: () => PaymentSettingsModel.findById(PAYMENT_SETTINGS_ID).lean<PaymentSettingsDocument | null>().exec(),
  create: async (fields) => {
    const doc = await PaymentSettingsModel.create({ _id: PAYMENT_SETTINGS_ID, ...fields, version: 1 });
    return doc.toObject() as PaymentSettingsDocument;
  },
  compareAndSet: (expectedVersion, fields) =>
    PaymentSettingsModel.findOneAndUpdate(
      { _id: PAYMENT_SETTINGS_ID, version: expectedVersion },
      { $set: { ...fields, version: expectedVersion + 1 } },
      { new: true, runValidators: true },
    ).lean<PaymentSettingsDocument | null>().exec(),
};

let store: PaymentSettingsStore = mongoStore;

// ── Cache ────────────────────────────────────────────────────────────────────

let cached: PaymentSettingsRecord = DEFAULT_PAYMENT_SETTINGS;
let cachedAt = 0;
let refreshing: Promise<void> | null = null;

function isGatewayName(value: unknown): value is PaymentGatewayName {
  return typeof value === 'string' && (PAYMENT_GATEWAY_NAMES as readonly string[]).includes(value);
}

/**
 * Normalise a stored document. A field this build cannot read (an aggregator name from a newer
 * build that was rolled back, a provider missing from an older document) falls back to its
 * default rather than making every charge throw.
 */
function fromDocument(doc: PaymentSettingsDocument | null): PaymentSettingsRecord {
  if (!doc) return DEFAULT_PAYMENT_SETTINGS;
  const providers = {} as Record<PaymentProvider, { enabled: boolean }>;
  for (const p of PAYMENT_PROVIDERS) {
    const stored = doc.providers?.[p]?.enabled;
    providers[p] = { enabled: typeof stored === 'boolean' ? stored : DEFAULT_PAYMENT_SETTINGS.providers[p].enabled };
  }
  return {
    collection_aggregator: isGatewayName(doc.collection_aggregator)
      ? doc.collection_aggregator
      : DEFAULT_PAYMENT_SETTINGS.collection_aggregator,
    payout_aggregator: isGatewayName(doc.payout_aggregator) ? doc.payout_aggregator : DEFAULT_PAYMENT_SETTINGS.payout_aggregator,
    stripe_enabled: doc.stripe_enabled === true,
    providers,
    refund_fee_percent: isValidRefundFeePercent(doc.refund_fee_percent)
      ? doc.refund_fee_percent
      : REFUND_FEE_PERCENT_DEFAULT,
    version: typeof doc.version === 'number' ? doc.version : 0,
    updated_at: doc.updated_at ?? null,
    updated_by_id: doc.updated_by_id ?? null,
    updated_by_name: doc.updated_by_name ?? null,
    reason: doc.reason ?? null,
  };
}

/** Read storage and replace the cache. Concurrent callers share one in-flight read. */
async function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  if (!store.ready()) {
    // Keep the last known settings, and do not queue a read behind a dead connection. Stamp
    // `cachedAt` so a disconnected instance does not re-check on every charge.
    cachedAt = Date.now();
    return;
  }

  refreshing = (async () => {
    try {
      cached = fromDocument(await store.read());
    } catch (error) {
      // Keep the last known settings: see this file's header.
      console.error('[PaymentSettings] Failed to refresh payment settings; keeping last known', error);
    } finally {
      cachedAt = Date.now();
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * The synchronous read every charging path uses. Returns the cached settings immediately and
 * starts a background refresh when they are stale. Never throws, never awaits.
 */
export function getPaymentSettingsSync(): PaymentSettingsRecord {
  if (Date.now() - cachedAt > PAYMENTS_CONFIG.SETTINGS_CACHE_TTL_MS) void refresh();
  return cached;
}

/**
 * Load the settings once at boot, before the listener opens. Without it, an instance started
 * after an emergency switch would route its first TTL of charges to the aggregator the
 * administrator just left.
 */
export async function primePaymentSettings(): Promise<PaymentSettingsRecord> {
  await refresh();
  return cached;
}

// ── The administrator's view ─────────────────────────────────────────────────

/** The camelCase projection `api-doc/payments/routing.md` fixes for the admin surface. */
export interface PaymentSettingsView {
  collectionAggregator: PaymentGatewayName;
  payoutAggregator: PaymentGatewayName;
  stripeEnabled: boolean;
  providers: Record<PaymentProvider, { enabled: boolean }>;
  /** REFUND-FLOW-PLAN § 11.6 — percent off a transfer or external refund (cards: never). */
  refundFeePercent: number;
  version: number;
  updatedAt: Date | null;
  updatedBy: { id: string; name: string | null } | null;
  reason: string | null;
}

export function toPaymentSettingsView(record: PaymentSettingsRecord): PaymentSettingsView {
  const providers = {} as Record<PaymentProvider, { enabled: boolean }>;
  for (const p of PAYMENT_PROVIDERS) providers[p] = { enabled: record.providers[p].enabled };
  return {
    collectionAggregator: record.collection_aggregator,
    payoutAggregator: record.payout_aggregator,
    stripeEnabled: record.stripe_enabled,
    providers,
    refundFeePercent: record.refund_fee_percent,
    version: record.version,
    updatedAt: record.updated_at,
    updatedBy: record.updated_by_id ? { id: record.updated_by_id, name: record.updated_by_name } : null,
    reason: record.reason,
  };
}

// ── The write ────────────────────────────────────────────────────────────────

/** The `PUT` body's settings fields (camelCase, all optional). `providers` merges per provider. */
export interface PaymentSettingsPatch {
  collectionAggregator?: string;
  payoutAggregator?: string;
  stripeEnabled?: boolean;
  providers?: Readonly<Record<string, { enabled: boolean } | undefined>>;
  /** 0–20 (REFUND-FLOW-PLAN § 11.6). */
  refundFeePercent?: number;
}

export interface PaymentSettingsActor {
  id: string;
  name: string | null;
}

/** The keys `changed` may name: the settings a write can move, never its bookkeeping. */
export type PaymentSettingsChangeKey =
  | 'collectionAggregator'
  | 'payoutAggregator'
  | 'stripeEnabled'
  | 'providers'
  | 'refundFeePercent';

export interface SetPaymentSettingsResult {
  /** As stored before the compare-and-set; the defaults when there was no document. */
  previous: PaymentSettingsView;
  settings: PaymentSettingsView;
  changed: PaymentSettingsChangeKey[];
  warnings: SettingsIssue[];
  /** Worst-case seconds before every instance agrees. */
  convergenceSeconds: number;
}

function changedKeys(before: PaymentSettingsRecord, after: PaymentSettingsRecord): PaymentSettingsChangeKey[] {
  const out: PaymentSettingsChangeKey[] = [];
  if (before.collection_aggregator !== after.collection_aggregator) out.push('collectionAggregator');
  if (before.payout_aggregator !== after.payout_aggregator) out.push('payoutAggregator');
  if (before.stripe_enabled !== after.stripe_enabled) out.push('stripeEnabled');
  if (PAYMENT_PROVIDERS.some((p) => before.providers[p].enabled !== after.providers[p].enabled)) out.push('providers');
  if (before.refund_fee_percent !== after.refund_fee_percent) out.push('refundFeePercent');
  return out;
}

function versionConflict(expectedVersion: number, storedVersion: number | null): never {
  throw createAppError(
    ERROR_CODES.PAYMENT_SETTINGS_VERSION_CONFLICT,
    409,
    `The payment settings changed while you were editing them (you had version ${expectedVersion}) — reload and retry`,
    storedVersion === null ? undefined : { expectedVersion, currentVersion: storedVersion },
  );
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/**
 * Validate, compare-and-set on `version`, and replace this instance's cache.
 *
 * - The current state is read from STORAGE, never the cache. `previous` is exactly the state
 *   the compare-and-set is made against, so the audit's before/after cannot race a second
 *   administrator.
 * - `expectedVersion` 0 means "there is no document yet". The first write is a create, and two
 *   concurrent creates collide on the literal `_id`: the loser's duplicate-key error becomes
 *   `409 PAYMENT_SETTINGS_VERSION_CONFLICT`, like any other lost race.
 * - A hard rule refuses with `422 PAYMENT_SETTINGS_INVALID` and `details.errors[]`. Soft
 *   warnings are returned with the accepted write.
 *
 * `facts` defaults to the live registry's; the test passes its own.
 */
export async function setPaymentSettings(
  patch: PaymentSettingsPatch,
  expectedVersion: number,
  actor: PaymentSettingsActor,
  reason: string,
  facts?: RoutingFacts,
): Promise<SetPaymentSettingsResult> {
  const storedDoc = await store.read();
  const before = fromDocument(storedDoc);
  const storedVersion = storedDoc ? before.version : 0;
  if (expectedVersion !== storedVersion) versionConflict(expectedVersion, storedVersion);

  const providers: Record<string, { enabled: boolean } | undefined> = { ...before.providers };
  for (const [key, value] of Object.entries(patch.providers ?? {})) {
    if (value !== undefined) providers[key] = { enabled: value.enabled === true };
  }

  // Lazily: the registry imports this module. See the header.
  const routingFacts = facts ?? (await import('../gateways/registry')).buildRoutingFacts();
  const verdict = validateSettingsChange(
    {
      collection_aggregator: patch.collectionAggregator ?? before.collection_aggregator,
      payout_aggregator: patch.payoutAggregator ?? before.payout_aggregator,
      stripe_enabled: patch.stripeEnabled ?? before.stripe_enabled,
      providers,
    },
    before,
    routingFacts,
  );
  if (!verdict.ok) {
    throw createAppError(
      ERROR_CODES.PAYMENT_SETTINGS_INVALID,
      422,
      `These payment settings cannot be applied: ${verdict.errors.map((e) => e.message).join('; ')}`,
      { errors: verdict.errors },
    );
  }

  // The refund fee is not a routing input (see `REFUND_FEE_PERCENT_DEFAULT`), so it is checked
  // here rather than in `validateSettingsChange`. The route's schema bounds it too; this is the
  // belt for a caller that is not the route.
  const refundFeePercent = patch.refundFeePercent ?? before.refund_fee_percent;
  if (!isValidRefundFeePercent(refundFeePercent)) {
    throw createAppError(
      ERROR_CODES.PAYMENT_SETTINGS_INVALID,
      422,
      'These payment settings cannot be applied: the refund fee must be a percentage from 0 to 20',
      { errors: [{ code: 'REFUND_FEE_PERCENT_INVALID', message: 'The refund fee must be from 0 to 20 percent' }] },
    );
  }

  const fields: SettingsFields = {
    ...verdict.settings,
    refund_fee_percent: refundFeePercent,
    updated_at: new Date(),
    updated_by_id: actor.id,
    updated_by_name: actor.name,
    reason: reason.trim() || null,
  };

  let written: PaymentSettingsDocument | null;
  if (expectedVersion === 0) {
    try {
      written = await store.create(fields);
    } catch (error) {
      if (isDuplicateKey(error)) versionConflict(expectedVersion, null);
      throw error;
    }
  } else {
    written = await store.compareAndSet(expectedVersion, fields);
    if (!written) versionConflict(expectedVersion, null);
  }

  cached = fromDocument(written);
  cachedAt = Date.now();

  return {
    previous: toPaymentSettingsView(before),
    settings: toPaymentSettingsView(cached),
    changed: changedKeys(before, cached),
    warnings: verdict.warnings,
    convergenceSeconds: Math.ceil(PAYMENTS_CONFIG.SETTINGS_CACHE_TTL_MS / 1000),
  };
}

// ── Test seams ───────────────────────────────────────────────────────────────

/** Swap the storage (null restores Mongo). `test:payment-settings` only. */
export function __setPaymentSettingsStoreForTests(next: PaymentSettingsStore | null): void {
  store = next ?? mongoStore;
}

/**
 * Reset the cache. With `fresh: true` the value counts as just read (no refresh until the TTL);
 * otherwise it is stale and the next read refreshes.
 */
export function __resetPaymentSettingsCacheForTests(
  value: PaymentSettingsRecord = DEFAULT_PAYMENT_SETTINGS,
  fresh = true,
): void {
  cached = value;
  cachedAt = fresh ? Date.now() : 0;
  refreshing = null;
}
