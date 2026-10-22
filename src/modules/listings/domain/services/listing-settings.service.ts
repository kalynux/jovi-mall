import { createAppError } from '../../../../core/errors';
import { ERROR_CODES } from '../../../../core/error-codes';
import { LISTING_REVEAL_FIRST_COST } from '../../../billing/config/credit.config';
import { DEFAULT_LISTING_SETTINGS, ListingSettings } from '../listing.types';
import { settingsProblem, ListingSettingsInput } from '../listing-rules';
import { listingSettingsRepository, ListingSettingsRepository } from '../../repositories/listing-settings.repository';

/**
 * A provider's listing settings (SERVICE-LISTINGS-PLAN L-10, L-11, L-30) —
 * `GET` / `PUT /api/vendor/listing-settings`, stored on `vendors.listing_settings`.
 *
 *   onEmpty                      what happens to customers already in conversation when the
 *                                balance runs out: `stop`, or `continue_engaged` (the default)
 *   debtFloor                    how far below 0 continued service may take the balance; null =
 *                                no floor (L-11)
 *   maxCreditsPerCustomerPerDay  the L-30 cap; null = no limit
 *
 * A missing block reads as the defaults — a provider registered before the field existed, or
 * one who never opened the screen, behaves exactly as `DEFAULT_LISTING_SETTINGS` says.
 */
export type ListingSettingsDto = ListingSettingsInput;

export function toSettingsDto(stored: Partial<ListingSettings> | null | undefined): ListingSettingsDto {
  const s = { ...DEFAULT_LISTING_SETTINGS, ...(stored ?? {}) };
  return {
    onEmpty: s.on_empty,
    debtFloor: s.debt_floor ?? null,
    maxCreditsPerCustomerPerDay: s.max_credits_per_customer_per_day ?? null,
  };
}

export class ListingSettingsService {
  constructor(
    private readonly repo: Pick<ListingSettingsRepository, 'get' | 'put'> = listingSettingsRepository,
    private readonly firstRevealCost: number = LISTING_REVEAL_FIRST_COST,
  ) {}

  async get(vendorId: string): Promise<ListingSettingsDto> {
    return toSettingsDto(await this.repo.get(vendorId));
  }

  async put(vendorId: string, input: ListingSettingsInput): Promise<ListingSettingsDto> {
    const problem = settingsProblem(input, this.firstRevealCost);
    if (problem) {
      throw createAppError(ERROR_CODES.LISTING_SETTINGS_INVALID, 422, problem, { firstRevealCost: this.firstRevealCost });
    }
    const settings: ListingSettings = {
      on_empty: input.onEmpty,
      debt_floor: input.debtFloor,
      max_credits_per_customer_per_day: input.maxCreditsPerCustomerPerDay,
    };
    await this.repo.put(vendorId, settings);
    return toSettingsDto(settings);
  }
}

export const listingSettingsService = new ListingSettingsService();
