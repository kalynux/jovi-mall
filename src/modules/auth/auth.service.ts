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
    } catch {
      throw new Error('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    const user = await this.userRepo.findById(payload.userId);
    if (!user) throw new Error('User not found');

    const accessToken = this.generateAccessToken(user, payload.role);
    return { accessToken, user, role: payload.role };
  }

  // ─── Auth Flows ─────────────────────────────────────────────────────────────

  async register(input: RegisterInput) {
    // Check duplication (login identifiers)
    const existingPhone = await this.userRepo.findByPhone(input.phone);
    if (existingPhone) throw new Error('User with this phone already exists');

    if (input.email) {
      const existingEmail = await this.userRepo.findByEmail(input.email);
      if (existingEmail) throw new Error('User with this email already exists');
    }

    // Role handling
    const role = input.role || 'vendor';

    // Hash Password
    const passwordHash = await bcrypt.hash(input.password, 10);

    // Create User (Auth)
    const user = await this.userRepo.create({
      login_phone: input.phone,
      login_email: input.email,
      password_hash: passwordHash,
      roles: [role],
      status: 'active'
    });

    // Create Role Entity
    let roleEntity;
    switch (role) {
      case 'customer':
        roleEntity = await this.customerRepo.create({
          user_id: user._id,
          name: input.name,
          email: input.email,
          phone: input.phone,
          email_verified: false,
          phone_verified: false
        });
        break;
      case 'vendor':
        roleEntity = await this.vendorRepo.create({
          user_id: user._id,
          name: input.name,
          business_name: input.business_name || input.name,
          email: input.email,
          phone: input.phone,
          email_verified: false,
          phone_verified: false,
          legit_verified: false
        });
        break;
      case 'agency':
        roleEntity = await this.agencyRepo.create({
          user_id: user._id,
          name: input.name,
          agency_name: input.agency_name || input.name,
          email: input.email,
          phone: input.phone,
          email_verified: false,
          phone_verified: false,
          legit_verified: false
        });
        break;
      case 'agent':
        roleEntity = await this.agentRepo.create({
          user_id: user._id,
          name: input.name,
          email: input.email,
          phone: input.phone,
          email_verified: false,
          phone_verified: false,
        });
        break;
      case 'admin':
        roleEntity = await this.adminRepo.create({
          user_id: user._id,
          name: input.name,
          email: input.email
        });
        break;
      default:
        throw new Error(`Registration for role ${role} not fully supported yet`);
    }

    const tokens = this.issueTokenPair(user, role);
    return { user, role, role_entity: roleEntity, ...tokens };
  }

  async login(input: LoginInput) {
    let user: IUser | null = null;
    const isEmail = input.identifier.includes('@');

    if (isEmail) {
      user = await this.userRepo.findByEmail(input.identifier);
    } else {
      user = await this.userRepo.findByPhone(input.identifier);
    }

    if (!user) throw new Error('Invalid credentials');

    const isValid = await bcrypt.compare(input.password, user.password_hash);
    if (!isValid) throw new Error('Invalid credentials');

    // Role Selection
    let role = input.role;
    if (!role) {
      if (user.roles.length === 1) {
        role = user.roles[0];
      } else {
        throw new Error('Role selection required');
      }
    } else {
      if (!user.roles.includes(role as any)) {
        throw new Error('User does not have this role');
      }
    }

    // Load Role Entity
    let entity = null;
    if (role === 'customer') entity = await this.customerRepo.findByUserId(user.id);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(user.id);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(user.id);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(user.id);
    else if (role === 'admin') entity = await this.adminRepo.findByUserId(user.id);

    const tokens = this.issueTokenPair(user, role);
    // console.log(JSON.stringify({ user, role, role_entity: entity, ...tokens }, null, 2))
    return { user, role, role_entity: entity, ...tokens };
  }

  async authMe(input: AuthMeInput) {
    const user = await this.userRepo.findById(input.userId);
    if (!user) throw new Error('Account not found');

    let role = input.role;
    if (!role) {
      if (user.roles.length === 1) {
        role = user.roles[0];
      } else {
        throw new Error('Role selection required');
      }
    } else {
      if (!user.roles.includes(role as any)) {
        throw new Error('User does not have this role');
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
    if (!user) throw new Error('Account not found');

    const role = input.role;

    if (user.roles.includes(role as any)) {
      throw new Error(`User already has the '${role}' role`);
    }

    let roleEntity;
    switch (role) {
      case 'customer':
        roleEntity = await this.customerRepo.create({
          user_id: user._id,
          name: input.name || '',
          email: user.login_email,
          phone: user.login_phone,
          email_verified: false,
          phone_verified: false,
        });
        break;
      case 'vendor':
        roleEntity = await this.vendorRepo.create({
          user_id: user._id,
          business_name: input.business_name || input.name || '',
          email: user.login_email,
          phone: user.login_phone,
          email_verified: false,
          phone_verified: false,
          legit_verified: false,
        });
        break;
      case 'agency':
        roleEntity = await this.agencyRepo.create({
          user_id: user._id,
          agency_name: input.agency_name || input.name || '',
          email: user.login_email,
          phone: user.login_phone,
          email_verified: false,
          phone_verified: false,
          legit_verified: false,
        });
        break;
      case 'agent':
        roleEntity = await this.agentRepo.create({
          user_id: user._id,
          name: input.name || '',
          email: user.login_email,
          phone: user.login_phone,
          email_verified: false,
          phone_verified: false,
        });
        break;
      case 'admin':
        roleEntity = await this.adminRepo.create({
          user_id: user._id,
          name: input.name || '',
          email: user.login_email,
        });
        break;
      default:
        throw new Error(`Role '${role}' is not supported`);
    }

    await this.userRepo.addRoleToUser(userId, role);

    const tokens = this.issueTokenPair(user, role);
    return { user, role, role_entity: roleEntity, ...tokens };
  }

  // ─── Email / Phone Verification ─────────────────────────────────────────────

  async sendEmailVerification(userId: string, role: string) {
    let email = '';
    let entity: any = null;

    if (role === 'customer') entity = await this.customerRepo.findByUserId(userId);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(userId);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(userId);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(userId);
    else if (role === 'admin') entity = await this.adminRepo.findByUserId(userId);

    if (!entity) throw new Error(`${role} profile not found`);
    if (entity.email_verified) throw new Error('Email already verified');
    if (!entity.email) throw new Error('No email to verify');

    email = entity.email;

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
      throw new Error('Invalid or expired verification token');
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

  async issueWaVerificationCode(userId: string, role: string, waPhoneId: string) {
    let entity: any = null;
    if (role === 'customer') entity = await this.customerRepo.findByUserId(userId);
    else if (role === 'vendor') entity = await this.vendorRepo.findByUserId(userId);
    else if (role === 'agency') entity = await this.agencyRepo.findByUserId(userId);
    else if (role === 'agent') entity = await this.agentRepo.findByUserId(userId);
    else if (role === 'admin') entity = await this.adminRepo.findByUserId(userId);

    if (!entity) throw new Error(`${role} profile not found`);
    if (!entity.phone) throw new Error('Entity must have a phone number to bind WhatsApp');

    if (entity.wa?.verified === true) {
      throw new Error('WhatsApp already verified for this role');
    }

    const code = crypto.randomBytes(6).toString('hex').toUpperCase();
    const redis = await getRedisClient(4);

    const value = JSON.stringify({
      user_id: userId,
      role: role,
      role_entity_id: entity._id,
      phone: entity.phone,
      wa_phone_id: waPhoneId
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
      wa_link: waLink,
      expires_in_seconds: 600,
      instructions: waLink
        ? 'Click the wa_link to verify your WhatsApp account automatically, or send the command manually to our WhatsApp bot.'
        : 'Send the command above to our WhatsApp bot to verify your account.'
    };
  }
}
