import { getRedisClient, SLOT_LOCK_DB } from '../../../infra/redis/redis.factory';
import { SlotLockData } from '../types/booking.types';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

export class SlotLockService {
  private static readonly DEFAULT_TTL = 900; // 15 minutes in seconds

  /**
   * Attempts to lock a slot for the specified owner.
   * Returns true if lock acquired, false if already locked.
   */
  async lock(slotId: string, ownerId: string, ttlSeconds: number = SlotLockService.DEFAULT_TTL): Promise<boolean> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId);

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
  async release(slotId: string, ownerId: string): Promise<boolean> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId);

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
  async assertLocked(slotId: string, ownerId: string): Promise<void> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId);

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
   * Extends the TTL of an existing lock.
   * Returns true if extended, false if not owned.
   */
  async extend(slotId: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
    const redis = await getRedisClient(SLOT_LOCK_DB);
    const key = this.getKey(slotId);

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

  private getKey(slotId: string): string {
    return `slot:lock:${slotId}`;
  }
}
