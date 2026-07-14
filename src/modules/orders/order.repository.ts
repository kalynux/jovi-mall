import { ClientSession, Types } from 'mongoose';
import { OrderModel, IOrder } from './order.model';
import { ShipmentModel } from '../shipments/shipment.model';
import { PaginationOptions, Page } from '../../core/repositories/base.repository';

const HELD_STATUS = 'pending_agency_reassignment';
const REASSIGNABLE_STATUSES = ['pending', 'assigned'];

/** One checkout group (per-vendor orders sharing a cart_id) for the customer view. */
export interface CustomerOrderGroup {
  cartId: string;
  createdAt: Date;
  currency: string;
  totalAmount: number;
  orderCount: number;
  paymentStatuses: string[];
  orders: Array<{
    id: string;
    orderNumber: string;
    vendorId: string;
    orderType: string;
    total: number;
    currency: string;
    paymentMethod: string;
    paymentStatus: string;
    fulfillmentStatus: string;
    itemCount: number;
    createdAt: Date;
  }>;
}

export class OrderRepository {
  /**
   * Create an order. Pass a `session` to enrol the write in a transaction
   * (used by the multi-vendor cart split, which creates N orders atomically).
   */
  async create(data: Partial<IOrder>, session?: ClientSession): Promise<IOrder> {
    if (session) {
      const [order] = await OrderModel.create([data], { session });
      return order;
    }
    return await OrderModel.create(data);
  }

  async findById(id: string): Promise<IOrder | null> {
    return await OrderModel.findById(id).populate('items.product_id');
  }

  /**
   * Customer order history grouped by checkout group (cart_id), paginated by
   * group. A single multi-vendor cart splits into one order per vendor sharing a
   * cart_id; grouping at the DB level keeps every order of a checkout on the same
   * page. Backed by the { customer_id, cart_id } index.
   */
  async findGroupsByCustomer(
    customerId: string,
    pagination: PaginationOptions
  ): Promise<Page<CustomerOrderGroup>> {
    const { page = 1, limit = 20 } = pagination;
    const skip = (page - 1) * limit;

    const [result] = await OrderModel.aggregate([
      { $match: { customer_id: new Types.ObjectId(customerId) } },
      { $sort: { created_at: -1 } },
      {
        $group: {
          _id: '$cart_id',
          createdAt: { $first: '$created_at' },
          currency: { $first: '$currency' },
          totalAmount: { $sum: '$total_amount' },
          orderCount: { $sum: 1 },
          paymentStatuses: { $addToSet: '$payment_status' },
          orders: {
            $push: {
              id: '$_id',
              orderNumber: '$order_number',
              vendorId: '$vendor_id',
              orderType: '$order_type',
              total: '$total_amount',
              currency: '$currency',
              paymentMethod: '$payment_method',
              paymentStatus: '$payment_status',
              fulfillmentStatus: '$fulfillment_status',
              itemCount: { $size: '$items' },
              createdAt: '$created_at'
            }
          }
        }
      },
      { $sort: { createdAt: -1 } },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: 'count' }]
        }
      }
    ]);

    const groups: CustomerOrderGroup[] = (result?.data ?? []).map((g: any) => ({
      cartId: g._id?.toString(),
      createdAt: g.createdAt,
      currency: g.currency,
      totalAmount: g.totalAmount,
      orderCount: g.orderCount,
      paymentStatuses: g.paymentStatuses,
      orders: g.orders.map((o: any) => ({
        id: o.id?.toString(),
        orderNumber: o.orderNumber,
        vendorId: o.vendorId?.toString(),
        orderType: o.orderType,
        total: o.total,
        currency: o.currency,
        paymentMethod: o.paymentMethod ?? 'online',
        paymentStatus: o.paymentStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        itemCount: o.itemCount,
        createdAt: o.createdAt
      }))
    }));

    const total = result?.total?.[0]?.count ?? 0;

    return {
      data: groups,
      meta: { total, page, limit, pages: Math.ceil(total / limit) }
    };
  }

  /**
   * All orders belonging to one checkout group for a customer (the per-vendor
   * split of a single cart). Ownership enforced via customer_id.
   */
  async findByCartAndCustomer(cartId: string, customerId: string): Promise<IOrder[]> {
    return await OrderModel
      .find({ cart_id: cartId, customer_id: customerId })
      .exec();
  }

  /**
   * Put every still pending/assigned item currently riding `agencyId` on hold
   * (any vendor, any provenance — default or product override, doesn't matter here).
   * `agency_id` is left unchanged; only `status` flips, with each item's own prior
   * status snapshotted so unhold/reassignment can restore it exactly. Also mirrors
   * the hold onto matching Shipments. Returns the affected {orderId, itemId} pairs.
   */
  async holdItemsByAgency(agencyId: string, session?: ClientSession): Promise<{ orderId: string; itemId: string }[]> {
    const agencyObjId = new Types.ObjectId(agencyId);
    const sessionOpt = session ? { session } : {};

    const orders = await OrderModel.find(
      {
        order_type: 'physical',
        items: {
          $elemMatch: {
            'delivery.agency_id': agencyObjId,
            'delivery.status': { $in: REASSIGNABLE_STATUSES },
          },
        },
      },
      { _id: 1, items: 1 },
      sessionOpt,
    ).lean();

    const affected: { orderId: string; itemId: string }[] = [];
    for (const order of orders as any[]) {
      for (const item of order.items) {
        if (
          item.delivery?.agency_id?.toString() === agencyId &&
          REASSIGNABLE_STATUSES.includes(item.delivery.status)
        ) {
          affected.push({ orderId: order._id.toString(), itemId: item._id.toString() });
        }
      }
    }

    if (affected.length === 0) return [];

    const orderIds = [...new Set(affected.map(a => a.orderId))].map(id => new Types.ObjectId(id));

    await OrderModel.updateMany(
      { _id: { $in: orderIds } },
      [
        {
          $set: {
            items: {
              $map: {
                input: '$items',
                as: 'item',
                in: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$$item.delivery.agency_id', agencyObjId] },
                        { $in: ['$$item.delivery.status', REASSIGNABLE_STATUSES] },
                      ],
                    },
                    {
                      $mergeObjects: [
                        '$$item',
                        {
                          delivery: {
                            $mergeObjects: [
                              '$$item.delivery',
                              {
                                status: HELD_STATUS,
                                hold: { previousStatus: '$$item.delivery.status', heldAt: '$$NOW' },
                              },
                            ],
                          },
                        },
                      ],
                    },
                    '$$item',
                  ],
                },
              },
            },
            updated_at: '$$NOW',
          },
        },
      ] as any,
      sessionOpt,
    ).exec();

    // Mirror onto matching shipments, snapshotting each one's own prior status.
    for (const prevStatus of REASSIGNABLE_STATUSES) {
      await ShipmentModel.updateMany(
        { agency_id: agencyObjId, status: prevStatus },
        { $set: { status: HELD_STATUS, hold: { previousStatus: prevStatus, heldAt: new Date() } } },
        sessionOpt,
      ).exec();
    }

    return affected;
  }

  /**
   * Agency came back — restore items held because of it back to their saved
   * previousStatus, same agency (nothing moved). Mirrors the restore onto
   * matching Shipments. Returns the affected items with their resulting status.
   */
  async unholdItemsForAgency(
    agencyId: string,
    session?: ClientSession,
  ): Promise<{ orderId: string; itemId: string; status: string }[]> {
    const agencyObjId = new Types.ObjectId(agencyId);
    const sessionOpt = session ? { session } : {};

    const orders = await OrderModel.find(
      {
        items: {
          $elemMatch: {
            'delivery.agency_id': agencyObjId,
            'delivery.status': HELD_STATUS,
          },
        },
      },
      { _id: 1, items: 1 },
      sessionOpt,
    ).lean();

    const affected: { orderId: string; itemId: string; status: string }[] = [];
    for (const order of orders as any[]) {
      for (const item of order.items) {
        if (item.delivery?.agency_id?.toString() === agencyId && item.delivery.status === HELD_STATUS) {
          affected.push({
            orderId: order._id.toString(),
            itemId: item._id.toString(),
            status: item.delivery.hold?.previousStatus ?? 'pending',
          });
        }
      }
    }

    if (affected.length === 0) return [];

    const orderIds = [...new Set(affected.map(a => a.orderId))].map(id => new Types.ObjectId(id));

    await OrderModel.updateMany(
      { _id: { $in: orderIds } },
      [
        {
          $set: {
            items: {
              $map: {
                input: '$items',
                as: 'item',
                in: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$$item.delivery.agency_id', agencyObjId] },
                        { $eq: ['$$item.delivery.status', HELD_STATUS] },
                      ],
                    },
                    {
                      $mergeObjects: [
                        '$$item',
                        {
                          delivery: {
                            $mergeObjects: [
                              '$$item.delivery',
                              {
                                status: '$$item.delivery.hold.previousStatus',
                                hold: null,
                              },
                            ],
                          },
                        },
                      ],
                    },
                    '$$item',
                  ],
                },
              },
            },
            updated_at: '$$NOW',
          },
        },
      ] as any,
      sessionOpt,
    ).exec();

    await ShipmentModel.updateMany(
      { agency_id: agencyObjId, status: HELD_STATUS },
      [
        {
          $set: {
            status: '$hold.previousStatus',
            hold: null,
          },
        },
      ] as any,
      sessionOpt,
    ).exec();

    return affected;
  }

  /**
   * Mirror a shipment's new status onto every order item riding it (an item's
   * `delivery.status` must always agree with its shipment). Called after every
   * agency-driven or customer-driven shipment status change.
   */
  async setItemDeliveryStatusByShipment(
    shipmentId: string,
    newStatus: string,
    session?: ClientSession,
  ): Promise<void> {
    const sessionOpt = session ? { session } : {};
    await OrderModel.updateOne(
      { 'items.delivery.shipment_id': new Types.ObjectId(shipmentId) },
      { $set: { 'items.$[elem].delivery.status': newStatus, updated_at: new Date() } },
      {
        arrayFilters: [{ 'elem.delivery.shipment_id': new Types.ObjectId(shipmentId) }],
        ...sessionOpt,
      },
    ).exec();
  }

  /**
   * An agency rejected a shipment it hadn't yet picked up — put every item riding
   * it on hold (`pending_agency_reassignment`), same shape as `holdItemsByAgency`,
   * so the vendor's existing `updateDeliveryAgency` reassignment path picks it up
   * without any new reassignment logic. Only valid from `assigned` (the gate that
   * allows a rejection in the first place).
   */
  async holdItemsForRejectedShipment(shipmentId: string, session?: ClientSession): Promise<void> {
    const sessionOpt = session ? { session } : {};
    const now = new Date();
    await OrderModel.updateOne(
      { 'items.delivery.shipment_id': new Types.ObjectId(shipmentId) },
      {
        $set: {
          'items.$[elem].delivery.status': HELD_STATUS,
          'items.$[elem].delivery.hold': { previousStatus: 'assigned', heldAt: now },
          updated_at: now,
        },
      },
      {
        arrayFilters: [{ 'elem.delivery.shipment_id': new Types.ObjectId(shipmentId) }],
        ...sessionOpt,
      },
    ).exec();
  }
}
