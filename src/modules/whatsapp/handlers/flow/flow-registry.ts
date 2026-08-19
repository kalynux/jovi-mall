/**
 * Flow Registry
 * 
 * WhatsApp Flows must be published before use.
 * Track all flows here to prevent sending unpublished flows.
 */

export interface RegisteredFlow {
    /** Flow ID (from WhatsApp Flow Builder) */
    flowId: string;

    /** Flow name for internal reference */
    name: string;

    /** Flow version */
    version: string;

    /** Flow status */
    status: 'DRAFT' | 'PUBLISHED';

    /** Available screens in this flow */
    screens: string[];

    /** Description for internal reference */
    description: string;
}

/**
 * Flow Registry
 */
export class FlowRegistry {
    private flows: Map<string, RegisteredFlow>;

    constructor() {
        this.flows = new Map();
        this.registerDefaultFlows();
    }

    /**
     * Register a flow
     */
    register(flow: RegisteredFlow): void {
        if (this.flows.has(flow.flowId)) {
            console.warn(`[FlowRegistry] Overwriting flow: ${flow.flowId}`);
        }
        this.flows.set(flow.flowId, flow);
    }

    /**
     * Get flow by ID
     */
    get(flowId: string): RegisteredFlow | undefined {
        return this.flows.get(flowId);
    }

    /**
     * Check if flow exists and is published
     */
    isPublished(flowId: string): boolean {
        const flow = this.flows.get(flowId);
        return flow !== undefined && flow.status === 'PUBLISHED';
    }

    /**
     * Get all registered flows
     */
    getAll(): RegisteredFlow[] {
        return Array.from(this.flows.values());
    }

    /**
     * Register default flows.
     *
     * TODO(whatsapp, 2026-08-19): moving this to configuration or a database is a PRODUCT
     * decision nobody has asked for, and it is deferred on that ground rather than on effort.
     * No phase owns it.
     *
     * The registry is a compile-time map today, and for a codebase with **zero registered
     * flows** that is the stronger shape: a flow id is a Meta-side artefact that must exist
     * before it can be referenced, so a compile-time map fails at review when somebody names
     * one that does not exist, while a database row fails at send time in front of a
     * customer. Configuration only starts paying when flow ids differ per environment — i.e.
     * when there is a second environment with its own flows, which is the trigger to revisit.
     */
    private registerDefaultFlows(): void {
        // Example flows (these should be configured per environment)

        // this.register({
        //   flowId: 'YOUR_FLOW_ID',
        //   name: 'Customer Support Flow',
        //   version: '1.0',
        //   status: 'PUBLISHED',
        //   screens: ['welcome', 'help_menu', 'submit_ticket'],
        //   description: 'Customer support intake flow',
        // });

        console.log('[FlowRegistry] Default flows registered');
    }
}
