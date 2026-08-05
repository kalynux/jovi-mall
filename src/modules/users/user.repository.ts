import { UserModel, IUser } from './user.model';
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

  async updateStatus(userId: string, status: string): Promise<IUser | null> {
    return await UserModel.findByIdAndUpdate(userId, { status }, { new: true });
  }

  /**
   * Update user password
   * 
   * @param userId - User ID
   * @param passwordHash - New bcrypt hashed password
   */
  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await UserModel.findByIdAndUpdate(userId, { password_hash: passwordHash });
  }

  async addRoleToUser(userId: string, role: string): Promise<IUser | null> {
    return await UserModel.findByIdAndUpdate(
      userId,
      { $addToSet: { roles: role } },
      { new: true }
    );
  }
}
