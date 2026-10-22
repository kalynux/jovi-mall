import { Types, ClientSession } from 'mongoose';
import { PricingPlanModel, IPricingPlan, PlanRole } from '../models/pricing-plan.model';
import type { VendorKind } from '../../vendors/domain/vendor-kind';
import { vendorPlanKindFilter } from '../domain/plan-vendor-kind';

/**
 * Persistence for the admin-managed pricing plan catalog. Thin wrapper over the
 * Mongoose model (matches the vendor module's repository style). All reads
 * exclude soft-deleted plans.
 */
export class PricingPlanRepository {
  async create(data: Partial<IPricingPlan>): Promise<IPricingPlan> {
    return PricingPlanModel.create(data);
  }

  async findById(id: string): Promise<IPricingPlan | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return PricingPlanModel.findOne({ _id: id, deletedAt: null });
  }

  async findByCode(role: PlanRole, code: string, session?: ClientSession): Promise<IPricingPlan | null> {
    const query = PricingPlanModel.findOne({ role, code: code.toLowerCase(), deletedAt: null });
    if (session) query.session(session);
    return query.exec();
  }

  /**
   * List plans for a role. `activeOnly` filters to `is_active` (vendor-facing).
   *
   * `vendorKind` narrows a VENDOR list to one kind (SERVICE-LISTINGS-PLAN § C-5) — through
   * `vendorPlanKindFilter`, whose seller half is `$ne: 'provider'` so a plan seeded before the
   * field existed still lists as a seller plan. Ignored for agency and agent plans.
   */
  async list(role: PlanRole, activeOnly: boolean, vendorKind?: VendorKind | null): Promise<IPricingPlan[]> {
    const filter: Record<string, unknown> = { role, deletedAt: null };
    if (activeOnly) filter.is_active = true;
    if (role === 'vendor' && vendorKind) Object.assign(filter, vendorPlanKindFilter(vendorKind));
    return PricingPlanModel.find(filter).sort({ sort_order: 1, price: 1 });
  }

  async update(id: string, updates: Partial<IPricingPlan>): Promise<IPricingPlan | null> {
    if (!Types.ObjectId.isValid(id)) return null;
    return PricingPlanModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: updates },
      { new: true }
    );
  }

  async softDelete(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) return false;
    const res = await PricingPlanModel.updateOne(
      { _id: id, deletedAt: null },
      { $set: { deletedAt: new Date() } }
    );
    return res.modifiedCount > 0;
  }
}
