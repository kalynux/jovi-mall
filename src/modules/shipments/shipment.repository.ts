import { ShipmentModel, IShipment } from './shipment.model';

export class ShipmentRepository {
  async create(data: Partial<IShipment>): Promise<IShipment> {
    return await ShipmentModel.create(data);
  }

  async findByOrderId(orderId: string): Promise<IShipment[]> {
    return await ShipmentModel.find({ order_id: orderId });
  }
}
