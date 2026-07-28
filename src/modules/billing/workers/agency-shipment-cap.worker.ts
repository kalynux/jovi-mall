import cron from 'node-cron';
import { eventBus } from '../../../core/events/event-bus';
import { SubscriberPlanRepository } from '../repositories/subscriber-plan.repository';
import { PricingPlanRepository } from '../repositories/pricing-plan.repository';
import { BillingSettingsRepository } from '../repositories/billing-settings.repository';
import { ShipmentRepository } from '../../shipments/shipment.repository';

/**
 * AgencyShipmentCapWorker - daily monitor of the agency "unterminated shipments"
 * SOFT cap.
 *
 * The agency plan cap never blocks a customer checkout (by product decision); it
 * is a monitoring threshold. This sweep counts each agency's unterminated
 * shipments against its active plan cap and, on crossing over, emits
 * `agency.shipment_cap.exceeded` for the notification stack. The alert is
 * debounced via `BillingSettings.shipment_cap_alerted_at` so it fires once per
 * crossing and re-arms only after the agency drops back under cap.
 */
export class AgencyShipmentCapWorker {
  private task: ReturnType<typeof cron.schedule> | null = null;

  constructor(
    private readonly planRepo: SubscriberPlanRepository = new SubscriberPlanRepository(),
    private readonly pricingRepo: PricingPlanRepository = new PricingPlanRepository(),
    private readonly settings: BillingSettingsRepository = new BillingSettingsRepository(),
    private readonly shipments: ShipmentRepository = new ShipmentRepository()
  ) {}

  /** Schedule the daily sweep (03:30 server time — just after plan-expiry). */
  start(): void {
    if (this.task) {
      console.log('[AgencyShipmentCapWorker] Already started');
      return;
    }
    this.task = cron.schedule('30 3 * * *', () => {
      void this.runSweep();
    });
    console.log('[AgencyShipmentCapWorker] Scheduled daily agency shipment-cap sweep (03:30)');
  }

  stop(): void {
    this.task?.stop();
    this.task = null;
  }

  /** Run the full sweep once. Safe to call manually (tests/ops). */
  async runSweep(now: Date = new Date()): Promise<void> {
    const activePlans = await this.planRepo.findAllActiveByOwnerType('agency');
    for (const assignment of activePlans) {
      const agencyId = assignment.owner_id.toString();
      try {
        const plan = await this.pricingRepo.findById(assignment.plan_id.toString());
        const cap = plan?.max_unterminated_shipments ?? null;
        if (cap === null) continue; // unlimited → never alerts

        const current = await this.shipments.countUnterminatedByAgency(agencyId);
        const alreadyAlerted = (await this.settings.getShipmentCapAlertedAt('agency', agencyId)) !== null;

        if (current >= cap && !alreadyAlerted) {
          await this.settings.setShipmentCapAlertedAt('agency', agencyId, now);
          await eventBus.publish('agency.shipment_cap.exceeded', {
            eventType: 'agency.shipment_cap.exceeded',
            aggregateId: agencyId,
            occurredAt: now,
            payload: {
              ownerType: 'agency',
              ownerId: agencyId,
              agencyId,
              planCode: assignment.plan_code,
              cap,
              current,
            },
          });
        } else if (current < cap && alreadyAlerted) {
          // Dropped back under cap → re-arm the alert for the next crossing.
          await this.settings.setShipmentCapAlertedAt('agency', agencyId, null);
        }
      } catch (err) {
        console.error(`[AgencyShipmentCapWorker] Failed cap check for agency ${agencyId}:`, err);
      }
    }
  }
}

export const agencyShipmentCapWorker = new AgencyShipmentCapWorker();
