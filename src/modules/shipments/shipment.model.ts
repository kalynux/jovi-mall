import mongoose, { Schema, Document } from 'mongoose';

export interface IShipmentItem {
  order_item_id: mongoose.Types.ObjectId;
  product_id: mongoose.Types.ObjectId;
  quantity: number;
}

export interface IShipment extends Document {
  order_id: mongoose.Types.ObjectId;
  agency_id: mongoose.Types.ObjectId;
  agent_id?: mongoose.Types.ObjectId | null;
  status: 'pending' | 'assigned' | 'picked_up' | 'in_transit' | 'delivered' | 'failed' | 'returned';
  items: IShipmentItem[];
  created_at: Date;
  updated_at: Date;
}

const ShipmentSchema = new Schema<IShipment>({
  order_id: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  agency_id: { type: Schema.Types.ObjectId, ref: 'DeliveryAgency', required: true },
  agent_id: { type: Schema.Types.ObjectId, ref: 'DeliveryAgent', default: null },
  status: { 
    type: String, 
    enum: ['pending', 'assigned', 'picked_up', 'in_transit', 'delivered', 'failed', 'returned'],
    default: 'pending'
  },
  items: [{
    order_item_id: { type: Schema.Types.ObjectId, required: true },
    product_id: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true }
  }]
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

export const ShipmentModel = mongoose.model<IShipment>('Shipment', ShipmentSchema);
