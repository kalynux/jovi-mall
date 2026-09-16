import { flowIdFor } from '../../flows/flows.config';
import type { InAppSurfaceKind } from '../../../bot-surface/services/inapp-surface.store';

/**
 * Flow Registry
 *
 * WhatsApp Flows must be published before use.
 * Track all flows here to prevent sending unpublished flows.
 */

/**
 * The screens that have a Flow, and what to call each one in a log line.
 *
 * Keyed by `InAppSurfaceKind` so a Flow and the in-app screen it mirrors name the same thing.
 * `ol` and `sl` are absent because their screens are a later milestone — a Flow cannot exist
 * before the screen it mirrors.
 */
const REGISTERED_SCREEN_FLOWS: ReadonlyArray<readonly [InAppSurfaceKind, string]> = [
    ['pl', 'Product listing'],
    ['pd', 'Product detail'],
    ['co', 'Checkout'],
];

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
     * Register the flows this deployment has published.
     *
     * ⚠ **This was a compile-time map with every entry commented out, and the note above it
     * argued that a compile-time map was the stronger shape** — on the grounds that a flow id
     * is a Meta-side artefact, so naming a non-existent one should fail at review rather than
     * in front of a customer. That argument was right about the hazard and wrong about the
     * remedy, for a reason that only became visible once a second environment existed:
     * **a published Flow's id differs per environment by construction.** A Flow is published
     * against one WhatsApp Business Account, so development, staging and production cannot
     * share an id even in principle. The note named that exact condition as the trigger to
     * revisit; this is it.
     *
     * So the ids come from configuration — the same `WHATSAPP_FLOW_ID_*` variables
     * `channel-reply.ts`'s renderer is pointed at — and the two paths cannot disagree about
     * which Flow is live.
     *
     * ⚠ **`screens` is left empty deliberately, and empty means NOT ENUMERATED.** The screen
     * names live in the Flow JSON published to Meta, not here, and listing them in a second
     * place would create a copy that drifts silently the first time a screen is renamed.
     * `FlowValidator` treats an empty list as "no opinion" rather than as "no screens".
     */
    private registerDefaultFlows(): void {
        for (const [kind, name] of REGISTERED_SCREEN_FLOWS) {
            const flowId = flowIdFor(kind);
            if (!flowId) continue;

            this.register({
                flowId,
                name,
                version: '3.0',
                /**
                 * ⚠ **A configured id IS a published Flow.** `flowIdFor` only answers once the
                 * variable is set, and the variable can only be set from Meta's Flow Builder
                 * after publishing — there is no way to hold the id of an unpublished Flow.
                 */
                status: 'PUBLISHED',
                screens: [],
                description: `${name} — published Flow mirroring the in-app '${kind}' screen`,
            });
        }
    }
}
