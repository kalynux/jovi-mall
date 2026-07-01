import { ShipmentModel, IShipment, IShipmentItem } from './shipment.model';

export class ShipmentRepository {
  async create(data: Partial<IShipment>): Promise<IShipment> {
    return await ShipmentModel.create(data);
  }

  async findById(shipmentId: string): Promise<IShipment | null> {
    return await ShipmentModel.findById(shipmentId);
  }

  async findByOrderId(orderId: string): Promise<IShipment[]> {
    return await ShipmentModel.find({ order_id: orderId });
  }

  /**
   * Set/replace the carrier tracking number on a shipment matching `filter`
   * (used to enforce agency/agent ownership at the query level). Returns the
   * updated shipment, or null when no shipment matches.
   */
  async setTrackingNumber(
    filter: Record<string, unknown>,
    trackingNumber: string
  ): Promise<IShipment | null> {
    return await ShipmentModel.findOneAndUpdate(
      filter,
      { $set: { tracking_number: trackingNumber } },
      { new: true }
    );
  }

  /**
   * Find a shipment for an order/agency pair that can still accept more items.
   * Only shipments that have not yet left the agency (`pending` or `assigned`)
   * are groupable — once a courier has picked up, a late item gets its own
   * shipment instead. Returns null when no such shipment exists.
   */
  async findGroupableByOrderAndAgency(orderId: string, agencyId: string): Promise<IShipment | null> {
    return await ShipmentModel.findOne({
      order_id: orderId,
      agency_id: agencyId,
      status: { $in: ['pending', 'assigned'] }
    });
  }

  /** Append a line item to a shipment. Returns the updated shipment. */
  async addItem(shipmentId: string, item: IShipmentItem): Promise<IShipment | null> {
    return await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $push: { items: item } },
      { new: true }
    );
  }

  /**
   * Remove a line item from a shipment. If the shipment is left with no items,
   * it is deleted (an empty shipment has nothing to dispatch). Returns the
   * remaining shipment, or null when it was deleted / not found.
   */
  async removeItem(shipmentId: string, orderItemId: string): Promise<IShipment | null> {
    const updated = await ShipmentModel.findByIdAndUpdate(
      shipmentId,
      { $pull: { items: { order_item_id: orderItemId } } },
      { new: true }
    );

    if (updated && updated.items.length === 0) {
      await ShipmentModel.deleteOne({ _id: shipmentId });
      return null;
    }

    return updated;
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
