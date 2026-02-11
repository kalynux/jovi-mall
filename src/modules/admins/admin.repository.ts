import { AdminModel, IAdmin } from './admin.model';

export class AdminRepository {
  async create(data: Partial<IAdmin>): Promise<IAdmin> {
    return await AdminModel.create(data);
  }

  async findByUserId(userId: string): Promise<IAdmin | null> {
    return await AdminModel.findOne({ user_id: userId });
  }
}
