import { TemplateMessage, TemplateComponent } from '../../types/whatsapp-message.types';
import { InvalidMessagePayloadError, PolicyViolationError } from '../../types/whatsapp-error.types';
import { TemplateRegistry } from './template-registry';

/**
 * Template Validator
 * 
 * Component-level validation for WhatsApp templates.
 * Templates are 80% of message volume and 90% of bugs - strong validation is critical.
 */
export class TemplateValidator {
    private registry: TemplateRegistry;

    constructor() {
        this.registry = new TemplateRegistry();
    }

    /**
     * Validate template message
     */
    validate(message: TemplateMessage): void {
        // Validate template name
        if (!message.name || message.name.trim().length === 0) {
            throw new InvalidMessagePayloadError('template', [
                { field: 'name', message: 'Template name is required' },
            ]);
        }

        // Validate language
        if (!message.language || message.language.trim().length === 0) {
            throw new InvalidMessagePayloadError('template', [
                { field: 'language', message: 'Template language is required' },
            ]);
        }

        // Check if template is registered (optional, but recommended)
        if (!this.registry.has(message.name, message.language)) {
            console.warn(
                `[TemplateValidator] Template not in registry: ${message.name}_${message.language}. ` +
                `This may fail if template is not approved in WhatsApp Business Manager.`
            );
        } else {
            // Validate against registered template
            const registered = this.registry.get(message.name, message.language);
            if (registered) {
                this.validateAgainstRegistry(message, registered);
            }
        }

        // Validate components if provided
        if (message.components) {
            this.validateComponents(message.components);
        }
    }

    /**
     * Validate components structure
     */
    private validateComponents(components: TemplateComponent[]): void {
        if (!Array.isArray(components)) {
            throw new InvalidMessagePayloadError('template', [
                { field: 'components', message: 'Components must be an array' },
            ]);
        }

        for (const component of components) {
            // Validate component type
            if (!component.type) {
                throw new InvalidMessagePayloadError('template', [
                    { field: 'components.type', message: 'Component type is required' },
                ]);
            }

            const validTypes = ['header', 'body', 'button'];
            if (!validTypes.includes(component.type)) {
                throw new InvalidMessagePayloadError('template', [
                    { field: 'components.type', message: `Invalid component type: ${component.type}` },
                ]);
            }

            // Validate parameters
            if (!component.parameters || !Array.isArray(component.parameters)) {
                throw new InvalidMessagePayloadError('template', [
                    { field: 'components.parameters', message: 'Component parameters must be an array' },
                ]);
            }

            // Validate each parameter
            for (const param of component.parameters) {
                this.validateParameter(param);
            }
        }
    }

    /**
     * Validate individual parameter
     */
    private validateParameter(param: any): void {
        if (!param.type) {
            throw new InvalidMessagePayloadError('template', [
                { field: 'parameter.type', message: 'Parameter type is required' },
            ]);
        }

        const validTypes = ['text', 'currency', 'date_time', 'image', 'document', 'video'];
        if (!validTypes.includes(param.type)) {
            throw new InvalidMessagePayloadError('template', [
                { field: 'parameter.type', message: `Invalid parameter type: ${param.type}` },
            ]);
        }

        // Validate type-specific fields
        switch (param.type) {
            case 'text':
                if (!param.text) {
                    throw new InvalidMessagePayloadError('template', [
                        { field: 'parameter.text', message: 'Text parameter must have text field' },
                    ]);
                }
                break;

            case 'currency':
                if (!param.currency || !param.currency.code || !param.currency.amount_1000) {
                    throw new InvalidMessagePayloadError('template', [
                        { field: 'parameter.currency', message: 'Currency parameter must have code and amount_1000' },
                    ]);
                }
                break;

            case 'date_time':
                if (!param.date_time || !param.date_time.fallback_value) {
                    throw new InvalidMessagePayloadError('template', [
                        { field: 'parameter.date_time', message: 'DateTime parameter must have fallback_value' },
                    ]);
                }
                break;

            case 'image':
            case 'document':
            case 'video':
                if (!param[param.type] || !param[param.type].link) {
                    throw new InvalidMessagePayloadError('template', [
                        { field: `parameter.${param.type}`, message: `${param.type} parameter must have link` },
                    ]);
                }
                break;
        }
    }

    /**
     * Validate against registered template
     */
    private validateAgainstRegistry(message: TemplateMessage, registered: any): void {
        // Check parameter count if specified in registry
        if (registered.components && message.components) {
            const bodyComponent = message.components.find((c: any) => c.type === 'body');

            if (bodyComponent && registered.components.body !== undefined) {
                const actualCount = bodyComponent.parameters.length;
                const expectedCount = registered.components.body;

                if (actualCount !== expectedCount) {
                    console.warn(
                        `[TemplateValidator] Parameter count mismatch for template ${message.name}. ` +
                        `Expected ${expectedCount} body parameters, got ${actualCount}`
                    );
                }
            }
        }
    }

    /**
     * Get template registry (for registration)
     */
    getRegistry(): TemplateRegistry {
        return this.registry;
    }
}
