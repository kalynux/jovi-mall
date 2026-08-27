import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { UserRepository } from '../users/user.repository';
import { CustomerRepository } from '../customers/customer.repository';
import { VendorRepository } from '../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../delivery/delivery-agency.repository';
import { AgentRepository } from '../agents';
import { StoreProvisioningService } from '../store/service/store-provisioning.service';
import { MagazinProvisioningService } from '../magazin/service/magazin-provisioning.service';
import {
  AddRoleInput,
  AuthMeInput,
  isAuthenticatableRole,
  LoginInput,
  RegisterInput,
} from './auth.schemas';
import { IUser } from '../users/user.model';
import { EMAIL_VERIFY_DB, getRedisClient } from '../../infra/redis/redis.factory';
import { MailService } from '../mail/mail.service';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';
import { getJwtRefreshSecret } from '../../config/secrets.config';
import { isTokenPredatingPasswordChange } from '../../core/auth/password-epoch';
import { isSessionCapReached, resolveAuthTime } from '../../core/auth/session-cap';
import { generateSystemPassword } from '../../core/auth/system-password';
import {
  AuthTokens,
  generateAccessToken,
  generateRefreshToken,
  issueTokenPair,
  nowAuthTime,
} from '../../core/auth/token.issuer';

const EMAIL_VERIFY_EXPIRE = 86400; // 24 hours

// Public base URL of this API, used to build links emailed to users (e.g. the
// email-verification link). Defaults to localhost for local dev; set
// API_PUBLIC_URL in non-local environments. Trailing slashes are stripped.
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

// Token TTLs, the payload shapes and the signing itself moved to
// `core/auth/token.issuer.ts`. The methods below stay as delegates so every existing caller
// is untouched; what changed is that minting a pair no longer requires constructing this
// service and everything it depends on.
export type { AuthTokens } from '../../core/auth/token.issuer';

export class AuthService {
  private userRepo: UserRepository;
  private customerRepo: CustomerRepository;
  private vendorRepo: VendorRepository;
  private agencyRepo: DeliveryAgencyRepository;
  private agentRepo: AgentRepository;
  private mailService: MailService;
  private storeProvisioning: StoreProvisioningService;
  private magazinProvisioning: MagazinProvisioningService;
  private redisDb = EMAIL_VERIFY_DB;

  constructor() {
    this.userRepo = new UserRepository();
    this.customerRepo = new CustomerRepository();
    this.vendorRepo = new VendorRepository();
    this.agencyRepo = new DeliveryAgencyRepository();
    this.agentRepo = new AgentRepository();
    this.mailService = new MailService();
    this.storeProvisioning = new StoreProvisioningService();
    this.magazinProvisioning = new MagazinProvisioningService();
  }

  // ─── Token Generation ───────────────────────────────────────────────────────

  generateAccessToken(user: IUser, role: string, authTime: number = nowAuthTime()): string {
    return generateAccessToken(String(user._id), role, authTime);
  }

  generateRefreshToken(user: IUser, role: string, authTime: number = nowAuthTime()): string {
    return generateRefreshToken(String(user._id), role, authTime);
  }

  /**
   * `authTime` omitted means "the person just proved a credential" — see the trap note on
   * `core/auth/token.issuer.ts`'s `issueTokenPair`. Every call in this class that is NOT a
   * credential proof passes one.
   */
  issueTokenPair(user: IUser, role: string, authTime: number = nowAuthTime()): AuthTokens {
    return issueTokenPair(String(user._id), role, authTime);
  }

  /**
   * Validates an incoming refresh token and issues a FRESH PAIR.
   *
   * ── Why a pair, when the browser only ever uses half of it ────────────────────
   * Refresh tokens here are stateless JWTs with no server-side store, so minting a new one
   * does not invalidate the old one: there is no rotation risk and no grace period to get
   * wrong. What the second half buys is a bearer client whose session slides on ordinary use
   * instead of hard-expiring 30 days after the last password entry — the browser gets that for
   * free from `auth-me`, which already re-issues both at full lifetime on every app launch.
   *
   * The callers that want only the access half — `requireAuth`'s silent refresh and
   * `POST /auth/browser/refresh` — simply do not read `refreshToken`, so cookie behaviour is
   * byte-identical. Deliberately not an options flag: the flag would restore the two code
   * paths this shape exists to collapse, for the price of one discarded `jwt.sign`.
   *
   * ⚠ Consequence worth stating rather than smuggling: the 30-day window becomes sliding with
   * no absolute cap, so a stolen refresh token an attacker keeps refreshing never lapses. A
   * password change is still what revokes it (`isTokenPredatingPasswordChange`, below).
   */
  async rotateRefreshToken(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; user: IUser; role: string }> {
    let payload: { userId: string; role: string; type: string; iat?: number; auth_time?: number };

    try {
      payload = jwt.verify(
        refreshToken,
        getJwtRefreshSecret()
      ) as any;
    } catch (err: any) {
      if (err?.name === 'TokenExpiredError') {
        throw createAppError(ERROR_CODES.AUTH_SESSION_EXPIRED, 401);
      }
      throw createAppError(ERROR_CODES.AUTH_REFRESH_TOKEN_INVALID, 401);
    }

    if (payload.type !== 'refresh') {
      throw createAppError(ERROR_CODES.AUTH_REFRESH_TOKEN_INVALID, 401, 'Invalid token type');
    }

    const user = await this.userRepo.findById(payload.userId);
    if (!user) throw createAppError(ERROR_CODES.AUTH_USER_NOT_FOUND, 401);

    // A closed account, first and with its own code — see `requireAuth` for why the order
    // matters. The 30-day refresh cookie outlives a closure by a month otherwise.
    if (user.status === 'closed') {
      throw createAppError(ERROR_CODES.AUTH_ACCOUNT_CLOSED, 403);
    }

    // A refresh must not outlive a suspension. The refresh cookie lives 30 days, so
    // without this a suspended person keeps minting fresh access tokens from a
    // credential issued before they were suspended — the exact hole that makes
    // "suspended" a label rather than a lock.
    if (user.status !== 'active') {
      throw createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, 'This account is suspended');
    }

    // A refresh must not outlive the password it was issued under, and THIS is the check
    // that makes changing a password a revocation rather than a gesture. Refresh tokens are
    // stateless — there is no store to delete from — so a cookie minted under the old
    // password would go on minting fresh access tokens for the rest of its 30 days, which
    // is exactly the session an attacker keeps when the victim changes their password.
    if (isTokenPredatingPasswordChange(payload.iat, user.password_changed_at)) {
      throw createAppError(ERROR_CODES.AUTH_PASSWORD_CHANGED, 401);
    }

    /**
     * The absolute cap — ADR-A03. This is the EVICTION half: the refresh credential lives
     * 30 days, so refusing here is what stops a capped session minting anything further.
     * `requireAuth` carries the same check for the 15-minute access tail and for the two
     * re-issue routes that sit behind it.
     *
     * Its own code, not `AUTH_SESSION_EXPIRED`: this one is not refreshable, and a client
     * that cannot tell them apart retries forever.
     */
    if (isSessionCapReached(payload)) {
      throw createAppError(ERROR_CODES.AUTH_SESSION_CAP_REACHED, 401);
    }

    /**
     * ⚠ **The third argument is the entire decision.** `auth_time` is COPIED, never
     * refreshed — nobody proved anything to get here, they presented a token. Writing
     * `this.issueTokenPair(user, payload.role)` would take the "now" default, silently
     * restore the uncapped sliding window, and look exactly like working code. No
     * behavioural test can catch that in under 90 days, which is why `test:mobile-auth`
     * asserts this line by SOURCE SCAN.
     *
     * `resolveAuthTime` is what applies D-9's fallback for a token minted before this
     * feature existed: it is capped from its own `iat`, and comes back carrying a real
     * `auth_time`. Non-null by construction — `isSessionCapReached` above returns true for
     * a payload it cannot date, so an undateable token has already been refused.
     */
    /**
     * ⚠ **The role is FILTERED here, and this line is the whole of the cutover's security
     * half** (Phase 5 Part E, step E.1).
     *
     * `AUTHENTICATABLE_ROLES` is the one list behind four schemas, and until this guard
     * existed it covered four of the five paths that mint a token: `register` and `addRole`
     * refuse `'admin'` at parse, `login` and `authMe` refuse it both at parse and through
     * `roles.filter(isAuthenticatableRole)`.
     *
     * **This method was the fifth, and it was open.** It copies the role straight out of the
     * presented token — nothing here re-reads `user.roles` — so a refresh token minted before
     * the cutover went on producing `role: 'admin'` access tokens for the remainder of its
     * 30-day life, and such a token satisfied every `requireRole(['admin'])` site jovi-mall
     * used to serve. The public `/api/admin/*` mounts are gone now, which is why deleting them
     * is hygiene and this is the fix: without it, re-adding any admin-guarded route anywhere
     * silently re-opens the hole.
     *
     * `AUTH_ROLE_NOT_FOUND` at 403 deliberately — it is what `login` and `authMe` answer for
     * the same condition, so a client sees one behaviour for "that role cannot be signed in
     * as". It is NOT `AUTH_SESSION_EXPIRED`: this session is not refreshable and a client that
     * cannot tell the two apart retries forever, which is the reasoning that gave
     * `AUTH_SESSION_CAP_REACHED` a code of its own a few lines above.
     */
    if (!isAuthenticatableRole(payload.role)) {
      throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, undefined, { role: payload.role });
    }

    const authTime = resolveAuthTime(payload)!;
    const tokens = this.issueTokenPair(user, payload.role, authTime);
    return { ...tokens, user, role: payload.role };
  }

  // ─── Auth Flows ─────────────────────────────────────────────────────────────

  async register(input: RegisterInput) {
    const existingPhone = await this.userRepo.findByPhone(input.phone);
    if (existingPhone) throw createAppError(ERROR_CODES.AUTH_PHONE_TAKEN, 409);

    if (input.email) {
      const existingEmail = await this.userRepo.findByEmail(input.email);
      if (existingEmail) throw createAppError(ERROR_CODES.AUTH_EMAIL_TAKEN, 409);
    }

    const role = input.role || 'vendor';

    /**
     * A customer arrives here with NO password — `RegisterSchema` strips it — so
     * one is generated, hashed, and never disclosed to anybody including the
     * person registering. `User.password_hash` stays `required: true` and the
     * reset flow keeps something to replace; what changes is that the resulting
     * hash matches no credential in existence.
     *
     * ⚠ The `??` is not a convenience default. Every other role is REFUSED by the
     * schema without a password, so this branch is reachable only for a customer
     * — and if that refinement is ever loosened, this line silently becomes
     * "quietly generate a password for a vendor who forgot to send one", which
     * would lock them out of an account they believe they set up. The two must
     * be changed together.
     */
    const password = input.password ?? generateSystemPassword();
    const passwordHash = await bcrypt.hash(password, 10);

    const user = await this.userRepo.create({
      login_phone: input.phone,
      login_email: input.email,
      password_hash: passwordHash,
      roles: [role],
      status: 'active'
    });

    let roleEntity;
    switch (role) {
      case 'customer':
        roleEntity = await this.customerRepo.create({
          user_id: user._id, name: input.name, email: input.email, phone: input.phone,
          email_verified: false, phone_verified: false
        });
        break;
      case 'vendor':
        roleEntity = await this.vendorRepo.create({
          user_id: user._id, display_name: input.name,
          email: input.email, phone: input.phone, email_verified: false, phone_verified: false
        });
        // The business name lives on the Store (source of truth) — provision it now.
        await this.storeProvisioning.ensureStoreForVendor(roleEntity._id.toString(), input.business_name || input.name);
        break;
      case 'agency':
        roleEntity = await this.agencyRepo.create({
          user_id: user._id, display_name: input.name,
          email: input.email, phone: input.phone, email_verified: false, phone_verified: false, legit_verified: false
        });
        // The business name lives on the Magazin (source of truth) — provision it now.
        await this.magazinProvisioning.ensureMagazinForAgency(roleEntity._id.toString(), input.agency_name || input.name);
        break;
      case 'agent':
        roleEntity = await this.agentRepo.create({
          user_id: user._id, name: input.name, email: input.email, phone: input.phone,
          email_verified: false, phone_verified: false,
        });
        break;
      // No 'admin' case, deliberately — it falls through to `default` and is
      // rejected. Administrators are provisioned by the admin service's bootstrap
      // CLI against the `wi-admin` database; this service must never mint one.
      default:
        throw createAppError(ERROR_CODES.AUTH_UNSUPPORTED_ROLE, 400, undefined, { role });
    }

    // FRESH `auth_time` (the default) — registration is where the password is set, so this
    // is a credential-proving event and the 90-day clock starts here. ADR-A03 / D-8.
    const tokens = this.issueTokenPair(user, role);
    return { user, role, role_entity: roleEntity, ...tokens };
  }

  async login(input: LoginInput) {
    let user: IUser | null;
    const isEmail = input.identifier.includes('@');

    if (isEmail) {
      user = await this.userRepo.findByEmail(input.identifier);
    } else {
      user = await this.userRepo.findByPhone(input.identifier);
    }

    if (!user) throw createAppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401);

    /**
     * ⚠ **THE CREDENTIAL CHECK. Do not comment this out again.**
     *
     * With the throw removed, `bcrypt.compare` still runs and its verdict is DISCARDED: any
     * password authenticates any account, for every role. Not a theory — on 2026-08-21 a real
     * customer account was signed into with the string
     * `"this-is-definitely-not-the-password-xyz123"` and answered `200` with a full session.
     *
     * **This comment has been wrong once, and that is the part worth remembering.** It
     * previously read *"It is restored, and deliberately with no environment escape hatch"* —
     * while the line below it was still commented out. So the file asserted its own safety in
     * prose, next to the code that contradicted it, and the prose is what people read. Three
     * assertions across two suites were failing the whole time and had been written off as an
     * expected baseline.
     *
     * Restored for real 2026-08-21, by the owner's decision, and still with **no environment
     * escape hatch** — a bypass whose failure direction is "open on a typo" is the exact shape
     * `config/env.ts` exists to argue against. A seed or fixture that relied on the hole needs
     * a real password, not a flag; `scripts/seed/` already sets documented ones.
     *
     * Pinned by SOURCE SCAN in `test:mobile-auth` (`the verdict is acted on, not discarded`)
     * and behaviourally by `verify:messaging-login`, which resets a password and then proves
     * the OLD one stops working — the assertion that failed for a year of commits.
     */
    const isValid = await bcrypt.compare(input.password, user.password_hash);
    if (!isValid) throw createAppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401);

    // A closed account, first and with its own code. Unreachable in practice — closure
    // clears `login_email` and `login_phone`, so the lookup above cannot find the row — and
    // kept because "unreachable" here rests on another file's behaviour, not on this one's.
    if (user.status === 'closed') {
      throw createAppError(ERROR_CODES.AUTH_ACCOUNT_CLOSED, 403);
    }

    // Ordered AFTER the credential comparison on purpose: naming the suspension is only
    // safe for a caller who has already proved they hold the account, otherwise the
    // login form becomes an oracle for which accounts exist and which are suspended.
    if (user.status !== 'active') {
      throw createAppError(ERROR_CODES.AUTH_ACCOUNT_SUSPENDED, 403, 'This account is suspended');
    }

    let role = input.role;
    if (!role) {
      /**
       * Filtered, not indexed. `roles` is typed by the Mongoose model, which still
       * permits 'admin' on a legacy row — so `user.roles[0]` on an account holding it
       * would resolve a role the schema above deliberately refuses to accept, and
       * issue a token for it without the request ever having named it. The body's
       * `role` is checked against `roles` below and cannot reach it either way.
       */
      const selectable = user.roles.filter(isAuthenticatableRole);
      if (selectable.length === 1) {
        role = selectable[0];
      } else {
        throw createAppError(ERROR_CODES.AUTH_ROLE_REQUIRED, 400);
      }
    } else {
      if (!user.roles.includes(role)) {
        throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, undefined, { role });
      }
    }

    // No 'admin' branch, deliberately — see the note in register(). It resolved an
    // `admins` role entity for a role that can no longer be authenticated as.
    let entity = null;
    if (role === 'customer') entity = await this.customerRepo.findByUserId(user.id);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(user.id);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(user.id);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(user.id);

    /**
     * A suspended vendor is refused at the door as well as on every later request.
     *
     * `requireAuth` is what actually enforces the suspension — this is the courtesy that
     * stops us handing out a token pair that fails on its first use, which reads to the
     * client as a broken login rather than a closed shop.
     *
     * `=== 'inactive'` only, and only for the vendor role. See the long note in
     * `api/middlewares/auth.middleware.ts` for why the negated form would be a mass
     * lockout of every vendor who never verified their email.
     */
    if (role === 'vendor' && (entity as { status?: string } | null)?.status === 'inactive') {
      throw createAppError(
        ERROR_CODES.AUTH_VENDOR_SUSPENDED,
        403,
        'This vendor account is suspended'
      );
    }

    // FRESH `auth_time` (the default) — `bcrypt.compare` ran above, so this is THE
    // credential-proving event and the 90-day clock starts here. ADR-A03 / D-8.
    const tokens = this.issueTokenPair(user, role);
    return { user, role, role_entity: entity, ...tokens };
  }

  /**
   * Re-issue the caller's own pair, resolving (or switching) their role.
   *
   * ⚠ **`authTime` is REQUIRED and is COPIED, and this is a correction to plan step
   * 4.A.5.2 rather than a detail.** That step lists this site among the "credential-proving"
   * ones that stamp fresh. It proves no credential: it sits behind `requireAuth`, so its
   * caller presented a token, exactly like the rotation does — and ADR-A03's own Context
   * paragraph names *this* method as a cause of the uncapped window ("every client calls
   * `auth-me` on launch and is re-issued both tokens at full lifetime").
   *
   * Stamping fresh here would therefore not implement the cap; it would make it unreachable.
   * Every client calls this on launch, so `auth_time` would be reset every few days for the
   * life of the account and `now − auth_time` would never approach 90 days. Required rather
   * than defaulted so a caller cannot omit it and quietly get "now".
   */
  async authMe(input: AuthMeInput, authTime: number) {
    const user = await this.userRepo.findById(input.userId);
    if (!user) throw createAppError(ERROR_CODES.AUTH_ACCOUNT_NOT_FOUND, 401);

    let role = input.role;
    if (!role) {
      // Filtered rather than indexed, for the reason given in login().
      const selectable = user.roles.filter(isAuthenticatableRole);
      if (selectable.length === 1) {
        role = selectable[0];
      } else {
        throw createAppError(ERROR_CODES.AUTH_ROLE_REQUIRED, 400);
      }
    } else {
      if (!user.roles.includes(role)) {
        throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, undefined, { role });
      }
    }

    // No 'admin' branch — see login().
    let entity = null;
    if (role === 'customer') entity = await this.customerRepo.findByUserId(user.id);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(user.id);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(user.id);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(user.id);

    // COPIED — see the note on this method. Switching role does not re-prove a credential.
    const tokens = this.issueTokenPair(user, role, authTime);
    return { user, role, role_entity: entity, ...tokens };
  }

  /**
   * ⚠ **`authTime` is REQUIRED and is COPIED**, for the same reason as `authMe` and with the
   * same correction to plan step 4.A.5.2. This route sits behind `requireAuth` and adds a
   * role to an existing account: the caller presented a token, not a credential. Stamping
   * fresh would hand any signed-in client a way to reset its own session clock on demand.
   */
  async addRole(userId: string, input: AddRoleInput, authTime: number) {
    const user = await this.userRepo.findById(userId);
    if (!user) throw createAppError(ERROR_CODES.AUTH_ACCOUNT_NOT_FOUND, 404);

    const role = input.role;

    if (user.roles.includes(role as any)) {
      throw createAppError(ERROR_CODES.AUTH_ROLE_ALREADY_EXISTS, 409, undefined, { role });
    }

    let roleEntity;
    switch (role) {
      case 'customer':
        roleEntity = await this.customerRepo.create({
          user_id: user._id, name: input.name || '', email: user.login_email, phone: user.login_phone,
          email_verified: false, phone_verified: false,
        });
        break;
      case 'vendor':
        roleEntity = await this.vendorRepo.create({
          user_id: user._id, display_name: input.name || undefined,
          email: user.login_email, phone: user.login_phone,
          email_verified: false, phone_verified: false,
        });
        // The business name lives on the Store (source of truth) — provision it now.
        await this.storeProvisioning.ensureStoreForVendor(
          roleEntity._id.toString(),
          input.business_name || input.name || undefined,
        );
        break;
      case 'agency':
        roleEntity = await this.agencyRepo.create({
          user_id: user._id, display_name: input.name || undefined,
          email: user.login_email, phone: user.login_phone,
          email_verified: false, phone_verified: false, legit_verified: false,
        });
        // The business name lives on the Magazin (source of truth) — provision it now.
        await this.magazinProvisioning.ensureMagazinForAgency(
          roleEntity._id.toString(),
          input.agency_name || input.name || undefined,
        );
        break;
      case 'agent':
        roleEntity = await this.agentRepo.create({
          user_id: user._id, name: input.name || '', email: user.login_email, phone: user.login_phone,
          email_verified: false, phone_verified: false,
        });
        break;
      // No 'admin' case — see the note in register(). An existing user must never
      // be able to acquire the admin role.
      default:
        throw createAppError(ERROR_CODES.AUTH_UNSUPPORTED_ROLE, 400, undefined, { role });
    }

    await this.userRepo.addRoleToUser(userId, role);

    // COPIED — see the note on this method.
    const tokens = this.issueTokenPair(user, role, authTime);
    return { user, role, role_entity: roleEntity, ...tokens };
  }

  // ─── Email / Phone Verification ─────────────────────────────────────────────

  async sendEmailVerification(userId: string, role: string) {
    // let email: string;
    let entity: any = null;

    if (role === 'customer') entity = await this.customerRepo.findByUserId(userId);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(userId);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(userId);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(userId);

    if (!entity) throw createAppError(ERROR_CODES.AUTH_PROFILE_NOT_FOUND, 404, undefined, { role });
    if (entity.email_verified) throw createAppError(ERROR_CODES.AUTH_EMAIL_ALREADY_VERIFIED, 409);
    if (!entity.email) throw createAppError(ERROR_CODES.AUTH_EMAIL_MISSING, 422);

    const email = entity.email;

    const token = crypto.randomBytes(32).toString('hex');
    const redis = await getRedisClient(this.redisDb);

    const value = JSON.stringify({ userId, role });
    await redis.set(`email_verify:${token}`, value, { EX: EMAIL_VERIFY_EXPIRE });

    /**
     * ⚠ **The link points at the STOREFRONT PAGE, not at this API.**
     *
     * It used to be `${API_PUBLIC_URL}/api/auth/verify-email?token=…`, so no frontend was
     * ever involved, and that had three live consequences: a person who clicked it got a
     * **raw JSON envelope** in their browser — no page, no branding, no way onward, for
     * customers, vendors, agencies and agents alike; it was a **`GET` that mutates**, so
     * the token was spent by whatever prefetched the mail (link scanners, corporate
     * relays, the mail client's own preview) before the person ever tapped it; and the
     * landing app's `/verify-email` page had nothing pointing at it.
     *
     * `PasswordResetService.buildResetLink` and `buildEmailChangeLink` each argue the
     * prefetch case at length; registration verification simply never got the same
     * treatment. The page POSTs to `POST /api/auth/verify-email`, and the `GET` still
     * answers for links already in inboxes — these tokens live 24 hours, so one minted the
     * minute before a deploy stays valid for a day after it.
     *
     * `role` travels as `app=` for the same reason it does on the email-change link: one
     * page serves four audiences, and only the half of the flow holding a session knows
     * which one asked. It is a **role key, never a URL** — the page maps it through a
     * compile-time table and ignores anything else.
     *
     * The `API_PUBLIC_URL` fallback keeps a local box working with no `STOREFRONT_URL`
     * set — the same precedence `confirmLinkBase()` and `buildResetLink` use.
     */
    const verifyBase = (process.env.STOREFRONT_URL || API_PUBLIC_URL).replace(/\/+$/, '');
    const verifyLink = `${verifyBase}/verify-email?token=${token}&app=${encodeURIComponent(role)}`;

    await this.mailService.send({
      to: email,
      type: 'AUTH',
      subject: 'Verify your email address',
      template: 'verify-email',
      variables: {
        link: verifyLink,
        year: new Date().getFullYear(),
      },
    });

    return { message: 'Verification email sent' };
  }

  async verifyEmail(token: string) {
    const redis = await getRedisClient(this.redisDb);
    const key = `email_verify:${token}`;
    const value = await redis.get(key);

    if (!value) {
      throw createAppError(ERROR_CODES.AUTH_VERIFY_TOKEN_INVALID, 400);
    }

    const { userId, role } = JSON.parse(value);
    await redis.del(key);

    const repos: any = {
      'customer': this.customerRepo,
      'vendor': this.vendorRepo,
      'agency': this.agencyRepo,
      'agent': this.agentRepo
    };

    const repo = repos[role];
    if (repo && typeof repo.markEmailVerified === 'function') {
      await repo.markEmailVerified(userId);
    }

    return { message: 'Email verified successfully' };
  }

  /**
   * `issueWaVerificationCode` lived here and is GONE.
   *
   * It minted a 16-hex code into Redis DB 4 (as a raw literal, not the
   * constant), keyed on the caller's *role entity*, and told the user to send
   * `/link:CODE` to the bot. Three things were wrong with that shape and all
   * three are fixed by inverting the direction rather than by patching it:
   *
   *  - the platform put an account-scoped secret into a message a user pastes
   *    into a chat window, and the bot side then reported which identity had
   *    presented it — over an unauthenticated webhook;
   *  - it bound to one role, so the same person had to repeat it per dashboard
   *    unless they passed `update_other_roles`, a flag that fanned four
   *    best-effort writes across four collections;
   *  - `409 AUTH_WA_ALREADY_VERIFIED` meant changing your number required
   *    finding the unlink endpoint first.
   *
   * The replacement is `modules/connections/`: the bot mints against the sender
   * it can actually observe, and `POST /api/me/connections` binds it to whoever
   * is authenticated.
   */
}
