import { Types } from 'mongoose';
import { BillingSettingsModel, IBillingSettings } from '../models/billing-settings.model';
import { BillingOwnerType } from '../billing.types';

/**
 * Persistence for per-owner billing preferences (agency/agent). The document is
 * created lazily (upsert) the first time it is read or written.
 */
export class BillingSettingsRepository {
  async getOrCreate(ownerType: BillingOwnerType, ownerId: string): Promise<IBillingSettings> {
    const settings = await BillingSettingsModel.findOneAndUpdate(
      { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) },
      { $setOnInsert: { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).exec();
    return settings!;
  }

  async getNotifyDaysBeforeExpiry(ownerType: BillingOwnerType, ownerId: string): Promise<number> {
    const settings = await this.getOrCreate(ownerType, ownerId);
    return settings.notify_days_before_expiry ?? 7;
  }

  async setNotifyDaysBeforeExpiry(
    ownerType: BillingOwnerType,
    ownerId: string,
    days: number
  ): Promise<number> {
    const settings = await this.getOrCreate(ownerType, ownerId);
    settings.notify_days_before_expiry = days;
    await settings.save();
    return settings.notify_days_before_expiry;
  }

  /** Timestamp of the last over-cap alert (null = not currently alerted). */
  async getShipmentCapAlertedAt(ownerType: BillingOwnerType, ownerId: string): Promise<Date | null> {
    const settings = await this.getOrCreate(ownerType, ownerId);
    return settings.shipment_cap_alerted_at ?? null;
  }

  async setShipmentCapAlertedAt(
    ownerType: BillingOwnerType,
    ownerId: string,
    at: Date | null
  ): Promise<void> {
    await BillingSettingsModel.updateOne(
      { owner_type: ownerType, owner_id: new Types.ObjectId(ownerId) },
      { $set: { shipment_cap_alerted_at: at } },
      { upsert: true }
    );
  }
}
