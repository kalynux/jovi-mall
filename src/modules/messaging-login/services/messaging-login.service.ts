import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { AuthTokens, issueTokenPair } from '../../../core/auth/token.issuer';
import { UserRepository } from '../../users/user.repository';
import { CustomerRepository } from '../../customers/customer.repository';
import { IUser } from '../../users/user.model';
import { normalizeLoginIdentifier } from '../domain/login-identifier';
import { ResolvedLoginAccount } from './identity-resolver.service';
import {
  IssuedLoginSession,
  LoginSessionStore,
  loginSessionStore,
} from './login-session.store';

/**
 * Minting a passwordless sign-in, and spending one.
 *
 * ── THE ROLE IS FIXED ────────────────────────────────────────────────────────
 * Every session issued here is scoped to `customer`, always, whatever else the
 * account holds. `/login` is a shopper's convenience; a vendor, agency or agent
 * signing in still presents a password, because those roles reach money and
 * other people's data. The role is a literal in this file and is never taken
 * from a request.
 *
 * ── EVERY GATE IS RE-CHECKED AT REDEMPTION ───────────────────────────────────
 * Not at mint. The record is a pointer with a ten-minute deadline, and a
 * suspension, a role change or a deletion inside those ten minutes has to be
 * seen — so the account is re-read and re-judged at the moment a session is
 * actually issued. That is the whole reason the record stores ids rather than a
 * snapshot.
 */

/** What redemption yields: a real session, plus who it belongs to. */
export interface MagicSignInResult extends AuthTokens {
  user: IUser;
  role: 'customer';
}

export class MessagingLoginService {
  constructor(
    private readonly store: LoginSessionStore = loginSessionStore,
    private readonly userRepo: UserRepository = new UserRepository(),
    private readonly customerRepo: CustomerRepository = new CustomerRepository()
  ) {}

  /**
   * Mint one session and its two credentials for an account the resolver has
   * already established and gated.
   *
   * Takes a `ResolvedLoginAccount` rather than an id, so it is not reachable
   * with an account nobody checked — the type is the reminder.
   */
  async mint(account: ResolvedLoginAccount): Promise<IssuedLoginSession> {
    return this.store.issue({
      userId: account.userId,
      customerId: account.customerId,
      channel: account.channel,
      externalIdentity: account.externalIdentity,
      identityHint: account.identityHint,
    });
  }

  /**
   * The same session, issued by an administrator on somebody else's behalf.
   *
   * ── What is identical, and that is the point ────────────────────────────────
   * The record, the ten minutes, the two credentials, the single-use semantics and the
   * `customer` literal are all `mint`'s. The gates are re-run at redemption here exactly
   * as they are there, so a suspension between issue and use is still seen. This method
   * exists to name a different ORIGIN, not a different mechanism.
   *
   * ── Why `channel: 'admin'` and `externalIdentity: userId` ───────────────────
   * The bot paths key the identity on a messaging account the sender proved they control.
   * There is no such account here — the operator proved nothing about the party's phone,
   * and the link may go out over email. Keying on the target user id is what preserves
   * the property that actually matters: re-issuing revokes the previous link, so an
   * operator who clicks twice leaves ONE live credential rather than two.
   *
   * ⚠ The identity is deliberately NOT the administrator's. Two operators helping the
   * same customer must not each leave a live session credential behind.
   *
   * `identityHint` is null: "signed in from WhatsApp ••••3456" would be a lie about where
   * this came from, and there is no honest short form of "an operator sent it to you".
   */
  async mintForAdministrator(account: {
    userId: string;
    customerId: string;
  }): Promise<IssuedLoginSession> {
    return this.store.issue({
      userId: account.userId,
      customerId: account.customerId,
      channel: 'admin',
      externalIdentity: account.userId,
      identityHint: null,
    });
  }

  /**
   * `POST /api/auth/magic/link` — redeem the magic link.
   *
   * No attempt counter, and none is missing: the token is 32 random bytes, and
   * there is no identifier to key a counter on anyway (the request carries the
   * token alone). The `/api/auth` credential bucket bounds the endpoint by IP.
   */
  async redeemLink(token: string): Promise<MagicSignInResult> {
    const outcome = await this.store.consumeByToken(token);

    if (outcome.status === 'expired') {
      throw createAppError(ERROR_CODES.MAGIC_LINK_EXPIRED, 401);
    }
    if (outcome.status === 'missing') {
      // Never-existed, already-spent and long-gone answer identically.
      throw createAppError(ERROR_CODES.MAGIC_LINK_INVALID, 401);
    }

    const user = await this.loadAndGate(outcome.record.userId);
    return this.issueSession(user);
  }

  /**
   * `POST /api/auth/magic/code` — redeem the typed code against a phone or email.
   *
   * ── ONE ERROR CODE FOR FOUR SITUATIONS, DELIBERATELY ─────────────────────────
   * Unknown identifier, wrong code, expired-and-swept, and a code that belongs to
   * a DIFFERENT account than the identifier resolves to all answer
   * `MAGIC_CODE_INVALID`. Distinguishing any of them turns this endpoint into a
   * registration oracle: post a phone number with a junk code and learn from the
   * error whether that person shops here. For anyone, for any number, with no
   * account required.
   *
   * The one exception is a code that is genuinely ours and genuinely late, which
   * answers `MAGIC_CODE_EXPIRED` — and it only reaches that answer AFTER the
   * identifier has been matched to the record's own account, so it confirms
   * nothing to somebody guessing.
   */
  async redeemCode(rawIdentifier: string, rawCode: string): Promise<MagicSignInResult> {
    const identifier = normalizeLoginIdentifier(rawIdentifier);

    /**
     * Counted BEFORE the code is consumed, exactly as `/connect` does. Counting
     * only failures would let a guesser spend other people's live codes for
     * free, and the point is to bound how many codes may be tested at all.
     *
     * Keyed on the identifier being TARGETED, because the caller is anonymous
     * here — this endpoint takes no session, so there is no caller to key on.
     */
    const withinLimit = await this.store.recordAttempt(identifier);
    if (!withinLimit) {
      throw createAppError(ERROR_CODES.MAGIC_ATTEMPTS_EXCEEDED, 429);
    }

    const outcome = await this.store.consumeByCode(rawCode);
    if (outcome.status === 'missing') {
      throw createAppError(ERROR_CODES.MAGIC_CODE_INVALID, 401);
    }

    // Resolved AFTER the code is spent, so a wrong code costs the same work and
    // the same answer whether or not the identifier names anybody.
    const target = await this.findByIdentifier(identifier);

    /**
     * The code must belong to the account the identifier names.
     *
     * Without this, any live code signs its holder into whichever account they
     * type — which is precisely the "the code is not really a second factor"
     * problem stated in D-2, arriving from the other direction. A mismatch
     * answers exactly like a wrong code.
     */
    if (!target || target.id !== outcome.record.userId) {
      throw createAppError(ERROR_CODES.MAGIC_CODE_INVALID, 401);
    }

    if (outcome.status === 'expired') {
      throw createAppError(ERROR_CODES.MAGIC_CODE_EXPIRED, 401);
    }

    const user = await this.loadAndGate(outcome.record.userId);
    await this.store.clearAttempts(identifier);

    return this.issueSession(user);
  }

  /**
   * Re-read the account and re-apply every gate the resolver applied at mint.
   *
   * The ten minutes between the two are real: an administrator may have
   * suspended the account, the customer profile may be gone. A cached copy from
   * mint time would not see any of it, which is why none is kept.
   */
  private async loadAndGate(userId: string): Promise<IUser> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw createAppError(ERROR_CODES.AUTH_ACCOUNT_NOT_FOUND, 401);

    if (user.status !== 'active') {
      throw createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, 'This account is suspended');
    }

    // The role may have been removed since the credential was minted. Never
    // re-provisioned here — see the resolver's refusal table.
    if (!user.roles.includes('customer')) {
      throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, undefined, { role: 'customer' });
    }

    const customer = await this.customerRepo.findByUserId(user.id);
    if (!customer) {
      throw createAppError(ERROR_CODES.AUTH_PROFILE_NOT_FOUND, 404, undefined, { role: 'customer' });
    }

    return user;
  }

  /** The role is a literal. It is never read from a request or from the record. */
  private issueSession(user: IUser): MagicSignInResult {
    const tokens = issueTokenPair(String(user._id), 'customer');
    return { user, role: 'customer', ...tokens };
  }

  /** The same `@` discrimination and the same lookups `POST /auth/login` uses. */
  private async findByIdentifier(identifier: string): Promise<IUser | null> {
    return identifier.includes('@')
      ? this.userRepo.findByEmail(identifier)
      : this.userRepo.findByPhone(identifier);
  }
}

export const messagingLoginService = new MessagingLoginService();
