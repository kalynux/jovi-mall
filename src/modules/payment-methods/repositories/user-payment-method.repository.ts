import { Types } from 'mongoose';
import { UserPaymentMethodModel, IUserPaymentMethod, PaymentMethodType } from '../models/user-payment-method.model';
import { UserRole } from '../../users/user.model';

/** Plain field set for creating a payment method (excludes owner + persistence fields). */
export interface PaymentMethodCreateData {
    provider: string;
    gateway_customer_id: string;
    gateway_instrument_id: string;
    method_type: PaymentMethodType;
    display_label: string;
    brand: string | null;
    last4: string | null;
    exp_month: number | null;
    exp_year: number | null;
    holder_name: string | null;
    is_default: boolean;
}

/**
 * Persistence for per-user saved payment methods. Every query is scoped to the
 * owning (owner_role, owner_id) pair so one user can never read or mutate
 * another's instruments.
 */
export class UserPaymentMethodRepository {
    /** All methods for an owner, default first then newest. */
    async list(ownerRole: UserRole, ownerId: string): Promise<IUserPaymentMethod[]> {
        return UserPaymentMethodModel.find({
            owner_role: ownerRole,
            owner_id: new Types.ObjectId(ownerId),
        })
            .sort({ is_default: -1, created_at: -1 })
            .exec();
    }

    /** A single method, scoped to its owner. Returns null if not found / not owned. */
    async findByIdScoped(
        ownerRole: UserRole,
        ownerId: string,
        id: string
    ): Promise<IUserPaymentMethod | null> {
        if (!Types.ObjectId.isValid(id)) return null;
        return UserPaymentMethodModel.findOne({
            _id: new Types.ObjectId(id),
            owner_role: ownerRole,
            owner_id: new Types.ObjectId(ownerId),
        }).exec();
    }

    /** The owner's current default method, if any. */
    async findDefault(ownerRole: UserRole, ownerId: string): Promise<IUserPaymentMethod | null> {
        return UserPaymentMethodModel.findOne({
            owner_role: ownerRole,
            owner_id: new Types.ObjectId(ownerId),
            is_default: true,
        }).exec();
    }

    async countByOwner(ownerRole: UserRole, ownerId: string): Promise<number> {
        return UserPaymentMethodModel.countDocuments({
            owner_role: ownerRole,
            owner_id: new Types.ObjectId(ownerId),
        }).exec();
    }

    /**
     * Create a method. If it is the first one for the owner it becomes the default
     * automatically; if `is_default` is requested, any existing default is cleared.
     */
    async create(
        ownerRole: UserRole,
        ownerId: string,
        data: PaymentMethodCreateData
    ): Promise<IUserPaymentMethod> {
        const existingCount = await this.countByOwner(ownerRole, ownerId);
        const makeDefault = data.is_default || existingCount === 0;

        if (makeDefault) {
            await this.clearDefaults(ownerRole, ownerId);
        }

        const created = await UserPaymentMethodModel.create({
            ...data,
            owner_role: ownerRole,
            owner_id: new Types.ObjectId(ownerId),
            is_default: makeDefault,
        });
        return created;
    }

    /** Make one method the default and clear the others. Scoped. */
    async setDefault(
        ownerRole: UserRole,
        ownerId: string,
        id: string
    ): Promise<IUserPaymentMethod | null> {
        const target = await this.findByIdScoped(ownerRole, ownerId, id);
        if (!target) return null;

        await this.clearDefaults(ownerRole, ownerId);
        target.is_default = true;
        await target.save();
        return target;
    }

    /** Delete a method (scoped). Returns true if one was deleted. */
    async remove(ownerRole: UserRole, ownerId: string, id: string): Promise<boolean> {
        if (!Types.ObjectId.isValid(id)) return false;
        const res = await UserPaymentMethodModel.deleteOne({
            _id: new Types.ObjectId(id),
            owner_role: ownerRole,
            owner_id: new Types.ObjectId(ownerId),
        }).exec();
        return res.deletedCount === 1;
    }

    private async clearDefaults(ownerRole: UserRole, ownerId: string): Promise<void> {
        await UserPaymentMethodModel.updateMany(
            {
                owner_role: ownerRole,
                owner_id: new Types.ObjectId(ownerId),
                is_default: true,
            },
            { $set: { is_default: false } }
        ).exec();
    }
}
