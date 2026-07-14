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
     * Vendor notification templates (UTILITY) are registered for every supported
     * language. These must be approved with the same name + language in WhatsApp
     * Business Manager — see api-doc/notifications/whatsapp-templates.md.
     */
    private registerDefaultTemplates(): void {
        // Meta language codes the notification templates are approved in.
        const languages = ['en', 'fr', 'pt_PT', 'es', 'ar'];

        // [name, body param count, has URL button, description]
        const notificationTemplates: Array<[string, number, boolean, string]> = [
            ['vendor_order_created', 3, true, 'Vendor: new order received'],
            ['vendor_order_cancelled', 1, true, 'Vendor: order cancelled'],
            ['vendor_booking_created', 3, true, 'Vendor: new booking received'],
            ['vendor_booking_cancelled', 1, true, 'Vendor: booking cancelled'],
            ['vendor_payment_partial', 2, true, 'Vendor: partial payment received'],
            ['vendor_payment_full', 2, true, 'Vendor: full payment received'],
            ['vendor_storage_alert', 3, true, 'Vendor: media storage threshold alert'],
            // Customer-facing COD delivery code — fallback for when the customer is
            // outside Meta's 24h free-form window (see DeliveryCodeService).
            // Body params: order number, delivery code, amount, currency.
            ['cod_delivery_code', 4, false, 'Customer: cash-on-delivery delivery code']
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
