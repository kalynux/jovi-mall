import { SlotLockService } from '../../../../booking/services/slot-lock.service';

/**
 * SlotLockFacade - Thin facade for slot locking operations
 * 
 * Provides a decoupled interface for product module to interact with
 * booking module's slot locking functionality.
 */
export class SlotLockFacade {
  private slotLockService: SlotLockService;

  constructor() {
    this.slotLockService = new SlotLockService();
  }

  /**
   * Attempts to lock a slot for the specified owner.
   * @param slotId - Unique slot identifier
   * @param ownerId - ID of the entity locking the slot (typically userId)
   * @param ttlSeconds - Time-to-live for the lock in seconds (default: 900 = 15 minutes)
   * @returns true if locked successfully, false if already locked
   */
  async lockSlot(slotId: string, ownerId: string, ttlSeconds?: number, scopeToOwner = false): Promise<boolean> {
    return this.slotLockService.lock(slotId, ownerId, ttlSeconds, scopeToOwner);
  }

  /**
   * Releases a lock if owned by the specified owner.
   * @param slotId - Unique slot identifier
   * @param ownerId - ID of the entity that owns the lock
   * @returns true if released, false if not owned or doesn't exist
   */
  async releaseSlot(slotId: string, ownerId: string, scopeToOwner = false): Promise<boolean> {
    return this.slotLockService.release(slotId, ownerId, scopeToOwner);
  }

  /**
   * Checks if a slot is currently locked.
   * @param slotId - Unique slot identifier
   * @returns true if locked, false otherwise
   */
  async isSlotLocked(slotId: string): Promise<boolean> {
    return this.slotLockService.isLocked(slotId);
  }

  /**
   * Extends the TTL of an existing lock.
   * @param slotId - Unique slot identifier
   * @param ownerId - ID of the entity that owns the lock
   * @param ttlSeconds - New time-to-live in seconds
   * @returns true if extended, false if not owned
   */
  async extendLock(slotId: string, ownerId: string, ttlSeconds: number): Promise<boolean> {
    return this.slotLockService.extend(slotId, ownerId, ttlSeconds);
  }
}
