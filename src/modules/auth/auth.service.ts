import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { UserRepository } from '../users/user.repository';
import { CustomerRepository } from '../customers/customer.repository';
import { VendorRepository } from '../vendors/vendor.repository';
import { DeliveryAgencyRepository } from '../delivery/delivery-agency.repository';
import { DeliveryAgentRepository } from '../delivery/delivery-agent.repository';
import { AdminRepository } from '../admins/admin.repository';
import { AddRoleInput, AuthMeInput, LoginInput, RegisterInput } from './auth.schemas';
import { IUser } from '../users/user.model';
import { EMAIL_VERIFY_DB, getRedisClient } from '../../infra/redis/redis.factory';
import { MailService } from '../mail/mail.service';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

const EMAIL_VERIFY_EXPIRE = 86400; // 24 hours

// ─── Token TTLs (in seconds) ─────────────────────────────────────────────────
const ACCESS_TOKEN_TTL_S = parseInt(process.env.AUTH_ACCESS_TOKEN_TTL || '900');     // 15 min
const REFRESH_TOKEN_TTL_S = parseInt(process.env.AUTH_REFRESH_TOKEN_TTL || '2592000'); // 30 days

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  private userRepo: UserRepository;
  private customerRepo: CustomerRepository;
  private vendorRepo: VendorRepository;
  private agencyRepo: DeliveryAgencyRepository;
  private agentRepo: DeliveryAgentRepository;
  private adminRepo: AdminRepository;
  private mailService: MailService;
  private redisDb = EMAIL_VERIFY_DB;

  constructor() {
    this.userRepo = new UserRepository();
    this.customerRepo = new CustomerRepository();
    this.vendorRepo = new VendorRepository();
    this.agencyRepo = new DeliveryAgencyRepository();
    this.agentRepo = new DeliveryAgentRepository();
    this.adminRepo = new AdminRepository();
    this.mailService = new MailService();
  }

  // ─── Token Generation ───────────────────────────────────────────────────────

  generateAccessToken(user: IUser, role: string): string {
    return jwt.sign(
      { userId: user._id, role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: ACCESS_TOKEN_TTL_S }
    );
  }

  generateRefreshToken(user: IUser, role: string): string {
    return jwt.sign(
      { userId: user._id, role, type: 'refresh' },
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'secret',
      { expiresIn: REFRESH_TOKEN_TTL_S }
    );
  }

  issueTokenPair(user: IUser, role: string): AuthTokens {
    return {
      accessToken: this.generateAccessToken(user, role),
      refreshToken: this.generateRefreshToken(user, role),
    };
  }

  /**
   * Validates an incoming refresh token and issues a new access token.
   * Refresh token is NOT rotated (stateless, single-issue).
   */
  async rotateRefreshToken(refreshToken: string): Promise<{ accessToken: string; user: IUser; role: string }> {
    let payload: { userId: string; role: string; type: string };

    try {
      payload = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET || 'secret'
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
          user_id: user._id, business_name: input.business_name || input.name,
          email: input.email, phone: input.phone, email_verified: false, phone_verified: false, legit_verified: false
        });
        break;
      case 'agency':
        roleEntity = await this.agencyRepo.create({
          user_id: user._id, agency_name: input.agency_name || input.name,
          email: input.email, phone: input.phone, email_verified: false, phone_verified: false, legit_verified: false
        });
        break;
      case 'agent':
        roleEntity = await this.agentRepo.create({
          user_id: user._id, name: input.name, email: input.email, phone: input.phone,
          email_verified: false, phone_verified: false,
        });
        break;
      case 'admin':
        roleEntity = await this.adminRepo.create({
          user_id: user._id, name: input.name, email: input.email
        });
        break;
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
    if (!isValid) throw createAppError(ERROR_CODES.AUTH_INVALID_CREDENTIALS, 401);

    let role = input.role;
    if (!role) {
      if (user.roles.length === 1) {
        role = user.roles[0];
      } else {
        throw createAppError(ERROR_CODES.AUTH_ROLE_REQUIRED, 400);
      }
    } else {
      if (!user.roles.includes(role as any)) {
        throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, undefined, { role });
      }
    }

    let entity = null;
    if (role === 'customer') entity = await this.customerRepo.findByUserId(user.id);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(user.id);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(user.id);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(user.id);
    else if (role === 'admin') entity = await this.adminRepo.findByUserId(user.id);

    const tokens = this.issueTokenPair(user, role);
    return { user, role, role_entity: entity, ...tokens };
  }

  async authMe(input: AuthMeInput) {
    const user = await this.userRepo.findById(input.userId);
    if (!user) throw createAppError(ERROR_CODES.AUTH_ACCOUNT_NOT_FOUND, 401);

    let role = input.role;
    if (!role) {
      if (user.roles.length === 1) {
        role = user.roles[0];
      } else {
        throw createAppError(ERROR_CODES.AUTH_ROLE_REQUIRED, 400);
      }
    } else {
      if (!user.roles.includes(role as any)) {
        throw createAppError(ERROR_CODES.AUTH_ROLE_NOT_FOUND, 403, undefined, { role });
      }
    }

    let entity = null;
    if (role === 'customer') entity = await this.customerRepo.findByUserId(user.id);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(user.id);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(user.id);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(user.id);
    else if (role === 'admin') entity = await this.adminRepo.findByUserId(user.id);

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
          user_id: user._id, business_name: input.business_name || input.name || '',
          email: user.login_email, phone: user.login_phone,
          email_verified: false, phone_verified: false, legit_verified: false,
        });
        break;
      case 'agency':
        roleEntity = await this.agencyRepo.create({
          user_id: user._id, agency_name: input.agency_name || input.name || '',
          email: user.login_email, phone: user.login_phone,
          email_verified: false, phone_verified: false, legit_verified: false,
        });
        break;
      case 'agent':
        roleEntity = await this.agentRepo.create({
          user_id: user._id, name: input.name || '', email: user.login_email, phone: user.login_phone,
          email_verified: false, phone_verified: false,
        });
        break;
      case 'admin':
        roleEntity = await this.adminRepo.create({
          user_id: user._id, name: input.name || '', email: user.login_email,
        });
        break;
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
    else if (role === 'admin') entity = await this.adminRepo.findByUserId(userId);

    if (!entity) throw createAppError(ERROR_CODES.AUTH_PROFILE_NOT_FOUND, 404, undefined, { role });
    if (entity.email_verified) throw createAppError(ERROR_CODES.AUTH_EMAIL_ALREADY_VERIFIED, 409);
    if (!entity.email) throw createAppError(ERROR_CODES.AUTH_EMAIL_MISSING, 422);

    const email = entity.email;

    const token = crypto.randomBytes(32).toString('hex');
    const redis = await getRedisClient(this.redisDb);

    const value = JSON.stringify({ userId, role });
    await redis.set(`email_verify:${token}`, value, { EX: EMAIL_VERIFY_EXPIRE });

    const verifyLink = `http://localhost:${process.env.PORT || 3000}/api/auth/verify-email?token=${token}`;

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
    else if (role === 'admin') entity = await this.adminRepo.findByUserId(userId);

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
