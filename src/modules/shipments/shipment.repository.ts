import { ShipmentModel, IShipment } from './shipment.model';

export class ShipmentRepository {
  async create(data: Partial<IShipment>): Promise<IShipment> {
    return await ShipmentModel.create(data);
  }

  async findByOrderId(orderId: string): Promise<IShipment[]> {
    return await ShipmentModel.find({ order_id: orderId });
  }

  /**
   * Advance all `pending` shipments of an order to `assigned` (the hand-off to
   * the agency). Returns the number of shipments updated. Only `pending`
   * shipments are touched, so this is safe to call idempotently.
   */
  async assignPendingByOrderId(orderId: string): Promise<number> {
    const result = await ShipmentModel.updateMany(
      { order_id: orderId, status: 'pending' },
      { $set: { status: 'assigned' } }
    );
    return result.modifiedCount ?? 0;
  }
}
