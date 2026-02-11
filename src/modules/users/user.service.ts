import bcrypt from 'bcrypt';
import { UserRepository } from './user.repository';
import { NotFoundError, ForbiddenError } from '../../core/errors';
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
   * - Emits domain event for password change
   * - Logs audit trail
   * 
   * @param userId - User ID (from User model, not role entity)
   * @param oldPassword - Current password (plaintext)
   * @param newPassword - New password (plaintext, will be hashed)
   * @param context - Context about who is making the change
   * @throws NotFoundError if user not found
   * @throws ForbiddenError if old password is incorrect
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    context: { role: string; roleEntityId: string }
  ): Promise<void> {
    // 1. Load user
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // 2. Verify old password
    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) {
      throw new ForbiddenError('Current password is incorrect');
    }

    // 3. Hash new password (bcrypt cost factor 12 for enterprise security)
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // 4. Update password in database
    await this.userRepo.updatePassword(userId, passwordHash);

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
      },
      timestamp: new Date(),
    });

    // 7. TODO: Invalidate all user sessions
    // This would force re-authentication with new password
    // await sessionService.invalidateAllSessions(userId);
    console.log(`[UserService] TODO: Invalidate sessions for user ${userId}`);
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
