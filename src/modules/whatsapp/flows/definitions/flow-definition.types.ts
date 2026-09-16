/**
 * The shape of a Flow JSON — the document uploaded to Meta's Flow Builder.
 *
 * ── WHY THESE ARE TYPESCRIPT MODULES AND NOT `.json` FILES ──────────────────
 * A Flow definition is JSON on Meta's side, so `.json` is the obvious form. It is the wrong
 * one here for two reasons this repository has already paid for:
 *
 *  1. **`tsc` emits `.js` and imported `.json` and NOTHING else.** A loose `.json` read off
 *     disk through a `__dirname`-relative path lives in `src/` and never reaches `dist/`, so
 *     `npm run dev` resolves it and `npm start` does not. That is exactly how six Handlebars
 *     mail templates were broken in every compiled deployment for months. Avoiding it means
 *     an entry in `scripts/copy-build-assets.ts`' manifest — a shared file, and one more
 *     thing to forget.
 *  2. **A definition that does not typecheck fails at PUBLISH time**, which on this platform
 *     is the most expensive place to fail: publishing is an owner decision taken once, at the
 *     end of the plan, against a live Business Account. A typed module fails in the editor
 *     instead.
 *
 * ⚠ **This type is deliberately PERMISSIVE about components.** It pins the document's
 * skeleton — version, routing model, screens, their data contracts — and lets `children` be
 * loose, because the component vocabulary is Meta's and grows with every Flow JSON version.
 * A closed union here would have to be edited before anyone could use a component Meta
 * shipped last week, and the failure it would prevent (an unknown component) is one Meta's
 * own validator catches at upload with a better message than we could write.
 */

/**
 * The Flow JSON version.
 *
 * ⚠ **Not the same thing as `data_api_version`**, and confusing them is the ordinary mistake.
 * This one describes the DOCUMENT — which components exist, what a screen may contain. The
 * other describes the PROTOCOL our endpoint speaks. They version independently and neither
 * implies the other.
 */
export type FlowJsonVersion = string;

/**
 * One field of a screen's data contract.
 *
 * ⚠ **`__example__` is REQUIRED by Meta for every declared data field**, and it is not
 * decoration: the Flow Builder preview renders from it, and — the part that matters —
 * **Meta validates the endpoint's real response against the declared types at publish
 * time**. An example that disagrees with what the endpoint actually sends is how a Flow
 * passes review and fails in front of a customer, so these are written from the same source
 * as the endpoint's projection rather than invented.
 */
export interface FlowDataField {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    __example__: unknown;
    items?: Record<string, unknown>;
    properties?: Record<string, unknown>;
}

export interface FlowScreen {
    /** ⚠ Screen ids are referenced by the routing model and by our endpoint. Keep them stable. */
    id: string;
    title: string;
    /**
     * Whether finishing here ends the Flow.
     *
     * ⚠ **At least one screen must be terminal, and SEVERAL MAY BE.** Meta's Flow JSON
     * reference: "each Flow should have a terminal state" and "Multiple screens can be marked
     * as terminal". The first version of this comment said *exactly one*, the suite and the
     * publish script enforced it, and the forms were being designed around a rule Meta doesn't
     * have. Because of it, the checkout had nowhere honest to put "you have no saved address".
     *
     * "Terminal" means the Flow closes, not that the customer has finished shopping. A browse
     * screen that hands a choice back to the chat is terminal.
     */
    terminal?: boolean;
    /** What the endpoint must supply for this screen. */
    data?: Record<string, FlowDataField>;
    layout: {
        type: 'SingleColumnLayout';
        children: Array<Record<string, unknown>>;
    };
}

export interface FlowDefinition {
    version: FlowJsonVersion;
    /**
     * Present ⇒ this Flow talks to our endpoint. Absent ⇒ it is entirely self-contained.
     *
     * ⚠ **Omitting it is what makes a Flow static**, and a static Flow cannot show live
     * prices or stock. Every definition here declares it.
     */
    data_api_version: string;
    /**
     * Which screens can reach which.
     *
     * Meta's rules, from the Flow JSON reference: **required whenever an endpoint powers the
     * Flow**; routes are forward-only; a route cannot point at its own screen; every route must
     * end at a terminal screen; at most 10 branches.
     *
     * ⚠ **Declaring every screen as a key is a HOUSE rule, not Meta's.** An earlier comment
     * here said a missing screen was "unreachable and Meta will not tell you". That was never
     * verified, and Meta's reference says only screens with forward transitions need keys.
     * The rule is kept because a complete map lets the suite check reachability locally.
     */
    routing_model: Record<string, string[]>;
    screens: FlowScreen[];
}
