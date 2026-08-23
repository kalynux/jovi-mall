import { UserModel, IUser, UserStatus } from './user.model';
import { normalizeEmailAddress } from '../../core/validation/email';
import { normalizePhoneNumber } from '../../core/validation/phone';

export class UserRepository {
  async create(userData: Partial<IUser>): Promise<IUser> {
    const user = new UserModel(userData);
    return await user.save();
  }

  /**
   * `login_phone` is stored in canonical E.164, so the lookup key is normalised
   * rather than matched verbatim. Request bodies already arrive normalised (the
   * Zod schemas transform), but this is the lookup every "is it taken?" check
   * and every login runs through, and a caller that reaches it from a script or
   * a webhook must not silently miss a row that exists.
   */
  async findByPhone(phone: string): Promise<IUser | null> {
    return await UserModel.findOne({ login_phone: normalizePhoneNumber(phone) });
  }

  /** Same reasoning as findByPhone: `login_email` is stored lowercased. */
  async findByEmail(email: string): Promise<IUser | null> {
    return await UserModel.findOne({ login_email: normalizeEmailAddress(email) });
  }

  async findById(userId: string): Promise<IUser | null> {
    return await UserModel.findById(userId);
  }

  /**
   * Move an account between statuses, guarded on the status it is moving FROM.
   *
   * A compare-and-set rather than a plain update, for the same reason
   * `ShipmentRepository.applyStatusChangeIfCurrent` is one: two administrators can hold
   * the same user open, and an unguarded write lets the loser's audit row claim a
   * transition that never happened. A miss returns null and the caller raises
   * `USER_STATUS_CONFLICT`.
   *
   * `fields` carries the whole suspension stamp (reason, actor, timestamp) or the whole
   * clearing of it — never a fragment, so a reason cannot outlive its suspension.
   */
  async applyStatusChangeIfCurrent(
    userId: string,
    fromStatus: UserStatus,
    toStatus: UserStatus,
    fields: Record<string, unknown>
  ): Promise<IUser | null> {
    return await UserModel.findOneAndUpdate(
      { _id: userId, status: fromStatus },
      { $set: { status: toStatus, ...fields } },
      { new: true }
    );
  }

  /**
   * Replace the login identifiers.
   *
   * `$unset` rather than `$set: null` for a cleared identifier: `login_email` and
   * `login_phone` carry SPARSE unique indexes, and a null is a value as far as that
   * index is concerned — two accounts explicitly set to null would collide. Removing
   * the field is what keeps them out of the index entirely.
   */
  async updateContact(
    userId: string,
    set: Record<string, string>,
    unset: string[]
  ): Promise<IUser | null> {
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (unset.length > 0) update.$unset = Object.fromEntries(unset.map((field) => [field, '']));

    if (Object.keys(update).length === 0) return await this.findById(userId);

    return await UserModel.findByIdAndUpdate(userId, update, { new: true });
  }

  /**
   * Update the password, and stamp the epoch that ends every session issued under the old one.
   *
   * The hash and the stamp go in ONE `$set` and are never written apart — the same rule the
   * suspension stamp above follows, for a sharper reason: a hash that lands without its
   * stamp leaves the new password live while every token minted under the old one keeps
   * working, which is precisely the hole this stamp exists to close. See
   * `core/auth/password-epoch.ts` for how it is read.
   *
   * @param userId - User ID
   * @param passwordHash - New bcrypt hashed password
   * @returns the epoch that was stamped, so the caller can reason about the tokens it is
   *          about to re-issue
   */
  async updatePassword(userId: string, passwordHash: string): Promise<Date> {
    const changedAt = new Date();
    await UserModel.findByIdAndUpdate(userId, {
      $set: { password_hash: passwordHash, password_changed_at: changedAt },
    });
    return changedAt;
  }

  async addRoleToUser(userId: string, role: string): Promise<IUser | null> {
    return await UserModel.findByIdAndUpdate(
      userId,
      { $addToSet: { roles: role } },
      { new: true }
    );
  }

  // ─── Self-service contact change (Phase 6 · 6.D.1) ─────────────────────────
  //
  // Four methods, and the pairing is the contract: `setPending*` opens a change and
  // `apply*Change` closes it, and the second writes the identifier and clears the pending
  // block in ONE `$set`. Never two statements — a pending block that outlives its own
  // confirmation is a token that can be spent twice, which is precisely the property the
  // whole flow exists to deny.
  //
  // `login_email` / `login_phone` are NOT touched by `setPending*`. That is the rule the
  // model's docstring states and the one a test asserts: writing the new identifier early
  // and marking it unverified locks a mistyped address out of the account with no
  // self-service way back, because the correction form is behind the sign-in.

  /** Open (or replace) a pending email change. Replaces silently — a second request supersedes. */
  async setPendingEmail(
    userId: string,
    pending: { address: string; tokenHash: string; requestedAt: Date; expiresAt: Date }
  ): Promise<IUser | null> {
    return await UserModel.findByIdAndUpdate(
      userId,
      {
        $set: {
          pending_email: {
            address: normalizeEmailAddress(pending.address),
            token_hash: pending.tokenHash,
            requested_at: pending.requestedAt,
            expires_at: pending.expiresAt,
          },
        },
      },
      { new: true }
    );
  }

  /** Open (or replace) a pending phone change. */
  async setPendingPhone(
    userId: string,
    pending: { number: string; requestedAt: Date; expiresAt: Date }
  ): Promise<IUser | null> {
    return await UserModel.findByIdAndUpdate(
      userId,
      {
        $set: {
          pending_phone: {
            number: normalizePhoneNumber(pending.number),
            requested_at: pending.requestedAt,
            expires_at: pending.expiresAt,
          },
        },
      },
      { new: true }
    );
  }

  /**
   * Resolve the account a confirmation token belongs to.
   *
   * By HASH, so the caller must digest the plaintext first — the collection never holds a
   * spendable token. Served by the sparse `pending_email.token_hash` index.
   */
  async findByPendingEmailToken(tokenHash: string): Promise<IUser | null> {
    return await UserModel.findOne({ 'pending_email.token_hash': tokenHash });
  }

  /**
   * Swap the login email and clear the pending block, in one write.
   *
   * Guarded on the token hash as well as the id — a compare-and-set, for the same reason
   * `applyStatusChangeIfCurrent` is one. Two confirmations of the same link can race, and
   * an unguarded write would let the loser report success for a swap the winner already
   * made and a third request may have since superseded. A miss returns null.
   */
  async applyEmailChange(userId: string, tokenHash: string, email: string): Promise<IUser | null> {
    return await UserModel.findOneAndUpdate(
      { _id: userId, 'pending_email.token_hash': tokenHash },
      { $set: { login_email: normalizeEmailAddress(email), pending_email: null } },
      { new: true }
    );
  }

  /**
   * Swap the login phone and clear the pending block, in one write.
   *
   * Guarded on the pending NUMBER rather than a token, because the phone flow has none —
   * see `IUser.pending_phone`. Same compare-and-set property: a second confirm after the
   * pending block was replaced by a newer request misses and returns null.
   */
  async applyPhoneChange(userId: string, pendingNumber: string): Promise<IUser | null> {
    const number = normalizePhoneNumber(pendingNumber);
    return await UserModel.findOneAndUpdate(
      { _id: userId, 'pending_phone.number': number },
      { $set: { login_phone: number, pending_phone: null } },
      { new: true }
    );
  }

  /** Abandon a pending change. `field` is the sub-document, not the identifier. */
  async clearPendingContact(
    userId: string,
    field: 'pending_email' | 'pending_phone'
  ): Promise<IUser | null> {
    return await UserModel.findByIdAndUpdate(userId, { $set: { [field]: null } }, { new: true });
  }
}
