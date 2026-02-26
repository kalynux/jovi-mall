import { AdminModel, IAdmin } from './admin.model';

export class AdminRepository {
  async create(data: Partial<IAdmin>): Promise<IAdmin> {
    return await AdminModel.create(data);
  }

  async findByUserId(userId: string): Promise<IAdmin | null> {
    return await AdminModel.findOne({ user_id: userId });
  }

  async findById(adminId: string): Promise<IAdmin | null> {
    return await AdminModel.findById(adminId);
  }

  async updateProfile(adminId: string, updates: Partial<IAdmin>): Promise<IAdmin | null> {
    return await AdminModel.findByIdAndUpdate(adminId, updates, { new: true });
  }

  /** Called by auth middleware after successful login. */
  async recordLogin(adminId: string, ipAddress: string): Promise<void> {
    await AdminModel.findByIdAndUpdate(adminId, {
      $set: { last_login_ip: ipAddress },
    });
  }
}
