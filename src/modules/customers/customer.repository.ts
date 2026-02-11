import { CustomerModel, ICustomer } from './customer.model';

export class CustomerRepository {
  async create(data: Partial<ICustomer>): Promise<ICustomer> {
    return await CustomerModel.create(data);
  }

  async findByUserId(userId: string): Promise<ICustomer | null> {
    return await CustomerModel.findOne({ user_id: userId });
  }

  async markEmailVerified(userId: string): Promise<ICustomer | null> {
    return await CustomerModel.findOneAndUpdate(
      { user_id: userId },
      { email_verified: true },
      { new: true }
    );
  }
  async updateWaVerified(userId: string, waData: { wa_phone_id: string; name?: string }): Promise<ICustomer | null> {
    return await CustomerModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': true,
          'wa.wa_phone_id': waData.wa_phone_id,
          'wa.bound_at': new Date(),
          'wa.last_seen_at': new Date(),
          ...(waData.name ? { 'wa.name': waData.name } : {})
        }
      },
      { new: true }
    );
  }

  async updateStatus(userId: string, status: string): Promise<ICustomer | null> {
    return await CustomerModel.findOneAndUpdate({ user_id: userId }, { status }, { new: true });
  }

  async unlinkWhatsApp(userId: string): Promise<ICustomer | null> {
    return await CustomerModel.findOneAndUpdate(
      { user_id: userId },
      {
        $set: {
          'wa.verified': false,
          'wa.wa_phone_id': null,
          'wa.name': null,
          'wa.bound_at': null,
          'wa.last_seen_at': null
        }
      },
      { new: true }
    );
  }
}
