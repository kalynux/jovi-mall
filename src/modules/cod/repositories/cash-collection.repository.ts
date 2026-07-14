import { ClientSession, Types } from 'mongoose';
import { CashCollectionModel, ICashCollection } from '../models/cash-collection.model';

export class CashCollectionRepository {
  async create(data: Partial<ICashCollection>, session?: ClientSession): Promise<ICashCollection> {
    if (session) {
      const [doc] = await CashCollectionModel.create([data], { session });
      return doc;
    }
    return await CashCollectionModel.create(data);
  }

  async findById(id: string): Promise<ICashCollection | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return await CashCollectionModel.findById(id);
  }

  async findByShipmentId(shipmentId: string): Promise<ICashCollection | null> {
    return await CashCollectionModel.findOne({ shipment_id: shipmentId });
  }

  /** Shipment-scoped lookup INCLUDING the plaintext code (customer views only). */
  async findByShipmentIdWithCode(shipmentId: string): Promise<ICashCollection | null> {
    return await CashCollectionModel.findOne({ shipment_id: shipmentId }).select('+code_plain');
  }

  async findByOrderId(orderId: string, session?: ClientSession): Promise<ICashCollection[]> {
    const query = CashCollectionModel.find({ order_id: orderId });
    if (session) query.session(session);
    return await query.exec();
  }

  /** The order's collections including plaintext codes (customer views only). */
  async findByOrderIdsWithCode(orderIds: string[]): Promise<ICashCollection[]> {
    return await CashCollectionModel.find({ order_id: { $in: orderIds } }).select('+code_plain');
  }

  /**
   * Record a wrong code attempt; locks the code once `maxAttempts` is reached.
   * Returns the updated document.
   */
  async recordFailedAttempt(id: Types.ObjectId, maxAttempts: number): Promise<ICashCollection | null> {
    const updated = await CashCollectionModel.findByIdAndUpdate(
      id,
      { $inc: { code_attempts: 1 } },
      { new: true }
    );
    if (updated && !updated.code_locked && updated.code_attempts >= maxAttempts) {
      updated.code_locked = true;
      await updated.save();
    }
    return updated;
  }

  /** Regenerate the delivery code: new hash/plain, attempts reset, unlock. */
  async replaceCode(
    id: Types.ObjectId,
    codeHash: string,
    codePlain: string
  ): Promise<ICashCollection | null> {
    return await CashCollectionModel.findByIdAndUpdate(
      id,
      {
        $set: {
          code_hash: codeHash,
          code_plain: codePlain,
          code_generated_at: new Date(),
          code_attempts: 0,
          code_locked: false,
        },
      },
      { new: true }
    );
  }

  /**
   * Atomically claim a pending collection as collected. Returns null when it
   * was already collected/cancelled by a concurrent request — the caller must
   * treat that as a conflict, keeping double-collection impossible.
   */
  async claimCollected(
    id: Types.ObjectId,
    verification: ICashCollection['verification'],
    session: ClientSession
  ): Promise<ICashCollection | null> {
    return await CashCollectionModel.findOneAndUpdate(
      { _id: id, status: 'pending' },
      { $set: { status: 'collected', collected_at: new Date(), verification } },
      { new: true, session }
    );
  }

  /** Cancel a pending collection (shipment ended `returned`). Idempotent. */
  async cancelPendingByShipment(
    shipmentId: string,
    session?: ClientSession
  ): Promise<ICashCollection | null> {
    const sessionOpt = session ? { session } : {};
    return await CashCollectionModel.findOneAndUpdate(
      { shipment_id: shipmentId, status: 'pending' },
      { $set: { status: 'cancelled' } },
      { new: true, ...sessionOpt }
    );
  }
}
