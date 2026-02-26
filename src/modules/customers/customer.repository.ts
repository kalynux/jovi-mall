import { CustomerModel, ICustomer } from './customer.model';

export class CustomerRepository {
  async create(data: Partial<ICustomer>): Promise<ICustomer> {
    return await CustomerModel.create(data);
  }

  async findByUserId(userId: string): Promise<ICustomer | null> {
    return await CustomerModel.findOne({ user_id: userId });
  }

  async findById(customerId: string): Promise<ICustomer | null> {
    return await CustomerModel.findById(customerId);
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

  /** General-purpose profile update. */
  async updateProfile(customerId: string, updates: Partial<ICustomer>): Promise<ICustomer | null> {
    return await CustomerModel.findByIdAndUpdate(customerId, updates, { new: true });
  }

  /** Add a saved address. Enforces single default: if is_default=true, clears others first. */
  async addAddress(
    customerId: string,
    address: ICustomer['saved_addresses'][number]
  ): Promise<ICustomer | null> {
    if (address.is_default) {
      await CustomerModel.findByIdAndUpdate(customerId, {
        $set: { 'saved_addresses.$[].is_default': false },
      });
    }
    return await CustomerModel.findByIdAndUpdate(
      customerId,
      { $push: { saved_addresses: address } },
      { new: true }
    );
  }

  /** Remove an address by its embedded document _id. */
  async removeAddress(customerId: string, addressId: string): Promise<ICustomer | null> {
    return await CustomerModel.findByIdAndUpdate(
      customerId,
      { $pull: { saved_addresses: { _id: addressId } } },
      { new: true }
    );
  }

  /** Set one address as default; clear others. */
  async setDefaultAddress(customerId: string, addressId: string): Promise<ICustomer | null> {
    await CustomerModel.findByIdAndUpdate(customerId, {
      $set: { 'saved_addresses.$[].is_default': false },
    });
    return await CustomerModel.findOneAndUpdate(
      { _id: customerId, 'saved_addresses._id': addressId },
      { $set: { 'saved_addresses.$.is_default': true } },
      { new: true }
    );
  }

  /** Add a payment method. Enforces single default. */
  async addPaymentMethod(
    customerId: string,
    method: ICustomer['saved_payment_methods'][number]
  ): Promise<ICustomer | null> {
    if (method.is_default) {
      await CustomerModel.findByIdAndUpdate(customerId, {
        $set: { 'saved_payment_methods.$[].is_default': false },
      });
    }
    return await CustomerModel.findByIdAndUpdate(
      customerId,
      { $push: { saved_payment_methods: method } },
      { new: true }
    );
  }

  /** Remove a payment method by its embedded document _id. */
  async removePaymentMethod(customerId: string, methodId: string): Promise<ICustomer | null> {
    return await CustomerModel.findByIdAndUpdate(
      customerId,
      { $pull: { saved_payment_methods: { _id: methodId } } },
      { new: true }
    );
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
