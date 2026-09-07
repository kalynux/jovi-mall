import { Schema, model } from 'mongoose';
import { MODELS, COLLECTIONS } from './collections';
import { createAppError } from '../errors';
import { ERROR_CODES } from '../error-codes';

/**
 * Named monotonic sequences — the counter behind human-readable numbers.
 *
 * One document per sequence key, and the key IS the `_id` (`'booking:2026'`).
 * That is the whole design: `findOneAndUpdate({_id}, {$inc}, {upsert, new})` is a
 * single atomic document update, so "give me the next number" needs no read,
 * no transaction and no lock, and two callers arriving in the same instant get
 * two different numbers.
 *
 * ── Why this exists rather than counting rows ────────────────────────────────
 *
 * `OrderNumberGenerator.generateOrderNumber()` derives its sequence from
 * `countDocuments() + 1`. That is a read-then-write race: two orders committed
 * in the same instant both read N and both claim N+1. Orders survive it only
 * because nothing retries — the second insert simply fails against the unique
 * index, which is a lost sale rather than a duplicate number. A booking is worse
 * placed to absorb that: the slot is already held, the customer already paid
 * attention, and the failure would land as "that time was just taken" on a slot
 * that is in fact free.
 *
 * Orders are deliberately NOT migrated onto this in the same change — that is a
 * behaviour change to the checkout path, and this one is about bookings. The
 * counter is written generically so they can be, later.
 *
 * ── Gaps are expected and are not a fault ───────────────────────────────────
 *
 * `next()` is called BEFORE the row it numbers is written, and it is not part of
 * that write's transaction (deliberately — a counter inside a transaction is a
 * document every concurrent booking would conflict on, turning an atomic
 * increment into a retry storm). So a booking that fails after the number is
 * drawn burns it. The sequence guarantees uniqueness and rough ordering, never
 * density: `BKG-2026-000042` does not mean "the 42nd booking of 2026".
 */
export interface ISequenceCounter {
  /** The sequence key, e.g. `booking:2026`. */
  _id: string;
  /** Last value handed out. The first `next()` returns 1. */
  seq: number;
}

const SequenceCounterSchema = new Schema<ISequenceCounter>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  // No timestamps and no versionKey: every write here is a blind `$inc` and the
  // document is pure infrastructure. `_id: false` disables the ObjectId default
  // so the string key above is the actual primary key.
  { _id: false, versionKey: false, timestamps: false }
);

export const SequenceCounterModel = model<ISequenceCounter>(
  MODELS.SEQUENCE_COUNTER,
  SequenceCounterSchema,
  COLLECTIONS.SEQUENCE_COUNTER
);

/**
 * The next value in the named sequence. Atomic, and creates the sequence on
 * first use.
 *
 * @param key Sequence name. Scope it so the number means what its format says —
 *            `booking:2026` for a per-year sequence, not a global one.
 */
export async function nextSequenceValue(key: string): Promise<number> {
  const counter = await SequenceCounterModel.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  )
    .lean()
    .exec();

  // `new: true` with `upsert: true` always returns the document; the guard is for
  // the type, and for the impossible case rather than a silent NaN downstream —
  // an undefined `seq` would format as `BKG-2026-NaN` and be written.
  //
  // 500, and `internal`: nothing the caller did produced this, and the boundary
  // replaces the message with the registry default before it reaches a client
  // (the key name is diagnostic and is journaled, not sent).
  if (!counter) {
    throw createAppError(
      ERROR_CODES.DATABASE_UNAVAILABLE,
      500,
      `Sequence "${key}" returned no document after $inc`
    );
  }
  return counter.seq;
}
