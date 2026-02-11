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
     * Register default templates
     * 
     * TODO: Move this to configuration or database
     */
    private registerDefaultTemplates(): void {
        // Example templates (these should be configured per environment)

        // this.register({
        //   name: 'booking_confirmation',
        //   language: 'en',
        //   category: 'UTILITY',
        //   components: {
        //     body: 3, // vendor_name, booking_date, booking_id
        //   },
        //   description: 'Booking confirmation message for vendors/customers',
        // });

        // this.register({
        //   name: 'order_status_update',
        //   language: 'en',
        //   category: 'UTILITY',
        //   components: {
        //     body: 2, // order_id, status
        //   },
        //   description: 'Order status update notification',
        //});

        // this.register({
        //   name: 'payment_confirmation',
        //   language: 'en',
        //   category: 'UTILITY',
        //   components: {
        //     body: 3, // amount, order_id, payment_method
        //   },
        //   description: 'Payment confirmation for customers',
        // });

        console.log('[TemplateRegistry] Default templates registered');
    }
}
