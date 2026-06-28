import { IVendorCancellationPolicy } from '../vendor.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export interface CancellationContext {
    /** When the order/booking was created (reference for grace-period deadlines). */
    createdAt: Date;
    /** Booking start (or delivery date) — reference for service/delivery deadlines. */
    serviceOrDeliveryAt?: Date | null;
    /** Whether the entity is still pending (not yet vendor-confirmed). */
    isPending?: boolean;
    /** Override "now" (tests). Defaults to current time. */
    now?: Date;
}

/**
 * Enforce a vendor's cancellation policy for a CUSTOMER-initiated cancellation.
 *
 * Eligibility-only: gates on the `cancellable` flag and `cancellation_deadline`.
 * No fee/refund math (that is owned by the refund flow). Throws
 * `CANCELLATION_NOT_ALLOWED` (422) when the cancellation is not permitted.
 *
 * A `null` policy means the vendor configured no restriction → always allowed.
 * Deadlines whose reference date is unavailable (e.g. a delivery date for an
 * order) fall through as allowed rather than blocking on missing data.
 */
export function assertCancellationAllowed(
    policy: IVendorCancellationPolicy | null,
    ctx: CancellationContext
): void {
    if (!policy) return; // No policy configured → no restriction.

    const now = ctx.now ?? new Date();
    const createdAt = new Date(ctx.createdAt).getTime();
    const serviceAt = ctx.serviceOrDeliveryAt ? new Date(ctx.serviceOrDeliveryAt).getTime() : null;

    const block = (reason: string): never => {
        throw createAppError(ERROR_CODES.CANCELLATION_NOT_ALLOWED, 422, reason, {
            cancellable: policy.cancellable,
            deadline: policy.cancellation_deadline,
        });
    };

    if (!policy.cancellable) {
        block('This vendor does not allow cancellations for this order/booking.');
    }

    switch (policy.cancellation_deadline) {
        case 'within_1_hour':
            if (now.getTime() > createdAt + MS_PER_HOUR) {
                block('The 1-hour cancellation window has passed.');
            }
            break;
        case 'within_24_hours':
            if (now.getTime() > createdAt + 24 * MS_PER_HOUR) {
                block('The 24-hour cancellation window has passed.');
            }
            break;
        case 'before_vendor_confirmation':
            if (ctx.isPending === false) {
                block('Cancellation is only allowed before the vendor confirms.');
            }
            break;
        case 'before_service_start':
            if (serviceAt !== null && now.getTime() >= serviceAt) {
                block('Cancellation is only allowed before the service start time.');
            }
            break;
        case 'anytime_until_days_before_delivery':
            if (serviceAt !== null) {
                const days = policy.cancellation_deadline_days ?? 0;
                if (now.getTime() > serviceAt - days * MS_PER_DAY) {
                    block(`Cancellation must be at least ${days} day(s) before the delivery/service date.`);
                }
            }
            break;
        case null:
        default:
            break; // Only the `cancellable` flag gates.
    }
}
