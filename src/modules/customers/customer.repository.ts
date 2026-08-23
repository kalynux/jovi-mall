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

  /**
   * Land a confirmed contact change on the profile — the value AND its verified flag,
   * together (Phase 6 · 6.D.1).
   *
   * Separate from `markEmailVerified` because that one answers "the address already on
   * file has now been proved" and this one answers "a different address has been proved
   * and is now the address on file". Writing the pair in one `$set` is what stops the
   * profile ever showing an unverified address that the login identifier has already
   * moved to — the two would then disagree about the same fact.
   *
   * Deliberately does **not** touch `status`, unlike the vendor and agency
   * `markEmailVerified` pipelines: changing your email is not an onboarding step, and a
   * customer sitting at `pending_verification` for an unrelated reason must not be
   * promoted out of it by editing their contact details.
   */
  async setVerifiedContact(
    userId: string,
    contact: { email?: string; phone?: string }
  ): Promise<ICustomer | null> {
    const set: Record<string, unknown> = {};
    if (contact.email !== undefined) {
      set.email = contact.email;
      set.email_verified = true;
    }
    if (contact.phone !== undefined) {
      set.phone = contact.phone;
      set.phone_verified = true;
    }
    if (Object.keys(set).length === 0) return await this.findByUserId(userId);

    return await CustomerModel.findOneAndUpdate({ user_id: userId }, { $set: set }, { new: true });
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

  /**
   * Edit a saved address **in place**, preserving its `_id`.
   *
   * That preservation is the whole point. Editing used to mean delete + re-add, which mints
   * a new subdocument id — while past orders still reference the old one through
   * `deliveryAddressId`. A customer correcting a typo in their street name silently orphaned
   * every order that had been delivered there.
   *
   * Only the keys present in `updates` are written, as dotted paths, so an edit of one field
   * cannot blank the others. `is_default` is deliberately NOT accepted here — it is a
   * relationship between addresses rather than a property of one, and `setDefaultAddress`
   * owns the clear-then-set that keeps it single.
   */
  async updateAddress(
    customerId: string,
    addressId: string,
    updates: Partial<ICustomer['saved_addresses'][number]>,
  ): Promise<ICustomer | null> {
    const set: Record<string, unknown> = {};
    const unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      // ⚠ The deprecated bare `location` is 2dsphere-indexed across the whole
      // array, and a stored `null` there beside a real point on ANOTHER address
      // makes every subsequent write to this customer fail — see
      // `dropNullLocation`. So clearing it is an `$unset`, never a `$set: null`.
      // Every other field takes the null happily and means it.
      if (key === 'location' && value === null) {
        unset[`saved_addresses.$.${key}`] = '';
        continue;
      }
      set[`saved_addresses.$.${key}`] = value;
    }

    const update: Record<string, unknown> = {};
    if (Object.keys(set).length > 0) update.$set = set;
    if (Object.keys(unset).length > 0) update.$unset = unset;

    // Nothing to write — return the document unchanged rather than sending an empty `$set`,
    // which MongoDB rejects outright ("'$set' is empty").
    if (Object.keys(update).length === 0) {
      return await CustomerModel.findById(customerId);
    }

    return await CustomerModel.findOneAndUpdate(
      { _id: customerId, 'saved_addresses._id': addressId },
      update,
      { new: true },
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
}
