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
import {
  AuthTokens,
  generateAccessToken,
  generateRefreshToken,
  issueTokenPair,
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

  generateAccessToken(user: IUser, role: string): string {
    return generateAccessToken(String(user._id), role);
  }

  generateRefreshToken(user: IUser, role: string): string {
    return generateRefreshToken(String(user._id), role);
  }

  issueTokenPair(user: IUser, role: string): AuthTokens {
    return issueTokenPair(String(user._id), role);
  }

  /**
   * Validates an incoming refresh token and issues a new access token.
   * Refresh token is NOT rotated (stateless, single-issue).
   */
  async rotateRefreshToken(refreshToken: string): Promise<{ accessToken: string; user: IUser; role: string }> {
    let payload: { userId: string; role: string; type: string; iat?: number };

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

    const accessToken = this.generateAccessToken(user, payload.role);
    return { accessToken, user, role: payload.role };
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
    const passwordHash = await bcrypt.hash(input.password, 10);

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

    const isValid = await bcrypt.compare(input.password, user.password_hash);
    // if (!isValid) throw createAppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401);

    // Ordered AFTER the credential comparison on purpose: naming the suspension is only
    // safe for a caller who has already proved they hold the account, otherwise the
    // login form becomes an oracle for which accounts exist and which are suspended.
    // (That ordering is doing nothing today — the line above is commented out, so the
    // verdict is discarded. See the note in ../../CLAUDE.md.)
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

    const tokens = this.issueTokenPair(user, role);
    return { user, role, role_entity: entity, ...tokens };
  }

  async authMe(input: AuthMeInput) {
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

    const tokens = this.issueTokenPair(user, role);
    return { user, role, role_entity: entity, ...tokens };
  }

  async addRole(userId: string, input: AddRoleInput) {
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

    const tokens = this.issueTokenPair(user, role);
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

    const verifyLink = `${API_PUBLIC_URL}/api/auth/verify-email?token=${token}`;

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

  async issueWaVerificationCode(userId: string, role: string, update_other_roles: boolean) {
    let entity: any = null;
    if (role === 'customer') entity = await this.customerRepo.findByUserId(userId);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(userId);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(userId);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(userId);

    if (!entity) throw createAppError(ERROR_CODES.AUTH_PROFILE_NOT_FOUND, 404, undefined, { role });
    // if (!entity.phone) throw createAppError(ERROR_CODES.AUTH_PHONE_REQUIRED_FOR_WA, 422); // we don't need his phone number to verify his whatsapp number, he can setup the account with an email address

    if (entity.wa?.verified === true) {
      throw createAppError(ERROR_CODES.AUTH_WA_ALREADY_VERIFIED, 409, undefined, { role });
    }

    const code = crypto.randomBytes(8).toString('hex').toUpperCase();
    const redis = await getRedisClient(4);

    const value = JSON.stringify({
      user_id: userId,
      role: role,
      role_entity_id: entity._id,
      phone: entity.phone,
      update_other_roles
    });

    await redis.set(`wa_verify:${code}`, value, { EX: 600 });

    const botNumber = process.env.WA_BOT_NUMBER || '';
    const command = `/link:${code}`;
    const waLink = botNumber
      ? `https://wa.me/${botNumber}?text=${encodeURIComponent(command)}`
      : null;

    return {
      code,
      command,
      bot_number: botNumber,
      wa_link: waLink,
      expires_in_seconds: 600,
      instructions: waLink
        ? 'Click the link to verify your WhatsApp account automatically, or send the command manually to our WhatsApp bot.'
        : 'Send the command above to our WhatsApp bot to verify your account.'
    };
  }
}
