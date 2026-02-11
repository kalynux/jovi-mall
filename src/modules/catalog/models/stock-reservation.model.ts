import { Schema, model, Types } from 'mongoose';
import { IBaseDocument, BaseSchemaFields, BaseSchemaOptions } from '../../../core/base.schema';

export type ReservationType = 'physical' | 'digital' | 'service';
export type ReservationStatus = 'active' | 'released' | 'committed' | 'expired';

export interface IStockReservation extends IBaseDocument {
  reservationId: string;           // Idempotency key (unique)
  productId: Types.ObjectId;
  variantId: Types.ObjectId;
  quantity: number;
  type: ReservationType;
  status: ReservationStatus;
  expiresAt: Date;                 // For TTL cleanup
  
  // Vendor context for ownership checks
  vendorId: Types.ObjectId;
  
  // Context for capacity restoration
  availabilitySlotId?: Types.ObjectId; // service only
  digitalAssetId?: Types.ObjectId;      // digital only
}

const StockReservationSchema = new Schema<IStockReservation>({
  reservationId: { 
    type: String, 
    required: true, 
    unique: true, 
    index: true 
  },
  productId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Product', 
    required: true, 
    index: true 
  },
  variantId: { 
    type: Schema.Types.ObjectId, 
    ref: 'ProductVariant', 
    required: true, 
    index: true 
  },
  quantity: { 
    type: Number, 
    required: true, 
    min: 1 
  },
  type: { 
    type: String, 
    enum: ['physical', 'digital', 'service'], 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['active', 'released', 'committed', 'expired'], 
    default: 'active', 
    index: true 
  },
  expiresAt: { 
    type: Date, 
    required: true, 
    // index: true 
  },
  vendorId: { 
    type: Schema.Types.ObjectId, 
    ref: 'Vendor', 
    required: true,
    index: true
  },
  
  // Optional context for restoration
  availabilitySlotId: { 
    type: Schema.Types.ObjectId, 
    ref: 'ServiceAvailability' 
  },
  digitalAssetId: { 
    type: Schema.Types.ObjectId, 
    ref: 'DigitalAsset' 
  },
  
  ...BaseSchemaFields
}, BaseSchemaOptions);

// Indexes
// TTL index for automatic expiration cleanup
StockReservationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Composite indexes for queries
StockReservationSchema.index({ variantId: 1, status: 1 });
StockReservationSchema.index({ productId: 1, status: 1 });

export const StockReservationModel = model<IStockReservation>('StockReservation', StockReservationSchema);
