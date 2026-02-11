import { IMapper } from '../../../../core/database/mapper.interface';
import { IStockReservation, ReservationType, ReservationStatus } from '../../models/stock-reservation.model';

export interface StockReservation {
  id: string;
  reservationId: string;
  productId: string;
  variantId: string;
  quantity: number;
  type: ReservationType;
  status: ReservationStatus;
  expiresAt: Date;
  vendorId: string;
  availabilitySlotId?: string;
  digitalAssetId?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  purgeAt?: Date | null;
}

export class StockReservationMapper implements IMapper<StockReservation, IStockReservation> {
  toDomain(persistence: IStockReservation): StockReservation {
    const doc = persistence.toObject ? persistence.toObject() : persistence;
    return {
      id: doc._id.toString(),
      reservationId: doc.reservationId,
      productId: doc.productId.toString(),
      variantId: doc.variantId.toString(),
      quantity: doc.quantity,
      type: doc.type,
      status: doc.status,
      expiresAt: doc.expiresAt,
      vendorId: doc.vendorId.toString(),
      availabilitySlotId: doc.availabilitySlotId?.toString(),
      digitalAssetId: doc.digitalAssetId?.toString(),
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      deletedAt: doc.deletedAt,
      purgeAt: doc.purgeAt,
    };
  }

  toPersistence(domain: StockReservation): IStockReservation {
    return {
      _id: domain.id,
      reservationId: domain.reservationId,
      productId: domain.productId,
      variantId: domain.variantId,
      quantity: domain.quantity,
      type: domain.type,
      status: domain.status,
      expiresAt: domain.expiresAt,
      vendorId: domain.vendorId,
      availabilitySlotId: domain.availabilitySlotId,
      digitalAssetId: domain.digitalAssetId,
    } as any;
  }
}
