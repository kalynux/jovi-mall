import { OrderModel, IOrder } from './order.model';

export class OrderRepository {
  async create(data: Partial<IOrder>): Promise<IOrder> {
    return await OrderModel.create(data);
  }

  async findById(id: string): Promise<IOrder | null> {
    return await OrderModel.findById(id).populate('items.product_id');
  }
}
