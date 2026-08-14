import bcrypt from 'bcrypt';
import { UserRepository } from './user.repository';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { eventBus } from '../../core/events/event-bus';
import { auditLogger } from '../../core/audit/audit-logger';

/**
 * User Service
 * 
 * Handles user account management, primarily password changes.
 * Authentication-related operations belong in AuthService.
 */
export class UserService {
  private userRepo: UserRepository;

  constructor() {
    this.userRepo = new UserRepository();
  }

  /**
   * Change user password
   * 
   * This method handles password changes for ALL roles (vendor, customer, etc.)
   * It's the single source of truth for password updates.
   * 
   * SECURITY:
   * - Verifies old password before allowing change
   * - Validates new password strength (delegated to caller/validator)
   * - Hashes password with bcrypt cost factor 12
   * - **Ends every session issued under the old password** (see below)
   * - Emits domain event for password change
   * - Logs audit trail
   *
   * ── Session invalidation ──────────────────────────────────────────────────
   * A password change is the standard remedy after a compromise, so it has to evict the
   * attacker rather than merely lock a door they are already inside. This service issues
   * stateless JWTs and keeps no record of them, so there is no session list to clear: the
   * revocation IS the `password_changed_at` stamp the repository writes alongside the hash,
   * which `requireAuth` and `rotateRefreshToken` measure every token's `iat` against. See
   * `core/auth/password-epoch.ts`.
   *
   * That includes the caller's own tokens. `UserController.updatePassword` re-issues a pair
   * for them the moment this returns, so the person who changed their own password keeps
   * working while every other session is signed out.
   * 
   * @param userId - User ID (from User model, not role entity)
   * @param oldPassword - Current password (plaintext)
   * @param newPassword - New password (plaintext, will be hashed)
   * @param context - Context about who is making the change
   * @returns the instant existing sessions were cut off at
   * @throws NotFoundError if user not found
   * @throws ForbiddenError if old password is incorrect
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    context: { role: string; roleEntityId: string }
  ): Promise<{ passwordChangedAt: Date }> {
    // 1. Load user
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404);
    }

    // 2. Verify old password
    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) {
      throw createAppError(ERROR_CODES.USER_INVALID_PASSWORD, 403, 'Current password is incorrect');
    }

    // 3. Hash new password (bcrypt cost factor 12 for enterprise security)
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // 4. Update password in database — and, in the same write, stamp the epoch that ends
    //    every session issued under the old password. One $set, never two.
    const passwordChangedAt = await this.userRepo.updatePassword(userId, passwordHash);

    // 5. Emit domain event
    await eventBus.publish('user.password.changed', {
      eventType: 'user.password.changed',
      aggregateId: userId,
      payload: {
        userId,
        role: context.role,
        roleEntityId: context.roleEntityId,
      },
      occurredAt: new Date(),
    });

    // 6. Audit log
    await auditLogger.log({
      actor: { userId, role: context.role },
      action: 'PASSWORD_CHANGED',
      resource: { type: 'User', id: userId },
      metadata: {
        roleEntityId: context.roleEntityId,
        passwordChangedAt,
      },
      timestamp: new Date(),
    });

    return { passwordChangedAt };
  }

  /**
   * Verify password without changing it
   * 
   * Useful for sensitive operations that require password confirmation
   * 
   * @param userId - User ID
   * @param password - Password to verify
   * @returns true if password matches, false otherwise
   */
  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.userRepo.findById(userId);
    if (!user) return false;

    return await bcrypt.compare(password, user.password_hash);
  }
}
