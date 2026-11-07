import { z } from 'zod';
import {
  DURATION_MAX_MONTHS,
  DURATION_MIN_MONTHS,
  isValidRatePercent,
  RATE_MAX_PERCENT,
  RATE_MIN_PERCENT,
} from '../domain/referral-rules';

const RatePercentSchema = z
  .number()
  .min(RATE_MIN_PERCENT)
  .max(RATE_MAX_PERCENT)
  .refine(isValidRatePercent, { message: 'A rate has at most two decimals' });
const DurationMonthsSchema = z.number().int().min(DURATION_MIN_MONTHS).max(DURATION_MAX_MONTHS);

const ReasonSchema = z.string().trim().min(3).max(1000);

export const ApplySchema = z
  .object({
    /** Accepting the Partner Terms is what an application is (owner R-13). */
    termsAccepted: z.literal(true),
    motivation: z.string().trim().max(1000).optional(),
  })
  .strict();

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const GlobalCategoryTermsSchema = z
  .object({ ratePercent: RatePercentSchema.optional(), durationMonths: DurationMonthsSchema.optional() })
  .strict();

export const UpdateSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    terms: z
      .object({
        vendor: GlobalCategoryTermsSchema.optional(),
        customer: GlobalCategoryTermsSchema.optional(),
        agency: GlobalCategoryTermsSchema.optional(),
      })
      .strict()
      .optional(),
    minPayoutAmount: z.number().int().min(1).optional(),
    rewardWaitDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();

/** `null` returns a field to the global value (document § 9). */
const PartnerCategoryTermsSchema = z
  .object({
    ratePercent: RatePercentSchema.nullable().optional(),
    durationMonths: DurationMonthsSchema.nullable().optional(),
  })
  .strict();

export const UpdatePartnerTermsSchema = z
  .object({
    terms: z
      .object({
        vendor: PartnerCategoryTermsSchema.optional(),
        customer: PartnerCategoryTermsSchema.optional(),
        agency: PartnerCategoryTermsSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const OptionalReasonBodySchema = z.object({ reason: ReasonSchema.optional() }).strict();
export const RequiredReasonBodySchema = z.object({ reason: ReasonSchema }).strict();
