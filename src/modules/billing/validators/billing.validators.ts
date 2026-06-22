import { z } from 'zod';

/** Admin: create a pricing plan. */
export const CreatePlanSchema = z.object({
  role: z.literal('vendor').default('vendor'),
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  price: z.number().min(0),
  currency: z.string().trim().length(3).optional(),
  term_days: z.number().int().min(1).nullable(),
  credit_allowance: z.number().int().min(0),
  max_active_products: z.number().int().min(0).nullable(),
  max_storage_bytes: z.number().int().min(0),
  commission_percent: z.number().min(0).max(100),
  is_active: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

/** Admin: update a pricing plan (code/role are immutable, ignored if sent). */
export const UpdatePlanSchema = CreatePlanSchema.partial().omit({ role: true, code: true });

/** Admin: assign a plan to a vendor. */
export const AssignPlanSchema = z.object({
  planId: z.string().trim().min(1),
  paymentRef: z.string().trim().min(1).optional(),
});

/** Shared payment channel shape (mobile money / card). */
const PaymentChannelSchema = z
  .object({
    phoneNumber: z.string().trim().optional(),
    phoneOperator: z.enum(['MTN', 'ORANGE', 'MOOV']).optional(),
    cardToken: z.string().trim().optional(),
    customerEmail: z.string().email().optional(),
    customerName: z.string().trim().optional(),
  })
  .default({});

/** Vendor: start a credit top-up purchase. */
export const InitiateTopupSchema = z.object({
  packCode: z.string().trim().min(1),
  gateway: z.enum(['NOTCHPAY', 'MYCOOLPAY', 'STRIPE']),
  channel: PaymentChannelSchema,
});

/** Vendor: start a self-serve plan purchase (planId comes from the URL). */
export const InitiatePlanPurchaseSchema = z.object({
  gateway: z.enum(['NOTCHPAY', 'MYCOOLPAY', 'STRIPE']),
  channel: PaymentChannelSchema,
});

/** Pagination query for ledger / top-up history. */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Vendor: how many days before expiry to be notified. */
export const ExpiryNoticeSchema = z.object({
  notifyDaysBeforeExpiry: z.number().int().min(0).max(90),
});
