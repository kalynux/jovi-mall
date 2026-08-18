#!/usr/bin/env ts-node

/**
 * Simulate Vendor Notification Events (with FCM push)
 *
 * Fires real domain events through the LIVE notification pipeline:
 *   eventBus.publish(...)  →  VendorNotificationEventHandler
 *     → creates the in-app notification (MongoDB)
 *     → pushes to the vendor's registered devices via FCM
 *
 * This is end-to-end: it exercises the exact same code path a real order /
 * payment / booking would. Each run uses fresh aggregate ids so a new
 * notification (and a new push) is produced every time (idempotency won't
 * dedupe across runs).
 *
 * Requirements for a push to actually be delivered:
 *   1. The vendor must exist (and not be soft-deleted).
 *   2. The vendor's user must have at least one registered device token.
 *      Use --token=<FCM_WEB_TOKEN> to register one on the fly for testing.
 *   3. FCM must be configured (FCM_ENABLED=true + FCM_* creds in .env).
 *
 * Usage:
 *   npm run simulate:notifications
 *   npm run simulate:notifications -- --event=payment.received.full
 *   npm run simulate:notifications -- --event=all
 *   npm run simulate:notifications -- --vendor=b00000000000000000000001 --token=<FCM_TOKEN>
 *
 * Flags:
 *   --vendor=<id>   Vendor id to notify (default: b00000000000000000000001)
 *   --event=<type>  One of: order.created | order.cancelled | booking.created |
 *                   booking.cancelled | payment.received.partial |
 *                   payment.received.full | storage.alert | all
 *                   (default: order.created)
 *   --token=<tok>   Register this FCM web token for the vendor before sending
 *                   (handy for testing without the dashboard frontend)
 */

// MUST be first: loads .env before any module reads process.env at import time
// (e.g. fcm.config.ts captures FCM_* on import). Mirrors src/server.ts.
import 'dotenv/config';
import mongoose from 'mongoose';
import { eventBus, DomainEvent } from '../src/core/events/event-bus';
import { initializeVendorNotificationEventConsumers } from '../src/modules/notifications/vendor-notification-event-consumer';
import { VendorRepository } from '../src/modules/vendors/vendor.repository';
import { StoreRepository } from '../src/modules/store/repositories/store.repository';
import { DeviceTokenRepository } from '../src/modules/notifications/repositories/device-token.repository';
import { VendorNotificationModel } from '../src/modules/notifications/models/vendor-notification.model';
import { isFcmConfigured } from '../src/config/fcm.config';

const DEFAULT_VENDOR_ID = 'b00000000000000000000001';
const DEFAULT_EVENT = 'order.created';

type SimEvent = {
    /** eventBus topic */
    topic: string;
    /** the DomainEvent to publish */
    event: DomainEvent;
    /** idempotencyKey of the notification that will be created (to read it back) */
    idempotencyKey: string;
};

function arg(name: string): string | undefined {
    const found = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
    return found ? found.split('=').slice(1).join('=') : undefined;
}

const oid = () => ("f00000000000000000000016").toString();

/**
 * Build a single simulated event for the given situation.
 * Mirrors the payload shapes the real producers emit (see order.service,
 * payment-orchestrator, booking.service, StorageAlertService).
 */
function buildEvent(situation: string, vendorId: string): SimEvent {
    const now = new Date();
    const base = (payload: Record<string, any>): DomainEvent => ({
        eventType: situation,
        aggregateId: vendorId,
        payload: { vendorId, ...payload },
        occurredAt: now
    });

    switch (situation) {
        case 'order.created': {
            const orderId = oid();
            return {
                topic: 'order.created',
                event: base({ orderId, orderNumber: 'ORD-SIM-001', totalAmount: 25000, currency: 'XAF' }),
                idempotencyKey: `order.created:${orderId}:${vendorId}`
            };
        }
        case 'order.cancelled': {
            const orderId = oid();
            return {
                topic: 'order.cancelled',
                event: base({ orderId, orderNumber: 'ORD-SIM-002' }),
                idempotencyKey: `order.cancelled:${orderId}:${vendorId}`
            };
        }
        case 'booking.created': {
            const bookingId = oid();
            return {
                topic: 'booking.created',
                event: base({
                    bookingId,
                    bookingNumber: 'BkG-SIM-001',
                    serviceName: 'Studio Session',
                    startTime: new Date(Date.now() + 86400000).toISOString()
                }),
                idempotencyKey: `booking.created:${bookingId}:${vendorId}`
            };
        }
        case 'booking.cancelled': {
            const bookingId = oid();
            return {
                topic: 'booking.cancelled',
                event: base({ bookingId, bookingNumber: 'BkG-SIM-002' }),
                idempotencyKey: `booking.cancelled:${bookingId}:${vendorId}`
            };
        }
        case 'payment.received.partial': {
            const paymentId = oid();
            return {
                topic: 'payment.received.partial',
                event: base({ paymentId, orderId: oid(), amount: 10000, currency: 'XAF' }),
                idempotencyKey: `payment.received.partial:${paymentId}:${vendorId}`
            };
        }
        case 'payment.received.full': {
            const paymentId = oid();
            return {
                topic: 'payment.received.full',
                event: base({ paymentId, orderId: oid(), amount: 25000, currency: 'XAF' }),
                idempotencyKey: `payment.received.full:${paymentId}:${vendorId}`
            };
        }
        case 'storage.alert': {
            const idempotencyKey = `storage.alert:${vendorId}:90:${Date.now()}`;
            return {
                topic: 'vendor.storage.alert',
                event: base({
                    usageBytes: 9 * 1024 * 1024 * 1024,
                    limitBytes: 10 * 1024 * 1024 * 1024,
                    percentUsed: 90,
                    threshold: 90,
                    idempotencyKey
                }),
                idempotencyKey
            };
        }
        default:
            throw new Error(`Unknown event: ${situation}`);
    }
}

const ALL_EVENTS = [
    'order.created',
    'order.cancelled',
    'booking.created',
    'booking.cancelled',
    'payment.received.partial',
    'payment.received.full',
    'storage.alert'
];

async function main(): Promise<void> {
    const vendorId = arg('vendor') ?? DEFAULT_VENDOR_ID;
    const eventArg = arg('event') ?? DEFAULT_EVENT;
    const token = arg('token');

    const situations = eventArg === 'all' ? ALL_EVENTS : [eventArg];

    const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi-mall';

    console.log('\n=== Simulate Vendor Notifications ===');
    console.log(`Mongo:    ${MONGO_URI}`);
    console.log(`Vendor:   ${vendorId}`);
    console.log(`Event(s): ${situations.join(', ')}`);
    console.log(`FCM:      ${isFcmConfigured() ? 'configured (push enabled)' : 'NOT configured (push will be skipped)'}`);

    await mongoose.connect(MONGO_URI);

    // Wire up the real notification handlers (subscribes to the event bus).
    initializeVendorNotificationEventConsumers();

    // ── Pre-flight: vendor + device tokens ──────────────────────────────────
    const vendorRepo = new VendorRepository();
    const deviceRepo = new DeviceTokenRepository();

    const vendor = await vendorRepo.findById(vendorId);
    if (!vendor) {
        console.warn(
            `\n⚠️  Vendor ${vendorId} not found. The in-app notification will still be created, ` +
            `but NO push will be sent (the handler only pushes when the vendor exists).`
        );
    } else {
        // The business name lives on the Store, not the vendor profile. Read through the
        // repository; a vendor whose store is not provisioned yet prints its id.
        const store = await new StoreRepository().findByVendorIdOrNull(vendorId);
        console.log(`\nVendor found: "${store?.name ?? vendorId}" (user_id: ${vendor.user_id})`);

        if (token) {
            await deviceRepo.upsertToken(vendor.user_id.toString(), token, 'web', {
                userAgent: 'simulate-vendor-notifications script'
            });
            console.log('Registered the provided FCM token for this vendor.');
        }

        const devices = await deviceRepo.findActiveByUser(vendor.user_id.toString());
        console.log(`Registered devices for this vendor: ${devices.length}`);
        if (devices.length === 0) {
            console.warn(
                '⚠️  No device tokens registered → push has no targets. ' +
                'Pass --token=<FCM_WEB_TOKEN> to register one, or register from the dashboard.'
            );
        }
    }

    // ── Fire events ─────────────────────────────────────────────────────────
    for (const situation of situations) {
        const sim = buildEvent(situation, vendorId);
        console.log(`\n──────────────────────────────────────`);
        console.log(`Publishing "${sim.topic}" …`);
        await eventBus.publish(sim.topic, sim.event);

        // Read back what the handler created.
        const notif = await VendorNotificationModel.findOne({ idempotencyKey: sim.idempotencyKey }).lean();
        if (!notif) {
            console.warn(`  ✗ No notification created (event may be disabled in preferences).`);
            continue;
        }
        console.log(`  ✓ In-app notification created: ${notif._id}`);
        console.log(`    title:        ${notif.title}`);
        console.log(`    message:      ${notif.message}`);
        console.log(`    action:       ${notif.action ? `${notif.action.label} → ${notif.action.path}` : '(none)'}`);
        console.log(`    deliveredVia: [${notif.deliveredVia.join(', ')}]` +
            (notif.deliveredVia.includes('push') ? '  ← pushed ✅' : '  (no push)'));
        if (notif.deliveryErrors?.length) {
            for (const e of notif.deliveryErrors) {
                console.warn(`    delivery error (${e.channel}): ${e.error}`);
            }
        }
    }

    console.log('\nDone.\n');
    await mongoose.disconnect();
}

main().catch(async err => {
    console.error('Simulation failed:', err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
