import mongoose, { Schema, Document } from 'mongoose';
import { MODELS, COLLECTIONS } from '../../../core/database/collections';
import { BillingOwnerType, BILLING_OWNER_TYPES } from '../billing.types';

/**
 * PlanPurchase - An owner's self-serve purchase of a paid pricing plan.
 *
 * Mirrors CreditTopup: created `pending` when the owner (vendor/agency/agent)
 * starts checkout, flipped to `paid` once the gateway confirms (via verify), at
 * which point the plan is assigned/activated on the owner's account
 * (SubscriberPlanService.assignPlan). `subscriber_plan_id` records the resulting
 * SubscriberPlan (active or queued pending).
 */

export type PlanPurchaseStatus = 'pending' | 'paid' | 'failed' | 'reversed';
export type PlanPurchaseGateway = 'NOTCHPAY' | 'MYCOOLPAY' | 'STRIPE';

export interface IPlanPurchase extends Document {
  owner_type: BillingOwnerType;
  owner_id: mongoose.Types.ObjectId;
  plan_id: mongoose.Types.ObjectId;
  plan_code: string;
  price: number;
  currency: string;
  status: PlanPurchaseStatus;
  gateway: PlanPurchaseGateway | null;
  gateway_ref: string | null;
  /** The SubscriberPlan created when this purchase was applied (null until paid+applied). */
  subscriber_plan_id: mongoose.Types.ObjectId | null;
  created_at: Date;
  updated_at: Date;
}

const PlanPurchaseSchema = new Schema<IPlanPurchase>(
  {
    owner_type: { type: String, enum: BILLING_OWNER_TYPES, required: true },
    owner_id: { type: Schema.Types.ObjectId, required: true },
    plan_id: { type: Schema.Types.ObjectId, ref: MODELS.PRICING_PLAN, required: true },
    plan_code: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: ['pending', 'paid', 'failed', 'reversed'], default: 'pending' },
    gateway: { type: String, enum: ['NOTCHPAY', 'MYCOOLPAY', 'STRIPE'], default: null },
    gateway_ref: { type: String, default: null },
    subscriber_plan_id: { type: Schema.Types.ObjectId, ref: MODELS.SUBSCRIBER_PLAN, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

PlanPurchaseSchema.index({ owner_type: 1, owner_id: 1, created_at: -1 });

export const PlanPurchaseModel = mongoose.model<IPlanPurchase>(
  MODELS.PLAN_PURCHASE,
  PlanPurchaseSchema,
  COLLECTIONS.PLAN_PURCHASE
);
