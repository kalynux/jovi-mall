import crypto from 'crypto';
import { getRedisClient, SLOT_LOCK_DB } from '../../../infra/redis/redis.factory';
import { SlotLockData } from '../types/booking.types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * How long a hold on a slot lives, in seconds.
 *
 * ⚠ **Exported because two callers have to AGREE with it rather than restate it.** The
 * storefront lock route and the shop's reschedule hold both tell the caller when their hold
 * expires, and both used to compute that from a `15 * 60 * 1000` written at the route — a
 * second copy of this number, free to drift from it. A dashboard that believes it has longer
 * than it does shows a picker that has already lapsed.
 */
export const SLOT_HOLD_TTL_SECONDS = 900; // 15 minutes

export class SlotLockService {
  private static readonly DEFAULT_TTL = SLOT_HOLD_TTL_SECONDS;
  private static readonly CAPACITY_MUTEX_TTL = 10; // seconds — short critical section

  /**
   * Attempts to lock a slot for the specified owner.
   * Returns true if lock acquired, false if already locked.
   *
   * @param scopeToOwner When true, the lock key is namespaced by ownerId
   *   (`slot:lock:{slotId}:{ownerId}`) so multiple distinct owners can each hold
   *   their own hold on the same slot — used for capacity-mode checkout holds.
   *   When false (default), the key is exclusive per slot (calendar/manual).
   */
  async lock(
    slotId: string,
    ownerId: string,
    ttlSeconds: number = SlotLockService.DEFAULT_TTL,
    scopeToOwner = false
  ): Promise<boolean> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId, scopeToOwner ? ownerId : undefined);

    const lockData: SlotLockData = {
      ownerId,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };

    // SETNX pattern: Set if Not eXists
    const result = await redis.set(key, JSON.stringify(lockData), {
      NX: true,
      EX: ttlSeconds,
    });

    return result === 'OK';
  }

  /**
   * Releases a lock if owned by the specified owner.
   * Returns true if released, false if not owned or doesn't exist.
   */
  async release(slotId: string, ownerId: string, scopeToOwner = false): Promise<boolean> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId, scopeToOwner ? ownerId : undefined);

    const value = await redis.get(key);
    if (!value) {
      return false;
    }

    const lockData: SlotLockData = JSON.parse(value);
    if (lockData.ownerId !== ownerId) {
      return false;
    }

    await redis.del(key);
    return true;
  }

  /**
   * Asserts that the slot is locked by the specified owner.
   * Throws an error if not locked or locked by someone else.
   */
  async assertLocked(slotId: string, ownerId: string, scopeToOwner = false): Promise<void> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId, scopeToOwner ? ownerId : undefined);

    const value = await redis.get(key);
    if (!value) {
      throw createAppError(ERROR_CODES.BOOKING_SLOT_NOT_LOCKED, 409, `Slot ${slotId} is not locked`);
    }

    const lockData: SlotLockData = JSON.parse(value);
    if (lockData.ownerId !== ownerId) {
      throw createAppError(ERROR_CODES.BOOKING_UNAUTHORIZED, 403, `Slot ${slotId} is locked by another user`);
    }

    // Check if expired
    if (lockData.expiresAt < Date.now()) {
      await redis.del(key);
      throw createAppError(ERROR_CODES.BOOKING_SLOT_NOT_LOCKED, 409, `Slot ${slotId} lock has expired`);
    }
  }

  /**
   * Acquires a short-lived exclusive mutex over a slot's capacity commit section.
   * Distinct from the per-user checkout hold: this serialises the count-and-create
   * critical section so concurrent finalisations can't oversell a capacity slot.
   *
   * @returns A release token if acquired, or null if another commit is in progress.
   */
  async acquireCapacityMutex(
    slotId: string,
    ttlSeconds: number = SlotLockService.CAPACITY_MUTEX_TTL
  ): Promise<string | null> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getCapacityMutexKey(slotId);
    const token = crypto.randomUUID();

    const result = await redis.set(key, token, { NX: true, EX: ttlSeconds });
    return result === 'OK' ? token : null;
  }

  /**
   * Releases a capacity mutex, but only if the caller still holds it (token match),
   * so a slow caller whose mutex already expired can't delete a newer holder's lock.
   */
  async releaseCapacityMutex(slotId: string, token: string): Promise<void> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getCapacityMutexKey(slotId);

    const value = await redis.get(key);
    if (value === token) {
      await redis.del(key);
    }
  }

  /**
   * Extends the TTL of an existing hold.
   *
   * `scopeToOwner` must match what `lock()` was called with, or this addresses a
   * different key entirely — it previously always used the unscoped key, so it
   * could never extend a capacity-mode (owner-scoped) hold and silently returned
   * false. Same asymmetry `release`/`assertLocked` already guard against.
   *
   * @returns true if extended, false if not held by this owner.
   */
  async extend(
    slotId: string,
    ownerId: string,
    ttlSeconds: number,
    scopeToOwner = false
  ): Promise<boolean> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId, scopeToOwner ? ownerId : undefined);

    const value = await redis.get(key);
    if (!value) {
      return false;
    }

    const lockData: SlotLockData = JSON.parse(value);
    if (lockData.ownerId !== ownerId) {
      return false;
    }

    lockData.expiresAt = Date.now() + ttlSeconds * 1000;
    await redis.set(key, JSON.stringify(lockData), { EX: ttlSeconds });
    return true;
  }

  /**
   * Checks if a slot is currently locked.
   */
  async isLocked(slotId: string): Promise<boolean> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId);
    const exists = await redis.exists(key);
    return exists === 1;
  }

  private getKey(slotId: string, ownerId?: string): string {
    return ownerId ? `slot:lock:${slotId}:${ownerId}` : `slot:lock:${slotId}`;
  }

  private getCapacityMutexKey(slotId: string): string {
    return `slot:capacity-mutex:${slotId}`;
  }
}
