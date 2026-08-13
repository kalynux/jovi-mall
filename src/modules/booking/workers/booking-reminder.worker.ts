import mongoose from 'mongoose';
import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { Booking } from '../models/booking.model';
import { BookingStatus } from '../types/booking.types';
import { BOOKING_CONFIG } from '../config/booking.config';
import { ProductModel } from '../../catalog/models';
import { CustomerModel } from '../../customers/customer.model';
import { VendorRepository } from '../../vendors/vendor.repository';
import { getCustomerNotificationHandler } from '../../notifications/customer-notification-event-consumer';
import { resolveLanguage, Language, DEFAULT_LANGUAGE } from '../../notifications/catalog/notification-i18n';

/**
 * BookingReminderWorker — tells customers their appointment is coming up.
 *
 * WHY THIS EXISTS: the platform records `no-show` against a customer who does not
 * turn up, and until now it never once told them the appointment existed after
 * they booked it. A status that costs someone their reputation has to be earned
 * against a reminder, not against silence.
 *
 * ── Why time-based and not an event ─────────────────────────────────────────
 *
 * Nothing *happens* 24 hours before an appointment. There is no state change to
 * subscribe to, so this is the one notification that must be swept for.
 *
 * ── The window, and why it is the interval ──────────────────────────────────
 *
 * Each pass covers `startAt ∈ [now + lead, now + lead + interval)`. Consecutive
 * passes tile that range exactly: no booking falls between two windows, and none
 * appears in both. A crash that skips a pass loses those reminders rather than
 * duplicating later ones — the safer failure of the two, and the idempotency key
 * catches the rest.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 *
 * `customer.booking.reminder:{bookingId}` is unique per booking, so a restart
 * mid-sweep, an overlapping pass, or a second instance of the app can all replay
 * the same window without a customer being reminded twice.
 */
export class BookingReminderWorker implements ObservableWorker {
    private interval: NodeJS.Timeout | null = null;
    private running = false;
    private sweeping = false;

    get schedules(): WorkerSchedule[] {
        return [{
            kind: 'interval',
            everyMs: BOOKING_CONFIG.reminder.intervalMs,
            source: 'BOOKING_REMINDER_INTERVAL_MS',
        }];
    }

    get scheduled(): boolean {
        return this.interval !== null;
    }

    /** `sweeping` is in-flight here; `running` means "started". See `ObservableWorker`. */
    get executing(): boolean {
        return this.sweeping;
    }

    get enabled(): boolean {
        return BOOKING_CONFIG.reminder.enabled;
    }
    private readonly vendorRepo = new VendorRepository();

    start(): void {
        if (!BOOKING_CONFIG.reminder.enabled) {
            console.log('[BookingReminderWorker] Disabled via config, not starting');
            return;
        }
        if (this.running) return;

        this.running = true;
        const { intervalMs, leadMinutes } = BOOKING_CONFIG.reminder;
        console.log(
            `[BookingReminderWorker] Starting — reminding ${leadMinutes} min ahead, sweeping every ${intervalMs / 1000}s`
        );

        void this.sweep();
        this.interval = setInterval(() => {
            if (maintenanceBlocksWorkers()) return;
            void this.sweep();
        }, intervalMs);
    }

    stop(): void {
        if (this.interval) clearInterval(this.interval);
        this.interval = null;
        this.running = false;
    }

    /**
     * One pass. Returns how many reminders were sent.
     *
     * Guarded against overlapping runs: a slow pass (many bookings × several
     * channels each) must not stack up behind the interval.
     */
    async sweep(): Promise<number> {
        if (this.sweeping) return 0;
        this.sweeping = true;

        try {
            const { leadMinutes, intervalMs, batchSize } = BOOKING_CONFIG.reminder;
            const now = Date.now();
            const windowStart = new Date(now + leadMinutes * 60_000);
            const windowEnd = new Date(now + leadMinutes * 60_000 + intervalMs);

            const due = await Booking.find({
                // Confirmed only. A `pending` booking may still be declined, and
                // reminding someone to attend something unaccepted is worse than
                // silence.
                status: BookingStatus.CONFIRMED,
                startAt: { $gte: windowStart, $lt: windowEnd },
                deletedAt: null,
            })
                .limit(batchSize)
                .select('_id userId productId vendorId startAt');

            if (due.length === 0) return 0;

            // Resolve the shared lookups once for the batch rather than per booking —
            // a busy salon's 09:00–17:00 is dozens of bookings on one product.
            const productTitles = await this.titlesByProduct(due.map(b => b.productId));
            const vendorNames = await this.namesByVendor(due.map(b => b.vendorId));

            let sent = 0;
            for (const booking of due) {
                try {
                    const customer = await CustomerModel.findOne({ user_id: booking.userId }).select(
                        '_id preferences timezone'
                    );
                    // Not a customer account (a vendor booking on their own login) —
                    // there is nobody to remind.
                    if (!customer) continue;

                    const lang = resolveLanguage(customer);

                    await getCustomerNotificationHandler().notify({
                        situation: 'booking.reminder',
                        customerId: customer._id.toString(),
                        aggregateType: 'booking',
                        aggregateId: booking._id.toString(),
                        idempotencyKey: `customer.booking.reminder:${booking._id}`,
                        context: {
                            bookingId: booking._id.toString(),
                            serviceName: productTitles.get(booking.productId.toString()) ?? '',
                            vendorName: vendorNames.get(booking.vendorId.toString()) ?? '',
                            // `startAt` is formatted in the customer's timezone by the
                            // handler; this is the human phrase in front of it.
                            whenPhrase: this.whenPhrase(booking.startAt, lang),
                            startAt: booking.startAt,
                        },
                    });
                    sent++;
                } catch (error) {
                    console.error(
                        `[BookingReminderWorker] Failed to remind for booking ${booking._id}:`,
                        error
                    );
                }
            }

            console.log(
                `[BookingReminderWorker] Window ${windowStart.toISOString()}–${windowEnd.toISOString()}: ${due.length} due, ${sent} reminded`
            );
            return sent;
        } catch (error) {
            console.error('[BookingReminderWorker] Sweep failed:', error);
            return 0;
        } finally {
            this.sweeping = false;
        }
    }

    /**
     * "tomorrow" / "today" / "soon", localized.
     *
     * A bare timestamp is exactly what a forgetful reader skims past, and this is
     * the notification whose entire job is to be noticed. Deliberately coarse —
     * the exact time follows it in the same sentence.
     */
    private whenPhrase(startAt: Date, lang: Language): string {
        const hoursAway = (startAt.getTime() - Date.now()) / 3_600_000;

        const phrases: Record<'soon' | 'today' | 'tomorrow', Record<Language, string>> = {
            soon: {
                en: 'coming up shortly',
                fr: 'dans très peu de temps',
                pt: 'já a seguir',
                es: 'muy pronto',
                ar: 'قريبًا جدًا',
            },
            today: {
                en: 'later today',
                fr: 'plus tard dans la journée',
                pt: 'ainda hoje',
                es: 'más tarde hoy',
                ar: 'لاحقًا اليوم',
            },
            tomorrow: {
                en: 'tomorrow',
                fr: 'demain',
                pt: 'amanhã',
                es: 'mañana',
                ar: 'غدًا',
            },
        };

        const key = hoursAway <= 3 ? 'soon' : hoursAway <= 18 ? 'today' : 'tomorrow';
        return phrases[key][lang] ?? phrases[key][DEFAULT_LANGUAGE];
    }

    private async titlesByProduct(
        ids: mongoose.Types.ObjectId[]
    ): Promise<Map<string, string>> {
        const unique = [...new Set(ids.map(String))];
        const rows = await ProductModel.find({ _id: { $in: unique } })
            .select('title')
            .lean();
        return new Map(rows.map(r => [String(r._id), r.title]));
    }

    private async namesByVendor(
        ids: mongoose.Types.ObjectId[]
    ): Promise<Map<string, string>> {
        const unique = [...new Set(ids.map(String))];
        const names = new Map<string, string>();
        for (const id of unique) {
            try {
                const vendor = await this.vendorRepo.findById(id);
                if (vendor?.display_name) names.set(id, vendor.display_name);
            } catch {
                // A missing vendor must not cost the reminder — the catalog falls
                // back to a generic "the provider".
            }
        }
        return names;
    }
}

export const bookingReminderWorker = new BookingReminderWorker();
