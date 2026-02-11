import { UserModel, IUser } from './user.model';

export class UserRepository {
  async create(userData: Partial<IUser>): Promise<IUser> {
    const user = new UserModel(userData);
    return await user.save();
  }

  async findByPhone(phone: string): Promise<IUser | null> {
    return await UserModel.findOne({ login_phone: phone });
  }

  async findByEmail(email: string): Promise<IUser | null> {
    return await UserModel.findOne({ login_email: email });
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
}
