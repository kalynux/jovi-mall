/**
 * Template Registry
 * 
 * NO MAGIC STRINGS!
 * 
 * All WhatsApp Business templates must be registered here.
 * Templates must be pre-approved in WhatsApp Business Manager.
 */

export interface RegisteredTemplate {
    /** Template name (as registered in WhatsApp Business Manager) */
    name: string;

    /** Template language code */
    language: string;

    /** Template category */
    category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';

    /** Expected parameter count by component */
    components?: {
        header?: number;
        body?: number;
        buttons?: number;
    };

    /** Description for internal reference */
    description: string;
}

/**
 * Template Registry
 */
export class TemplateRegistry {
    private templates: Map<string, RegisteredTemplate>;

    constructor() {
        this.templates = new Map();
        this.registerDefaultTemplates();
    }

    /**
     * Register a template
     */
    register(template: RegisteredTemplate): void {
        const key = `${template.name}_${template.language}`;
        if (this.templates.has(key)) {
            console.warn(`[TemplateRegistry] Overwriting template: ${key}`);
        }
        this.templates.set(key, template);
    }

    /**
     * Get template by name and language
     */
    get(name: string, language: string): RegisteredTemplate | undefined {
        const key = `${name}_${language}`;
        return this.templates.get(key);
    }

    /**
     * Check if template exists
     */
    has(name: string, language: string): boolean {
        const key = `${name}_${language}`;
        return this.templates.has(key);
    }

    /**
     * Get all registered templates
     */
    getAll(): RegisteredTemplate[] {
        return Array.from(this.templates.values());
    }

    /**
     * Register default templates.
     *
     * Vendor, agency and agent notification templates (UTILITY) are registered
     * for every supported language. These must be approved with the same name +
     * language in WhatsApp Business Manager — see
     * api-doc/notifications/whatsapp-templates.md, which carries the per-template
     * body copy and button suffix to create them with.
     *
     * The body param counts below MUST match each situation's `whatsapp.template.
     * bodyParams` in the notification catalogs (notification-catalog.ts,
     * agency-notification-catalog.ts, agent-notification-catalog.ts) — that is
     * what the send path actually fills in, and a mismatch is what this registry
     * exists to surface.
     */
    private registerDefaultTemplates(): void {
        // Meta language codes the notification templates are approved in.
        const languages = ['en', 'fr', 'pt_PT', 'es', 'ar'];

        // [name, body param count, has URL button, description]
        const notificationTemplates: Array<[string, number, boolean, string]> = [
            // ── Vendor ───────────────────────────────────────────────────────
            ['vendor_order_created', 3, true, 'Vendor: new order received'],
            ['vendor_order_cancelled', 1, true, 'Vendor: order cancelled'],
            ['vendor_booking_created', 3, true, 'Vendor: new booking received'],
            ['vendor_booking_cancelled', 1, true, 'Vendor: booking cancelled'],
            ['vendor_payment_partial', 2, true, 'Vendor: partial payment received'],
            ['vendor_payment_full', 2, true, 'Vendor: full payment received'],
            ['vendor_storage_alert', 3, true, 'Vendor: media storage threshold alert'],
            // Agency-warehoused stock. `storage` here means a WAREHOUSE, unlike
            // `vendor_storage_alert` above, which is the media-file quota.
            ['vendor_storage_stock_request_received', 5, true, 'Vendor: agency proposed a stock change to approve'],
            ['vendor_storage_stock_request_approved', 4, true, 'Vendor: agency approved the vendor\'s stock change'],
            ['vendor_storage_stock_request_rejected', 4, true, 'Vendor: agency rejected the vendor\'s stock change'],
            ['vendor_storage_depot_changed', 3, true, 'Vendor: storage agency moved the product to another depot'],
            ['vendor_storage_product_suspended', 3, true, 'Vendor: storage agency suspended the product'],
            ['vendor_storage_product_unsuspended', 2, true, 'Vendor: storage agency lifted the suspension'],

            // ── Agency (button base: AGENCY_APP_URL) ─────────────────────────
            ['agency_connection_request_received', 1, true, 'Agency: vendor requested a connection'],
            ['agency_connection_approved', 1, true, 'Agency: vendor approved the connection'],
            ['agency_connection_rejected', 1, true, 'Agency: vendor declined the connection'],
            ['agency_connection_reapproval_needed', 1, true, 'Agency: connection needs reapproval after a policy change'],
            ['agency_shipment_assigned', 2, true, 'Agency: new shipment dispatched to the agency'],
            ['agency_shipment_offer_accepted', 2, true, 'Agency: an agent accepted the delivery offer'],
            ['agency_shipment_assignment_unfilled', 1, true, 'Agency: no agent accepted — assign manually'],
            ['agency_payout_requested', 2, true, 'Agency: payout request created'],
            ['agency_payout_paid', 2, true, 'Agency: payout paid'],
            ['agency_payout_rejected', 2, true, 'Agency: payout request rejected'],
            ['agency_cod_deposit_declared', 4, true, 'Agency: agent declared a COD deposit awaiting confirmation'],
            ['agency_cod_deposit_direct_to_platform', 3, true, 'Agency: agent paid COD cash straight to the platform'],
            ['agency_plan_expiring', 3, true, 'Agency: plan expiring soon'],
            ['agency_plan_expired', 2, true, 'Agency: plan expired, downgraded'],
            ['agency_shipment_cap_exceeded', 3, true, 'Agency: active-shipment soft cap reached'],
            ['agency_storage_alert', 3, true, 'Agency: media storage threshold alert'],
            // Warehoused stock, not the media quota above.
            ['agency_storage_stock_request_received', 5, true, 'Agency: vendor proposed a stock change to approve'],
            ['agency_storage_stock_request_approved', 4, true, 'Agency: vendor approved the agency\'s stock change'],
            ['agency_storage_stock_request_rejected', 4, true, 'Agency: vendor rejected the agency\'s stock change'],

            // ── Agent (button base: AGENT_APP_URL) ───────────────────────────
            ['agent_cod_deposit_recorded', 3, true, 'Agent: agency recorded a cash deposit from them'],
            ['agent_cod_deposit_confirmed', 3, true, 'Agent: declared deposit confirmed'],
            ['agent_cod_deposit_rejected', 4, true, 'Agent: declared deposit rejected'],
            ['agent_shipment_offer_received', 2, true, 'Agent: new delivery offer'],
            ['agent_shipment_offer_reminder', 2, true, 'Agent: delivery offer still open (round-2 nudge)'],
            ['agent_shipment_offer_expired', 2, true, 'Agent: delivery offer expired unanswered'],
            // No button: the agent has no remaining action on a shipment that left them.
            ['agent_shipment_reassigned_away', 2, false, 'Agent: shipment reassigned to another agent'],
            ['agent_plan_expiring', 3, true, 'Agent: plan expiring soon'],
            ['agent_plan_expired', 2, true, 'Agent: plan expired, downgraded'],
            ['agent_storage_alert', 3, true, 'Agent: media storage threshold alert'],

            // Customer-facing COD delivery code — fallback for when the customer is
            // outside Meta's 24h free-form window (see DeliveryCodeService).
            // Body params: order number, delivery code, amount, currency.
            ['cod_delivery_code', 4, false, 'Customer: cash-on-delivery delivery code'],

            // ── Customer (button base: STOREFRONT_URL) ───────────────────────
            // The fourth notification stack. Param counts MUST match the
            // `bodyParams` arrays in customer-notification-catalog.ts — Meta
            // rejects a send whose parameter count differs from the approved
            // template, and the failure surfaces only at delivery time.
            ['customer_booking_created', 3, true, 'Customer: booking requested'],
            ['customer_booking_confirmed', 3, true, 'Customer: vendor accepted the booking'],
            ['customer_booking_rescheduled', 3, true, 'Customer: booking moved to a new time'],
            ['customer_booking_cancelled', 3, true, 'Customer: booking cancelled'],
            ['customer_booking_completed', 3, true, 'Customer: appointment completed and settled'],
            ['customer_booking_reminder', 3, true, 'Customer: appointment reminder'],
            ['customer_booking_payment_received', 3, true, 'Customer: booking payment received'],
            ['customer_booking_balance_due', 4, true, 'Customer: balance owed after completion'],
            ['customer_booking_refunded', 3, true, 'Customer: booking refunded'],
            ['customer_booking_refund_pending', 3, true, 'Customer: refund being sent manually'],
            ['customer_order_created', 4, true, 'Customer: order placed'],
            ['customer_order_payment_received', 3, true, 'Customer: order payment received'],
            // GAP-008 + GAP-012: the card payment page, delivered outside the service
            // window. Its URL button carries `pay/{token}`, so approve the button with a
            // dynamic URL suffix exactly as the order templates do.
            ['customer_order_payment_link', 4, true, 'Customer: a card payment page is waiting'],
            ['customer_order_shipped', 3, true, 'Customer: order on its way'],
            ['customer_order_out_for_delivery', 1, true, 'Customer: order out for delivery today'],
            ['customer_order_delivered', 1, true, 'Customer: order delivered'],
            ['customer_order_delivery_failed', 1, true, 'Customer: delivery attempt failed'],
            ['customer_order_cancelled', 1, true, 'Customer: order cancelled'],
            ['customer_order_refunded', 3, true, 'Customer: order refunded'],

            // ── Customer support requests (GAP-012) ─────────────────────────
            // The three proactive templates GAP-012 asked for by name: "a ticket
            // gets an answer next week" is outside Meta's 24-hour service window
            // by definition, so free-form text cannot carry it and these are the
            // only way the answer reaches a WhatsApp customer at all.
            //
            // ⚠ `customer_ticket_resolved` takes TWO body params. The second is a
            // whole sentence (`reopenLine`) rather than a value, because whether
            // the customer may still reply depends on resolved-vs-closed and
            // baking either wording into the approved body makes one of the two a
            // lie. Approve it with {{2}} as a free sentence.
            ['customer_ticket_replied', 1, true, 'Customer: their support request got a reply'],
            ['customer_ticket_awaiting_customer', 1, true, 'Customer: their support request is waiting on them'],
            ['customer_ticket_resolved', 2, true, 'Customer: their support request was resolved or closed']
        ];

        for (const [name, body, hasButton, description] of notificationTemplates) {
            for (const language of languages) {
                this.register({
                    name,
                    language,
                    category: 'UTILITY',
                    components: { body, buttons: hasButton ? 1 : 0 },
                    description
                });
            }
        }

        console.log(`[TemplateRegistry] Registered ${this.templates.size} template entries`);
    }
}
