import crypto from 'crypto';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { auditLogger } from '../../../core/audit/audit-logger';
import { normalizeEmailAddress } from '../../../core/validation/email';
import { normalizePhoneNumber } from '../../../core/validation/phone';
import { UserRepository } from '../user.repository';
import { IUser } from '../user.model';
import { CONTACT_CHANGE_CONFIG } from '../config/contact-change.config';
import { MailService } from '../../mail/mail.service';
import { connectionService, ConnectionService } from '../../channel-connections';
import { messagingPhoneToE164 } from '../../messaging-login/services/identity-resolver.service';
import { CustomerRepository } from '../../customers/customer.repository';
import { VendorRepository } from '../../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { AgentRepository } from '../../agents/repositories/agent.repository';

/**
 * Changing the email or phone an account signs in with — the self-service half
 * (Phase 6 · 6.D.1, ADR-A02's "build these first regardless of when closure lands").
 *
 * ── ONE RULE ABOVE ALL OTHERS: the identifier does not move until it is proved ──
 *
 * `login_email` and `login_phone` are what `POST /auth/login` resolves an account by. A
 * flow that writes the new value first and marks it unverified is the one that cannot be
 * recovered from: a typo'd address becomes the only way in, the account cannot be signed
 * into, and the correction form is behind the sign-in. So a request writes a **pending**
 * block and nothing else, and exactly one write ever moves the identifier — the one that
 * also clears the pending block, in the same `$set`.
 *
 * ── The two halves prove control DIFFERENTLY, and neither could use the other's proof ──
 *
 * **Email** is the ordinary shape: a random token is sent to the address being claimed and
 * coming back with it is the proof. Reused from `AuthService.sendEmailVerification` in
 * spirit, with two differences that matter — the token is stored **hashed** (a pending
 * change is durable, unlike that flow's Redis key, so the collection must not hold a
 * spendable credential), and the link points at the **storefront**, which POSTs it. That
 * second point is `PasswordResetService.buildResetLink`'s reasoning: a `GET` that mutates
 * is spent by whatever prefetches the mail.
 *
 * **Phone** has no equivalent, and O-4 is answered by saying so plainly rather than by
 * inventing one:
 *
 *   - There is no SMS provider in this service. Adding one is a commercial decision and a
 *     new external dependency, for one endpoint.
 *   - A WhatsApp message to a number that has not messaged us is outside the 24-hour
 *     service window, so it must be an approved paid **template** billed to a credit
 *     wallet — and a customer has no wallet. `WhatsAppPolicyValidator` would refuse it.
 *
 * What the platform *does* already have is the inbound direction. A `channel_connections`
 * row binding this account to a WhatsApp identity exists only because a message arrived
 * **from that number** and the account holder redeemed the resulting code while signed in —
 * that is a stronger proof of control than an OTP, and it is already built. So the phone
 * confirm asks for exactly that: the pending number must match a WhatsApp connection on the
 * caller's own account. The pending block is what makes it a deliberate two-step rather
 * than an ambient side effect of connecting a number for some other reason, and its expiry
 * is what bounds the intent.
 *
 * ⚠ **The consequence, stated rather than buried:** an account with no WhatsApp connection
 * cannot change its phone here, and a Telegram connection does not count (a `chat_id`
 * bears no relation to any phone number — the same fact `identity-resolver.service.ts`
 * builds its whole ladder around). Both are surfaced as
 * `CONTACT_CHANGE_PHONE_UNPROVEN`, whose message says what to do.
 *
 * ── What this deliberately does NOT do ────────────────────────────────────────
 *
 * It does not stamp `password_changed_at`. That field is the session revocation list, and
 * changing an identifier changes no credential — the password still authenticates, and
 * signing every device out over an email edit would be a surprise with no security story
 * behind it. A compromised account's remedy is still the password change.
 */

const EMAIL_TOKEN_BYTES = 32;

/** Where the confirmation link points. Same reasoning as `buildResetLink` — see the header. */
function confirmLinkBase(): string {
  const base = process.env.STOREFRONT_URL || process.env.API_PUBLIC_URL || '';
  return base.replace(/\/+$/, '');
}

/**
 * The confirmation URL. One builder, so the mail and the api-doc cannot drift on the path
 * or the query parameters.
 *
 * ── `app` names WHICH APP asked, and it is optional on purpose ────────────────
 *
 * **One page serves all four apps**, because `confirmEmailChange` is genuinely role-free:
 * it reads no `req.auth`, resolves the account from the token's digest, and syncs the
 * confirmed address onto *every* role profile the account holds. A per-dashboard copy of
 * that page would have nothing to do differently, and each copy would be one more place to
 * get the POST-not-GET rule wrong.
 *
 * The one thing a role-free confirm cannot work out for itself is **where to send the
 * person afterwards** — so the requesting role travels in the link, stamped by
 * `requestEmailChange`, which is the half of the flow that has a session.
 *
 * **Optional** because links already sitting in inboxes carry no `app=`, and the page
 * treats its absence as normal (it falls back to storefront destinations).
 *
 * ⚠ **A ROLE KEY, never a URL.** The page maps this through a compile-time table and
 * ignores anything else. Do not "improve" it into a `?return=` parameter: this page is
 * reachable with no session, so a caller-supplied destination would be an open redirect on
 * the same origin as the sign-in pages.
 */
export function buildEmailChangeLink(token: string, app?: string): string {
  const origin = app ? `&app=${encodeURIComponent(app)}` : '';
  return `${confirmLinkBase()}/account/confirm-email?token=${token}${origin}`;
}

/**
 * SHA-256, not bcrypt, and that is a deliberate downgrade of work factor.
 *
 * A bcrypt hash exists to survive an offline attack on a value a human chose, and it is
 * slow on purpose. This token is 32 random bytes — there is nothing to guess — and the
 * lookup is BY the digest, so it must be deterministic. The same choice
 * `PasswordResetService` makes about its own token.
 */
function digest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** What a client is told about a change in flight. Never the token, never the hash. */
export interface PendingContactChangeDto {
  /** The address or number being proved. The account holder typed it; echoing it is not a leak. */
  target: string;
  requestedAt: Date;
  expiresAt: Date;
}

export interface ContactStateDto {
  email: string | null;
  phone: string | null;
  pendingEmail: PendingContactChangeDto | null;
  pendingPhone: PendingContactChangeDto | null;
}

/** Who is asking — resolved from `req.auth`, never from a body. */
export interface ContactChangeActor {
  userId: string;
  role: string;
  roleEntityId: string;
}

export class ContactChangeService {
  constructor(
    private readonly userRepo: UserRepository = new UserRepository(),
    private readonly mailService: MailService = new MailService(),
    private readonly connections: ConnectionService = connectionService,
    private readonly customerRepo: CustomerRepository = new CustomerRepository(),
    private readonly vendorRepo: VendorRepository = new VendorRepository(),
    private readonly agencyRepo: DeliveryAgencyRepository = new DeliveryAgencyRepository(),
    private readonly agentRepo: AgentRepository = new AgentRepository(),
  ) {}

  // ── Read ────────────────────────────────────────────────────────────────────

  async getState(userId: string): Promise<ContactStateDto> {
    const user = await this.requireUser(userId);
    return {
      email: user.login_email ?? null,
      phone: user.login_phone ?? null,
      pendingEmail: toPendingDto(user.pending_email?.address, user.pending_email),
      pendingPhone: toPendingDto(user.pending_phone?.number, user.pending_phone),
    };
  }

  // ── Email ───────────────────────────────────────────────────────────────────

  /**
   * Request a change of login email.
   *
   * A second request supersedes the first — the pending block is replaced, which
   * invalidates the previous token because the lookup is by the hash now stored. That is
   * the correct behaviour for a mistyped address: the person retypes it and the wrong
   * link stops working, rather than two links racing.
   */
  async requestEmailChange(actor: ContactChangeActor, rawEmail: string): Promise<PendingContactChangeDto> {
    const user = await this.requireUser(actor.userId);
    const email = normalizeEmailAddress(rawEmail);

    if (user.login_email && normalizeEmailAddress(user.login_email) === email) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_SAME_IDENTIFIER, 422);
    }
    await this.assertEmailFree(email, actor.userId);

    const token = crypto.randomBytes(EMAIL_TOKEN_BYTES).toString('hex');
    const requestedAt = new Date();
    const expiresAt = new Date(
      requestedAt.getTime() + CONTACT_CHANGE_CONFIG.EMAIL_TOKEN_TTL_SECONDS * 1000,
    );

    await this.userRepo.setPendingEmail(actor.userId, {
      address: email,
      tokenHash: digest(token),
      requestedAt,
      expiresAt,
    });

    /**
     * Sent to the NEW address, never to the old one — the message IS the proof, so
     * delivering it anywhere else proves nothing.
     *
     * Awaited rather than fire-and-forget: if the mail cannot be sent the caller must
     * hear about it, because from their side the alternative is a link that never
     * arrives and a pending change they cannot explain.
     */
    await this.mailService.send({
      to: email,
      type: 'AUTH',
      subject: 'Confirm your new email address',
      template: 'verify-email-change',
      variables: {
        // `actor.role` is one of customer | vendor | agency | agent — resolved from the
        // verified token by `ContactChangeController.actorFrom`, never from a body, and
        // exactly the enum the confirmation page accepts.
        link: buildEmailChangeLink(token, actor.role),
        newEmail: email,
        hours: Math.max(1, Math.round(CONTACT_CHANGE_CONFIG.EMAIL_TOKEN_TTL_SECONDS / 3600)),
        year: new Date().getFullYear(),
      },
    });

    return { target: email, requestedAt, expiresAt };
  }

  /**
   * Confirm a change of login email.
   *
   * **Unauthenticated by design.** The token arrives from a mail client, and requiring the
   * session would mean the link only works in the browser that started the change —
   * usually not the one the mail is read in. The token is the credential, and it names the
   * account: nothing here reads `req.auth`.
   *
   * Uniqueness is re-checked here even though it was checked at request time. The window
   * between the two is up to an hour and the address is claimable in it; without the second
   * check the swap hits the sparse unique index and answers 500 instead of 409.
   */
  async confirmEmailChange(token: string): Promise<{ email: string }> {
    const tokenHash = digest(token);
    const user = await this.userRepo.findByPendingEmailToken(tokenHash);
    if (!user || !user.pending_email) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_TOKEN_INVALID, 400);
    }

    const pending = user.pending_email;
    if (pending.expires_at.getTime() <= Date.now()) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_EXPIRED, 422);
    }

    const userId = user._id.toString();
    await this.assertEmailFree(pending.address, userId);

    const updated = await this.userRepo.applyEmailChange(userId, tokenHash, pending.address);
    if (!updated) {
      // The compare-and-set missed: the pending block moved under us — a second confirm,
      // or a newer request. Spent, either way.
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_TOKEN_INVALID, 400);
    }

    await this.syncRoleEntities(updated, { email: pending.address });
    await this.audit(userId, updated.roles?.[0] ?? 'customer', 'EMAIL_CHANGED', {
      email: pending.address,
    });

    return { email: pending.address };
  }

  // ── Phone ───────────────────────────────────────────────────────────────────

  /** Request a change of login phone. See the header for what the proof is and is not. */
  async requestPhoneChange(actor: ContactChangeActor, rawPhone: string): Promise<PendingContactChangeDto> {
    const user = await this.requireUser(actor.userId);
    const phone = normalizePhoneNumber(rawPhone);

    if (user.login_phone && normalizePhoneNumber(user.login_phone) === phone) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_SAME_IDENTIFIER, 422);
    }
    await this.assertPhoneFree(phone, actor.userId);

    const requestedAt = new Date();
    const expiresAt = new Date(
      requestedAt.getTime() + CONTACT_CHANGE_CONFIG.PHONE_PENDING_TTL_SECONDS * 1000,
    );

    await this.userRepo.setPendingPhone(actor.userId, { number: phone, requestedAt, expiresAt });

    return { target: phone, requestedAt, expiresAt };
  }

  /**
   * Confirm a change of login phone.
   *
   * Authenticated, unlike the email confirm, and for the mirror-image reason: there is no
   * token naming the account, so the session is what identifies the caller — and the proof
   * (a WhatsApp connection) is a property *of that account*, which can only be looked up
   * once the account is known.
   */
  async confirmPhoneChange(actor: ContactChangeActor): Promise<{ phone: string }> {
    const user = await this.requireUser(actor.userId);
    const pending = user.pending_phone;
    if (!pending) throw createAppError(ERROR_CODES.CONTACT_CHANGE_NOT_PENDING, 409);

    if (pending.expires_at.getTime() <= Date.now()) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_EXPIRED, 422);
    }

    await this.assertPhoneProved(actor.userId, pending.number);
    await this.assertPhoneFree(pending.number, actor.userId);

    const updated = await this.userRepo.applyPhoneChange(actor.userId, pending.number);
    if (!updated) throw createAppError(ERROR_CODES.CONTACT_CHANGE_NOT_PENDING, 409);

    await this.syncRoleEntities(updated, { phone: pending.number });
    await this.audit(actor.userId, actor.role, 'PHONE_CHANGED', { phone: pending.number });

    return { phone: pending.number };
  }

  // ── Cancel ──────────────────────────────────────────────────────────────────

  async cancelPending(actor: ContactChangeActor, kind: 'email' | 'phone'): Promise<void> {
    const user = await this.requireUser(actor.userId);
    const field = kind === 'email' ? 'pending_email' : 'pending_phone';
    if (!user[field]) throw createAppError(ERROR_CODES.CONTACT_CHANGE_NOT_PENDING, 409);

    await this.userRepo.clearPendingContact(actor.userId, field);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async requireUser(userId: string): Promise<IUser> {
    const user = await this.userRepo.findById(userId);
    if (!user) throw createAppError(ERROR_CODES.USER_NOT_FOUND, 404);
    return user;
  }

  /**
   * ⚠ Compared against the caller's own id, so re-confirming an address this account
   * already holds is not reported as taken. Without it the second confirm of a link
   * answers "in use by someone else" about the person holding it.
   */
  private async assertEmailFree(email: string, selfUserId: string): Promise<void> {
    const holder = await this.userRepo.findByEmail(email);
    if (holder && holder._id.toString() !== selfUserId) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_IDENTIFIER_TAKEN, 409);
    }
  }

  private async assertPhoneFree(phone: string, selfUserId: string): Promise<void> {
    const holder = await this.userRepo.findByPhone(phone);
    if (holder && holder._id.toString() !== selfUserId) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_IDENTIFIER_TAKEN, 409);
    }
  }

  /**
   * The phone proof: this account holds a WhatsApp connection whose identity IS the number.
   *
   * `external_id` arrives from Meta as bare digits (`237600123456`) while a login phone is
   * strict E.164 (`+237600123456`), and the shared helpers do not bridge that gap — a
   * verbatim comparison matches nothing, for every user, while looking perfectly
   * implemented. `messagingPhoneToE164` is the repair, and it is imported rather than
   * re-derived precisely because there must be one of it: this is the single easiest way to
   * ship the whole flow broken, and `identity-resolver.service.ts` has the fixture that
   * catches it.
   */
  private async assertPhoneProved(userId: string, pendingNumber: string): Promise<void> {
    const connection = await this.connections.getConnection(userId, 'whatsapp');
    const proved = connection ? messagingPhoneToE164(connection.external_id) : null;

    if (!proved || proved !== normalizePhoneNumber(pendingNumber)) {
      throw createAppError(ERROR_CODES.CONTACT_CHANGE_PHONE_UNPROVEN, 422, undefined, {
        channel: 'whatsapp',
      });
    }
  }

  /**
   * Carry the confirmed value onto the role profiles.
   *
   * **Every role the account holds, not just the one that asked**, and that is a decision
   * rather than thoroughness. `login_email` is one value for the account, so leaving a
   * vendor profile showing the old address while the sign-in uses the new one produces two
   * answers to "what is this person's email" — and the profile is the one every
   * notification stack reads. One person, one contact.
   *
   * Best-effort per role: a failure here must not undo a swap that has already committed,
   * because the identifier is the part that matters and it is correct. The mismatch it
   * would leave is visible and repairable; a half-rolled-back identifier is not.
   */
  private async syncRoleEntities(user: IUser, contact: { email?: string; phone?: string }): Promise<void> {
    const userId = user._id.toString();
    const byRole: Record<string, () => Promise<unknown>> = {
      customer: () => this.customerRepo.setVerifiedContact(userId, contact),
      vendor: () => this.vendorRepo.setVerifiedContact(userId, contact),
      agency: () => this.agencyRepo.setVerifiedContact(userId, contact),
      agent: () => this.agentRepo.setVerifiedContact(userId, contact),
    };

    for (const role of user.roles ?? []) {
      const sync = byRole[role];
      if (!sync) continue;
      try {
        await sync();
      } catch (error) {
        console.error(`[ContactChangeService] failed to sync ${role} profile contact`, error);
      }
    }
  }

  /**
   * The durable record of who changed what.
   *
   * The row carries the NEW value only. The old one is what a dispute is actually about,
   * and it is deliberately not here: this service holds no history column, and inventing
   * one would be a `contact_changed_from` that only ever describes the most recent edit —
   * the same argument `AdminUserService.updateContact` makes about not stamping an actor.
   * The previous value lives in the audit trail's own `before`, where an administrator's
   * edit already puts it.
   */
  private async audit(
    userId: string,
    role: string,
    action: 'EMAIL_CHANGED' | 'PHONE_CHANGED',
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await auditLogger.log({
      actor: { userId, role },
      action,
      resource: { type: 'User', id: userId },
      metadata,
      timestamp: new Date(),
    });
  }
}

function toPendingDto(
  target: string | undefined,
  pending: { requested_at: Date; expires_at: Date } | null | undefined,
): PendingContactChangeDto | null {
  if (!target || !pending) return null;
  return { target, requestedAt: pending.requested_at, expiresAt: pending.expires_at };
}

export const contactChangeService = new ContactChangeService();
