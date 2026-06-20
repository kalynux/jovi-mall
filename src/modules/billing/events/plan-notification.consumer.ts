import { eventBus, DomainEvent } from '../../../core/events/event-bus';

/**
 * Plan lifecycle notification consumer (STUB).
 *
 * Subscribes to the expiry events emitted by PlanExpiryWorker and is the single
 * place where vendor-facing plan notifications will be dispatched.
 *
 * TODO: route these through the existing VendorNotificationEventHandler
 * (src/modules/notifications) so they land as in-app + email notifications, and
 * (credit permitting) a WhatsApp template. For now we only log, which keeps the
 * worker → event → notification seam wired without committing to the template
 * payloads yet.
 */
export function registerPlanNotificationConsumer(): void {
  eventBus.subscribe('vendor.plan.expiring', (event: DomainEvent) => {
    console.log(
      `[PlanNotification] Vendor ${event.payload.vendorId} plan '${event.payload.planCode}' expires in ` +
        `${event.payload.daysUntilExpiry} day(s) (TODO: dispatch notification)`
    );
  });

  eventBus.subscribe('vendor.plan.expired', (event: DomainEvent) => {
    const { vendorId, expiredPlanCode, handedOverToPending, newPlanCode } = event.payload;
    console.log(
      `[PlanNotification] Vendor ${vendorId} plan '${expiredPlanCode}' expired → ` +
        `${handedOverToPending ? `activated pending '${newPlanCode}'` : `downgraded to '${newPlanCode}'`} ` +
        `(TODO: dispatch notification)`
    );
  });

  console.log('[PlanNotification] Plan lifecycle notification consumer registered');
}
