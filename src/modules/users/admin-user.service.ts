import { UserRepository } from './user.repository';
import { IUser } from './user.model';
import { ActorRef, actorStamp } from '../../core/types/actor-source.types';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { AdminUpdateUserContactInput } from './admin-user.validator';

/**
 * Platform-user administration — the write half of wi-admin's user domain.
 *
 * ── Why this lives here and not in wi-admin ───────────────────────────────────
 * wi-admin READS `users` directly (there is no invariant a query can break) and writes it
 * only through this service. What makes the write different is everything a status change
 * touches beyond the column: `requireAuth` refuses a suspended account on every request,
 * `login` and the refresh rotation refuse it too, and the login identifiers carry sparse
 * unique indexes whose collision rules are this service's to enforce. A second writer
 * would have to reproduce all of it and would drift the first time one side changed.
 * See `admin/docs/ADR-004-DOMAIN-OWNERSHIP.md` D-2.
 *
 * ── What a suspension deliberately does NOT do ────────────────────────────────
 * It does not touch the role entities. `Vendor.status`, `DeliveryAgent.status` and the
 * rest are a separate axis with their own admin surfaces and their own meanings — an
 * agent is `suspended` for delivery reasons that have nothing to do with whether the
 * person may sign in. Cascading would collapse two questions into one and make
 * reinstatement guess which of them was true before. The account lock is complete on its
 * own: a suspended user cannot authenticate at all, whatever their role entities say.
 */
export class AdminUserService {
  private userRepo: UserRepository;

  constructor() {
    this.userRepo = new UserRepository();
  }

  async getById(userId: string): Promise<IUser> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404, 'User not found');
    return user;
  }

  /**
   * Change the login identifiers.
   *
   * The one operation here that can lock a person out by accident, so it is guarded on
   * both sides: an identifier already held by another account is a 409 (rather than a
   * driver-level duplicate-key 500), and an edit that would leave the account with
   * neither identifier is refused outright — `login` resolves an account by email or
   * phone, so an account with neither can never be signed into again and has no
   * self-service path back.
   */
  async updateContact(userId: string, input: AdminUpdateUserContactInput): Promise<IUser> {
    const user = await this.getById(userId);

    const set: Record<string, string> = {};
    const unset: string[] = [];

    // `undefined` means the key was absent — leave it alone. `null` means clear it.
    // The two are NOT interchangeable here, which is the whole reason the schema uses
    // `clearable()` rather than `.optional()`.
    const nextEmail = input.email === undefined ? user.login_email ?? null : input.email;
    const nextPhone = input.phone === undefined ? user.login_phone ?? null : input.phone;

    if (!nextEmail && !nextPhone) {
      throw createAppError(
        ERROR_CODES.USER_CONTACT_REQUIRED,
        422,
        'An account must keep at least one login identifier — an email or a phone number'
      );
    }

    if (input.email !== undefined) {
      if (input.email === null) unset.push('login_email');
      else {
        await this.assertIdentifierFree('email', input.email, userId);
        set.login_email = input.email;
      }
    }

    if (input.phone !== undefined) {
      if (input.phone === null) unset.push('login_phone');
      else {
        await this.assertIdentifierFree('phone', input.phone, userId);
        set.login_phone = input.phone;
      }
    }

    // No actor stamp on this one, unlike `suspend`. A suspension is a STATE somebody has
    // to be able to explain later, so it carries who and why on the row; a contact edit
    // is an event, and events belong in the audit trail rather than as a permanent
    // `contact_changed_by` column that only ever describes the most recent edit. The
    // previous value — the part that actually matters when this is disputed — is in the
    // wi-admin audit row's `before`, which no column here could hold.
    const updated = await this.userRepo.updateContact(userId, set, unset);
    if (!updated) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404, 'User not found');
    return updated;
  }

  /**
   * Suspend an account.
   *
   * Guarded on the current status: two administrators can hold one user's screen open,
   * and the loser of that race must be told the state moved rather than have their
   * reason silently overwrite the winner's.
   */
  async suspend(userId: string, reason: string, actor: ActorRef): Promise<IUser> {
    await this.getById(userId);

    const suspended = await this.userRepo.applyStatusChangeIfCurrent(userId, 'active', 'suspended', {
      suspended_at: new Date(),
      suspended_reason: reason,
      ...actorStamp('suspended_by', actor),
    });

    if (!suspended) {
      throw createAppError(
        ERROR_CODES.USER_STATUS_CONFLICT,
        409,
        'This account is not active — it may already have been suspended',
        { expected: 'active' }
      );
    }

    return suspended;
  }

  /**
   * Lift a suspension.
   *
   * Clears the whole stamp, not part of it: a reason left behind describes a suspension
   * that no longer exists, and the next reader has no way to tell that from a current
   * one. The durable record is the wi-admin audit row, which is append-only.
   */
  async restore(userId: string): Promise<IUser> {
    await this.getById(userId);

    const restored = await this.userRepo.applyStatusChangeIfCurrent(userId, 'suspended', 'active', {
      suspended_at: null,
      suspended_reason: null,
      suspended_by_user_id: null,
      suspended_by_source: 'platform',
      suspended_by_name: null,
    });

    if (!restored) {
      throw createAppError(
        ERROR_CODES.USER_STATUS_CONFLICT,
        409,
        'This account is not suspended',
        { expected: 'suspended' }
      );
    }

    return restored;
  }

  /**
   * Refuse an identifier another account already holds.
   *
   * Checked rather than left to the sparse unique index, because a duplicate-key error
   * surfaces as a 500 with a driver message naming the index — which tells an
   * administrator nothing and looks like an outage. The index is still what guarantees
   * it under a race; this is what makes the ordinary case legible.
   */
  private async assertIdentifierFree(
    kind: 'email' | 'phone',
    value: string,
    userId: string
  ): Promise<void> {
    const holder =
      kind === 'email' ? await this.userRepo.findByEmail(value) : await this.userRepo.findByPhone(value);

    if (holder && holder.id !== userId) {
      throw createAppError(
        kind === 'email' ? ERROR_CODES.AUTH_EMAIL_TAKEN : ERROR_CODES.AUTH_PHONE_TAKEN,
        409,
        `That ${kind} already belongs to another account`
      );
    }
  }
}

/**
 * What a user looks like on the internal admin API.
 *
 * A named projection, never the document: `password_hash` is on `IUser`, and a handler
 * that returns `user` directly ships it. Naming the fields is the lock that survives
 * somebody adding a credential-shaped field to the schema next year.
 */
export interface AdminUserDto {
  id: string;
  email: string | null;
  phone: string | null;
  roles: string[];
  status: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  suspendedBy: { id: string | null; source: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export function toAdminUserDto(user: IUser): AdminUserDto {
  const suspended = user.status === 'suspended';

  return {
    id: user.id,
    email: user.login_email ?? null,
    phone: user.login_phone ?? null,
    roles: user.roles ?? [],
    status: user.status,
    suspendedAt: user.suspended_at ? user.suspended_at.toISOString() : null,
    suspendedReason: user.suspended_reason ?? null,
    suspendedBy: suspended
      ? {
          id: user.suspended_by_user_id ? user.suspended_by_user_id.toString() : null,
          source: user.suspended_by_source ?? 'platform',
          name: user.suspended_by_name ?? null,
        }
      : null,
    createdAt: user.created_at.toISOString(),
    updatedAt: user.updated_at.toISOString(),
  };
}
