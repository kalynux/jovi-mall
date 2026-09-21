import { randomBytes } from 'crypto';
import { AppError } from '../../../core/errors';
import { ERROR_CATEGORIES } from '../../../core/error-category';
import { logger } from '../../../core/logging';
import { recordError } from '../../system/metrics/metrics';
import { executePurchase } from '../../bot-surface/controllers/bot-purchase.controller';
import {
    bookingChatReceipt,
    bookingScreenCopy,
} from '../../bot-surface/domain/bot-booking-copy';
import {
    confirmBooking,
    readBookingPicker,
    readCustomerBookings,
    type BookingConfirmed,
} from '../../bot-surface/miniapp/surfaces/booking.core';
import { placeCheckout, readCheckoutView } from '../../bot-surface/miniapp/surfaces/checkout.controller';
import { readProductDetail } from '../../bot-surface/miniapp/surfaces/product-detail.read';
import { readListingPage } from '../../bot-surface/miniapp/surfaces/product-listing.read';
import { botIdempotencyStore } from '../../bot-surface/services/bot-idempotency.store';
import { inAppSurfaceStore } from '../../bot-surface/services/inapp-surface.store';
import type { FlowScreenPorts, FlowSessionKind } from './flow-screens';
import { loadFlowImage } from './screens/image-bytes';

/**
 * The real dependencies of `flow-screens.ts` — the one file that imports them.
 *
 * ⚠ **Every member is the shared export itself, passed through untouched.** Not a wrapper, not an
 * adapter with a check of its own: a port that "just adds" a rule is a second copy of that rule,
 * on the one channel nobody can open in a browser to compare. `test:whatsapp-flows` scans this
 * file for exactly that — each port must name the real export.
 *
 * ⚠ **This file cannot be imported by a suite**, and that is why it exists apart from the router.
 * `checkout.controller.ts` and `bot-purchase.controller.ts` reach `orders/` and `payments/`, which
 * do work at import that never returns under bare ts-node.
 */
export const flowScreenPorts: FlowScreenPorts = Object.freeze({
    readSession: <K extends FlowSessionKind>(kind: K, handle: string) => inAppSurfaceStore.read(kind, handle),
    extendSession: (kind: 'pl' | 'pd', handle: string) => inAppSurfaceStore.touch(kind, handle),
    readListingPage,
    readProductDetail,
    loadImage: loadFlowImage,
    readCheckoutView,
    placeCheckout,
    executePurchase,
    readBookingPicker,
    confirmBooking,
    readCustomerBookings,
    bookingWords: bookingScreenCopy,
    /**
     * ⚠ **The SCREEN gets the full receipt**, because at this moment the endpoint holds the
     * booking it has just made and the session was provably this customer's. The chat that
     * follows gets `bookingChatAcknowledgement` instead — a different sentence, not this one with
     * the details removed, which renders "Booked: , ." and was nearly shipped that way.
     */
    bookingReceipt: (confirmed: BookingConfirmed, language: string | null) => bookingChatReceipt(
        { moved: confirmed.moved, awaitingShop: confirmed.awaitingShop },
        { reference: confirmed.reference, when: confirmed.when, service: confirmed.service },
        language,
    ),
    claims: botIdempotencyStore,
    /** 12 random bytes → 16 URL-safe characters: unguessable, and inside the router's pattern. */
    newOpenRef: () => randomBytes(12).toString('base64url'),
    sleep: (ms: number) => new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    }),
    reportFailure,
});

/**
 * Count and log a failure the router answered for itself — what the global handler would have
 * done had the error reached it.
 *
 * Same split as the handler: `internal` and `external_service` are ours to chase and log at
 * `error`; anything else is a request we refused and logs at `warn`.
 */
function reportFailure(where: string, error: unknown): void {
    const category = error instanceof AppError ? error.category : ERROR_CATEGORIES.INTERNAL;
    const status = error instanceof AppError ? error.statusCode : 500;
    recordError(category, status);

    const payload = {
        scope: 'whatsapp-flows',
        where,
        category,
        status,
        code: error instanceof AppError ? error.code : null,
        ...(error instanceof Error ? { err: error } : { detail: String(error) }),
    };
    const message = `[WhatsAppFlows] ${where} failed`;

    if (category === ERROR_CATEGORIES.INTERNAL || category === ERROR_CATEGORIES.EXTERNAL_SERVICE) {
        logger().error(payload, message);
    } else {
        logger().warn(payload, message);
    }
}
