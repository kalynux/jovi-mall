import {
  connectionService,
  ConnectionService,
  maskIdentity,
  MessagingChannel,
} from '../../channel-connections';
import { UserRepository } from '../../users/user.repository';
import { CustomerRepository } from '../../customers/customer.repository';
import { IUser } from '../../users/user.model';
import { normalizePhoneNumber, toE164 } from '../../../core/validation/phone';

/**
 * Who is this chat, and may they do the thing they asked for?
 *
 * The whole of D-1 lives here: the resolution ladder, the E.164 repair, and the refusal
 * table. It is one file because every one of those steps has to agree about what "this
 * messaging account belongs to that platform account" means, and a second opinion anywhere in
 * the chain is a login bug.
 *
 * ── THE LADDER (identical for every intent) ──────────────────────────────────
 *   1. `channel_connections` — the identity is already bound. Instant, both channels, and
 *      after the first success this is the only step that runs.
 *   2. **WhatsApp only:** `wa_phone_id` IS the sender's phone number, so it matches
 *      `User.login_phone` directly — possession is proved by the message itself, the same
 *      model as an SMS OTP. Persists the connection on success, so step 1 serves every later
 *      request.
 *   3. **Telegram only:** a `chat_id` bears no relation to any phone number, so a first-time
 *      sender is ANONYMOUS to us. The answer is not a column — a column is storage, and what
 *      is missing is *verification*. Telegram's `request_contact` supplies it, and
 *      `resolveFromVerifiedContact` below completes the flow.
 *
 * ── THE INTENT IS WHAT DIFFERS, AND ONLY AT THE GATE ─────────────────────────
 * `login` mints a customer SESSION, so it requires the `customer` role and a customer
 * profile. `reset` mints a password-reset link, and passwords belong to the **account** —
 * so it serves every role: vendor, agency, agent and customer alike. Locating the account is
 * identical for both; only `gate()` diverges. Keeping the ladder shared is what stops the two
 * commands disagreeing about whose chat this is.
 *
 * ── WHY THIS READS `channel_connections` AND NOT A NEW COLUMN ────────────────
 * That collection already *is* this mapping — `(user_id, channel, external_id)` with unique
 * indexes in both directions — it is already read by all four notification stacks, and it is
 * what `/connect` writes. A `telegram_chat_id` beside it would be a second source of truth
 * for one fact, which is exactly the shape that was removed when the `wa` sub-document came
 * off four role models. Two mappings drift, and the drift is a login bug.
 */

/**
 * What a chat is asking to do. Passed FIRST and never defaulted — a forgotten intent would
 * mint a sign-in session for somebody who asked to reset a password.
 */
export type MessagingAuthIntent = 'login' | 'reset';

/** `/login`: minting a session needs the customer profile it will be scoped to. */
export interface ResolvedLoginAccount {
  userId: string;
  customerId: string;
  channel: MessagingChannel;
  externalIdentity: string;
  identityHint: string | null;
}

/**
 * `/reset-password`: the account, whatever roles it holds.
 *
 * Deliberately carries no `customerId`. A password belongs to the `users` row, and a vendor
 * or an agency resetting theirs has no customer profile to name — requiring one would refuse
 * exactly the people this command exists for.
 */
export interface ResolvedResetAccount {
  userId: string;
  channel: MessagingChannel;
  externalIdentity: string;
  identityHint: string | null;
}

/**
 * The outcome, as a discriminated union rather than an exception.
 *
 * A refusal here is an ordinary, expected answer that the bot has to put into words — not an
 * error condition. Returning it keeps the whole refusal table visible in one `switch` at the
 * command layer, where the copy lives, instead of scattered across catch blocks.
 */
export type IdentityResolution<TAccount> =
  | { status: 'resolved'; account: TAccount }
  /** Telegram, first contact: we must ask for a verified phone number. */
  | { status: 'needs_contact' }
  | { status: 'no_account' }
  /** `login` only — the account holds no customer role. Never produced for `reset`. */
  | { status: 'not_customer' }
  | { status: 'account_inactive' }
  /** This messaging identity already belongs to a different platform account. */
  | { status: 'identity_taken' };

export type LoginIdentityResolution = IdentityResolution<ResolvedLoginAccount>;
export type ResetIdentityResolution = IdentityResolution<ResolvedResetAccount>;

/**
 * A messaging-supplied phone number, in strict E.164 — or null.
 *
 * ⚠ **THE SINGLE EASIEST WAY TO SHIP THIS FEATURE BROKEN.** `wa_phone_id` arrives from Meta
 * as BARE DIGITS (`237600123456`) while `login_phone` is stored as strict E.164
 * (`+237600123456`), and the shared helpers do not bridge that gap — verified against the
 * real code:
 *
 *     normalizePhoneNumber('237600123456') → '237600123456'  (adds no '+')
 *     isE164('237600123456')               → false           (/^\+[1-9]\d{6,14}$/)
 *     toE164('237600123456')               → null
 *
 * So a naive `findByPhone(wa_phone_id)` queries `login_phone: '237600123456'` and matches
 * NOTHING, FOR EVERY USER — a feature that reports "no account found" to everybody while
 * looking perfectly implemented. Every test that does not use a realistic bare-digits fixture
 * still passes. `test:messaging-login` carries one for exactly this.
 *
 * ── It is used for Telegram too, and that is not over-generalisation ─────────
 * Telegram's `contact.phone_number` is likewise inconsistent about the leading `+` — some
 * clients send it, some do not. The design note only flagged the WhatsApp case; the trap is
 * identical and so is the repair, so both paths go through this one function.
 *
 * The `+` is prepended ONLY when the value is all digits. A value that already carries one,
 * or that carries anything else, is handed to `toE164` untouched — so this can repair a
 * missing prefix and can never invent a country code or rescue a genuinely malformed number.
 */
export function messagingPhoneToE164(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const normalized = normalizePhoneNumber(raw.trim());
  const candidate = /^\d+$/.test(normalized) ? `+${normalized}` : normalized;

  return toE164(candidate);
}

/** Where a located account came from — the caller only persists what it had to look up. */
type Located =
  | { status: 'found'; user: IUser; identityHint: string | null; alreadyBound: boolean }
  | { status: 'needs_contact' }
  | { status: 'no_account' };

export class LoginIdentityResolver {
  constructor(
    private readonly connections: ConnectionService = connectionService,
    private readonly userRepo: UserRepository = new UserRepository(),
    private readonly customerRepo: CustomerRepository = new CustomerRepository()
  ) {}

  // ── Entry points ───────────────────────────────────────────────────────────

  /** `/login` — resolve the sender and gate them to a customer session. */
  async resolveForLogin(
    channel: MessagingChannel,
    externalIdentity: string,
    profile: { displayName?: string | null; handle?: string | null } = {}
  ): Promise<LoginIdentityResolution> {
    return this.resolve('login', channel, externalIdentity, profile) as Promise<LoginIdentityResolution>;
  }

  /**
   * `/reset-password` — resolve the sender, for ANY role.
   *
   * A password belongs to the account, so a vendor, an agency and an agent reach this exactly
   * as a customer does. The only gate is that the account is active: a suspended one must not
   * be reset back into, which is the same rule `PasswordResetService.requestReset` applies
   * (silently, because its caller is anonymous — here the sender has proved they own the
   * number, so they are told).
   */
  async resolveForReset(
    channel: MessagingChannel,
    externalIdentity: string,
    profile: { displayName?: string | null; handle?: string | null } = {}
  ): Promise<ResetIdentityResolution> {
    return this.resolve('reset', channel, externalIdentity, profile) as Promise<ResetIdentityResolution>;
  }

  /**
   * The Telegram completion: a contact the sender shared about THEMSELVES.
   *
   * ⚠ **The caller must have already enforced `contact.user_id === the sender`.** That guard
   * is the entire security of this path — a Telegram user can share somebody else's contact
   * card from their address book and it arrives in the same shape, so without it anyone could
   * forward a victim's contact and act as them. It lives in `login-contact.command.ts`, where
   * the raw payload is, and it refuses outright rather than treating a mismatch as a hint.
   *
   * By the time execution reaches here, `phoneNumber` is a number Telegram verified at signup
   * and the sender has proved is theirs.
   *
   * `intent` is first and required: this one method completes both commands, and a defaulted
   * intent would mint a sign-in session for somebody who asked to reset a password.
   */
  async resolveFromVerifiedContact(
    intent: MessagingAuthIntent,
    chatId: string,
    phoneNumber: string,
    profile: { displayName?: string | null; handle?: string | null } = {}
  ): Promise<IdentityResolution<ResolvedLoginAccount | ResolvedResetAccount>> {
    const phone = messagingPhoneToE164(phoneNumber);
    // A number that will not normalise is refused rather than guessed at.
    if (!phone) return { status: 'no_account' };

    const user = await this.userRepo.findByPhone(phone);
    if (!user) return { status: 'no_account' };

    /**
     * The chat is already somebody else's. Refuse; never transfer.
     *
     * The reachable way to hit this is one person's Telegram against another person's phone
     * number — so it is exactly the case the `user_id` guard is there to stop, arriving by a
     * different door. Silently re-pointing the row would hand this chat access to an account
     * it has no claim to.
     */
    const existing = await this.connections.resolveIdentityOwner('telegram', chatId);
    if (existing && existing.user_id.toString() !== user.id) {
      return { status: 'identity_taken' };
    }

    const resolution = await this.gate(intent, user, {
      channel: 'telegram',
      externalIdentity: chatId,
      identityHint: maskIdentity('telegram', chatId, profile.handle ?? null),
    });

    if (resolution.status === 'resolved') {
      await this.connections.bindVerifiedIdentity(resolution.account.userId, {
        channel: 'telegram',
        externalId: chatId,
        displayName: profile.displayName ?? null,
        handle: profile.handle ?? null,
      });
    }

    return resolution;
  }

  // ── The shared ladder ──────────────────────────────────────────────────────

  private async resolve(
    intent: MessagingAuthIntent,
    channel: MessagingChannel,
    externalIdentity: string,
    profile: { displayName?: string | null; handle?: string | null }
  ): Promise<IdentityResolution<ResolvedLoginAccount | ResolvedResetAccount>> {
    const located = await this.locate(channel, externalIdentity);
    if (located.status !== 'found') return located;

    const resolution = await this.gate(intent, located.user, {
      channel,
      externalIdentity,
      identityHint: located.identityHint,
    });

    /**
     * Persist ONLY what we had to look up, and ONLY on success.
     *
     * Not on a refusal: binding a channel is a durable claim about who this chat belongs to,
     * and recording it off the back of a request the platform just refused is a side effect
     * nobody asked for — on an account that, suspended, cannot even be used.
     */
    if (resolution.status === 'resolved' && !located.alreadyBound) {
      await this.connections.bindVerifiedIdentity(resolution.account.userId, {
        channel,
        externalId: externalIdentity,
        displayName: profile.displayName ?? null,
        // WhatsApp has no handle; Telegram never reaches this branch unbound.
        handle: channel === 'telegram' ? profile.handle ?? null : null,
      });
    }

    return resolution;
  }

  /** Steps 1–3, with no judgement about what the caller wants to do. */
  private async locate(channel: MessagingChannel, externalIdentity: string): Promise<Located> {
    // ── Step 1: already bound. Both channels, and the only step after the first success.
    const connection = await this.connections.resolveIdentityOwner(channel, externalIdentity);
    if (connection) {
      const user = await this.userRepo.findById(connection.user_id.toString());
      // A connection whose user is gone is a dangling row, not an account.
      if (!user) return { status: 'no_account' };

      return {
        status: 'found',
        user,
        identityHint: maskIdentity(channel, connection.external_id, connection.handle),
        alreadyBound: true,
      };
    }

    // ── Step 3: Telegram cannot go further without a verified contact. Asked for BEFORE any
    // lookup, because there is nothing yet to look up — a chat id matches no column anywhere.
    if (channel === 'telegram') return { status: 'needs_contact' };

    // ── Step 2: WhatsApp. The sender id IS the number.
    const phone = messagingPhoneToE164(externalIdentity);
    if (!phone) return { status: 'no_account' };

    const user = await this.userRepo.findByPhone(phone);
    if (!user) return { status: 'no_account' };

    return {
      status: 'found',
      user,
      identityHint: maskIdentity(channel, externalIdentity, null),
      alreadyBound: false,
    };
  }

  /**
   * The refusal table, in one place, for both entry points and both intents.
   *
   * ── A `/login` session is ALWAYS scoped to `customer` ────────────────────────
   * No other role is reachable that way, whatever else the account holds, and a customer role
   * is **never auto-provisioned** — a vendor who messages the bot is told to use their
   * password, not quietly given a shopping account.
   *
   * ── `/reset-password` has no role gate, and must not ─────────────────────────
   * A password belongs to the `users` row. Gating a reset on the customer role would lock out
   * every vendor, agency and agent — precisely the people most likely to have a password to
   * forget, since customers largely do not have one at all.
   *
   * Status is checked first for both, because "this account is not active" is the more
   * actionable answer when both are true.
   *
   * Nothing here is an enumeration risk: the sender has already proved they control the
   * number, so telling them what is wrong with their own account discloses nothing.
   */
  private async gate(
    intent: MessagingAuthIntent,
    user: IUser,
    identity: {
      channel: MessagingChannel;
      externalIdentity: string;
      identityHint: string | null;
    }
  ): Promise<IdentityResolution<ResolvedLoginAccount | ResolvedResetAccount>> {
    if (user.status !== 'active') return { status: 'account_inactive' };

    if (intent === 'reset') {
      return { status: 'resolved', account: { userId: user.id, ...identity } };
    }

    if (!user.roles.includes('customer')) return { status: 'not_customer' };

    const customer = await this.customerRepo.findByUserId(user.id);
    if (!customer) {
      /**
       * The role says customer and no profile exists — a broken invariant rather than a user
       * error, since `register` and `addRole` write the two together. Refused (there is no
       * `customerId` to scope a session to) and logged, because it is our bug and it will
       * otherwise look like "no account" to everyone involved.
       */
      console.error(
        `[MessagingLogin] user ${user.id} holds the customer role with no customer profile`
      );
      return { status: 'not_customer' };
    }

    return {
      status: 'resolved',
      account: { userId: user.id, customerId: customer._id.toString(), ...identity },
    };
  }
}

export const loginIdentityResolver = new LoginIdentityResolver();
