import { ObservableWorker, WorkerSchedule } from '../../../core/jobs/worker-schedule';
import { withWorkerLock, SWEEP_SKIPPED } from '../../../core/jobs/worker-lock';
import { maintenanceBlocksWorkers } from '../../system/services/maintenance.service';
import { CartModel, ICartItem } from '../models/cart.model';
import { CART_CONFIG } from '../config/cart.config';
import { ProductModel, ProductVariantModel } from '../../catalog/models';
import { CustomerModel } from '../../customers/customer.model';
import { connectionService } from '../../channel-connections';
import { getCustomerNotificationHandler } from '../../notifications/customer-notification-event-consumer';
import { resolveLanguage } from '../../notifications/catalog/notification-i18n';
import { cartItemSummary } from '../../notifications/catalog/customer-notification-catalog';

/**
 * AbandonedCartWorker — one reminder, `CART_REMINDER_LEAD_MINUTES` after a basket was last
 * touched.
 *
 * Nothing *happens* when a basket is abandoned — the absence of an event is the event — so,
 * like the booking reminder, this is swept rather than subscribed.
 *
 * ── The window ──────────────────────────────────────────────────────────────
 * Each pass covers `updatedAt ∈ [now − lead − interval, now − lead)`. Consecutive passes tile
 * that range: no basket falls between two windows and none appears in both. A skipped pass
 * loses reminders rather than duplicating them — the safer failure.
 *
 * ── Idempotency is per basket STATE, not per basket ─────────────────────────
 * `customer.cart.abandoned:<cartId>:<updatedAt ms>`. ⚠ The stamp is load-bearing: a bare
 * `<cartId>` would silence the reminder for good after one send, so a customer who abandons,
 * comes back, adds two things and abandons again would never hear about the second basket.
 *
 * ── How checkout cancels it: it deletes the basket ──────────────────────────
 * Creating orders clears the cart, and an empty basket cannot match the sweep. **No
 * cancellation flag, and none should be added**: a flag is a second source of truth about
 * whether a basket exists.
 *
 * ── Who is reminded ─────────────────────────────────────────────────────────
 * A customer with a CHAT connection (Telegram or WhatsApp) — the plan's scope: the reminder
 * exists for baskets built in the bot. A storefront-only customer is not written to. Delivery
 * itself is the ordinary notification path: the `cartReminders` preference, one secondary
 * channel, and on WhatsApp nothing at all outside the 24-hour window (no template exists).
 *
 * ── A basket of dead lines is not reminded ──────────────────────────────────
 * A line is buyable when its product and variant are both `active` (the gate `addToCart` and
 * the price resolver apply) and it has stock (or oversell, or is digital). A basket with no
 * buyable line is skipped: its button would lead to a dead end. Only buyable lines are named.
 */
export class AbandonedCartWorker implements ObservableWorker {
    private interval: NodeJS.Timeout | null = null;
    private running = false;
    private sweeping = false;

    get schedules(): WorkerSchedule[] {
        return [{
            kind: 'interval',
            everyMs: CART_CONFIG.reminder.intervalMs,
            source: 'CART_REMINDER_INTERVAL_MS',
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
        return CART_CONFIG.reminder.enabled;
    }

    start(): void {
        if (!CART_CONFIG.reminder.enabled) {
            console.log('[AbandonedCartWorker] Disabled via config (CART_REMINDER_ENABLED), not starting');
            return;
        }
        if (this.running) return;

        this.running = true;
        const { intervalMs, leadMinutes } = CART_CONFIG.reminder;
        console.log(
            `[AbandonedCartWorker] Starting — reminding ${leadMinutes} min after a basket goes quiet, sweeping every ${intervalMs / 1000}s`
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
     * One pass. Returns how many reminders were sent; `null` when the cross-instance lock
     * refused the pass (a different statement from `0`, "nothing was due").
     */
    async sweep(): Promise<number | null> {
        const sent = await withWorkerLock('abandoned-cart', () => this.sweepDue());
        return sent === SWEEP_SKIPPED ? null : sent;
    }

    private async sweepDue(): Promise<number> {
        this.sweeping = true;

        try {
            const { leadMinutes, intervalMs, batchSize } = CART_CONFIG.reminder;
            const now = Date.now();
            const windowEnd = new Date(now - leadMinutes * 60_000);
            const windowStart = new Date(windowEnd.getTime() - intervalMs);

            const due = await CartModel.find({
                updatedAt: { $gte: windowStart, $lt: windowEnd },
                'items.0': { $exists: true },
            })
                .limit(batchSize)
                .select('_id userId items updatedAt')
                .lean();

            if (due.length === 0) return 0;

            let sent = 0;
            for (const cart of due) {
                try {
                    if (await this.remind(cart as unknown as DueCart)) sent++;
                } catch (error) {
                    console.error(`[AbandonedCartWorker] Failed to remind for cart ${cart._id}:`, error);
                }
            }

            console.log(
                `[AbandonedCartWorker] Window ${windowStart.toISOString()}–${windowEnd.toISOString()}: ${due.length} due, ${sent} reminded`
            );
            return sent;
        } catch (error) {
            console.error('[AbandonedCartWorker] Sweep failed:', error);
            return 0;
        } finally {
            this.sweeping = false;
        }
    }

    /** One basket. `true` when a reminder was raised. */
    private async remind(cart: DueCart): Promise<boolean> {
        const customer = await CustomerModel.findOne({ user_id: cart.userId }).select('_id user_id preferences');
        if (!customer) return false;

        const connections = await connectionService.getConnectionMap(customer.user_id);
        if (!connections.telegram && !connections.whatsapp) return false;

        const titles = await buyableTitles(cart.items);
        if (titles.length === 0) return false;

        await getCustomerNotificationHandler().notify({
            situation: 'cart.abandoned',
            customerId: customer._id.toString(),
            aggregateType: 'cart',
            aggregateId: cart._id.toString(),
            idempotencyKey: `customer.cart.abandoned:${cart._id}:${new Date(cart.updatedAt).getTime()}`,
            context: { itemSummary: cartItemSummary(titles, resolveLanguage(customer)) },
        });
        return true;
    }
}

interface DueCart {
    _id: { toString(): string };
    userId: string;
    items: ICartItem[];
    updatedAt: Date;
}

/**
 * The titles of the lines a customer could still buy, in basket order, one per product.
 * Exported for the suite; pure over its two lookups.
 */
export async function buyableTitles(items: ICartItem[]): Promise<string[]> {
    if (items.length === 0) return [];
    const [products, variants] = await Promise.all([
        ProductModel.find({ _id: { $in: items.map(i => i.productId) } }).select('_id status').lean(),
        ProductVariantModel.find({ _id: { $in: items.map(i => i.variantId) } })
            .select('_id status stock allow_oversell').lean(),
    ]);
    return buyableTitlesFrom(items, products, variants);
}

export function buyableTitlesFrom(
    items: ICartItem[],
    products: Array<{ _id: unknown; status?: string }>,
    variants: Array<{ _id: unknown; status?: string; stock?: number; allow_oversell?: boolean }>,
): string[] {
    const activeProducts = new Set(products.filter(p => p.status === 'active').map(p => String(p._id)));
    const variantById = new Map(variants.map(v => [String(v._id), v]));
    const titles: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        const variant = variantById.get(String(item.variantId));
        const buyable = activeProducts.has(String(item.productId))
            && variant?.status === 'active'
            && (item.productType === 'digital' || (variant.stock ?? 0) > 0 || variant.allow_oversell === true);
        if (!buyable || seen.has(String(item.productId))) continue;
        seen.add(String(item.productId));
        titles.push(item.title);
    }
    return titles;
}

export const abandonedCartWorker = new AbandonedCartWorker();
