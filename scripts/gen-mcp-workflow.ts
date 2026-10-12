/*
 * gen-mcp-workflow.ts — build the customer agent's tool nodes from `api-doc/n8n/tools/catalog.json`.
 *
 * ── ⚠ THE NAME IS HISTORICAL. THIS NO LONGER BUILDS AN MCP SERVER ────────────
 * Until 2026-10-12 this file emitted the `wi-mall-mcp` workflow — an MCP server in n8n that
 * `wi-mall-core`'s agent reached through an MCP Client Tool. It now emits the same tool nodes
 * INTO `wi-mall-core`, attached to the `AI Agent` node directly. The file, the npm binding and
 * `selectMcpTools` keep their names because four suites and several records import or cite them.
 *
 * ── WHY THE TOOLS MOVED ──────────────────────────────────────────────────────
 * n8n's MCP Server Trigger gives a connected tool node no per-request context, so on that
 * transport the customer's identity had to travel THROUGH THE MODEL, as a sealed `botToken`
 * argument. The token could not be forged — but nothing tied it to the conversation presenting
 * it. A valid token that reached another customer's chat worked there for its whole 2–3 hour
 * life, and the only barriers were two sentences in a prompt.
 *
 * A tool node inside `wi-mall-core` can read the flow's own data, so the identity is now an
 * EXPRESSION the model cannot reach (`FLOW_IDENTITY` below) — the rule every other node in that
 * workflow already followed. There is no `botToken` argument on any tool, and nothing for a
 * prompt to protect. `test:bot-surface` § 15 asserts no emitted node asks the model for one.
 *
 * ⚠ What the move does NOT change: the model sees exactly the tools it saw before. An MCP
 * client hands the agent every tool on the server as its own tool, so the count the model
 * chooses among is the same on both transports.
 *
 * ── THE PROPERTY THIS FILE EXISTS FOR ────────────────────────────────────────
 * ⛔ **A `flow_only` tool is NEVER emitted.** That tier holds every money movement, every
 * destructive action, both slot-holding booking writes and all seven payment-method and address
 * writes. The tier is the only thing keeping that boundary real: a generator that ignored it
 * would hand a language model `checkout_create_orders` and `payment_initiate`. `isModelFacing`
 * below is the whole rule, exported so `test:bot-surface` § 15 asserts it rather than trusting it.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────
 *   wi-mall-core-tools.nodes.json   every node as it should be, for review
 *   wi-mall-core-tools.ops.json     `update_workflow` operations against the LIVE `wi-mall-core`
 *
 * Operations rather than a workflow file, because `wi-mall-core` is hand-built around these
 * nodes: only the tool nodes are generated, and nothing else in that workflow may be touched.
 *
 * Run:  npm run gen:mcp-workflow -- --existing <get_workflow_details of wi-mall-core>.json
 */
import * as fs from 'fs';
import * as path from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// The catalogue, as much of it as this generator reads
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogParameter {
    type?: string | string[];
    enum?: unknown[];
    description?: string;
    minimum?: number;
    maximum?: number;
    maxLength?: number;
    pattern?: string;
    default?: unknown;
    format?: string;
}

export interface CatalogTool {
    name: string;
    tier: 'core' | 'extended' | 'flow_only';
    status: string;
    surface: string;
    description: string;
    when_to_use: string;
    when_not_to_use?: string;
    operation: { method: string; path: string };
    parameters: { properties?: Record<string, CatalogParameter>; required?: string[] };
    request?: { path?: string[]; query?: string[]; body?: string[] };
    mutating: boolean;
    platform_notes?: { whatsapp?: string; telegram?: string };
}

export interface Catalog { tools: CatalogTool[] }

export const CATALOG_PATH = path.join(__dirname, '..', 'api-doc', 'n8n', 'tools', 'catalog.json');

export function readCatalog(file: string = CATALOG_PATH): Catalog {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Catalog;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · Selection — which catalogue rows become agent tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⛔ **The exclusion boundary. Read the reasons before widening any of them.**
 *
 *   - `flow_only` — the tier means "called by a deterministic flow step, never registered with
 *     the model", and it holds every money movement and every destructive action. This is the
 *     one rule the whole generator exists to keep.
 *   - `webhook_command` / `payment_public` surfaces — bot slash-commands and the three
 *     deliberately-unauthenticated payment routes. `wi-mall-core` calls those with plain
 *     `httpRequest` nodes before the agent runs; they are flow plumbing, not tools. (Every
 *     `payment_public` row is `flow_only` too, so this clause is belt and braces.)
 *   - `identity_*` — the same: `wi-mall-core` syncs the identity and drives onboarding itself,
 *     deterministically, before a model sees the turn.
 *   - `status !== 'available'` — a `gap` row describes a route that does not exist.
 */
export function isModelFacing(tool: CatalogTool): boolean {
    if (tool.tier === 'flow_only') return false;
    if (tool.surface === 'webhook_command' || tool.surface === 'payment_public') return false;
    if (tool.name.startsWith('identity_')) return false;
    return tool.status === 'available';
}

export function selectMcpTools(catalog: Catalog): CatalogTool[] {
    return catalog.tools.filter(isModelFacing);
}

/**
 * ⚠ **`page` and `limit` are never handed to the model**, on any tool, and that is Step 0's
 * decision rather than an oversight here.
 *
 * A chat answer carries at most five rows and reports `meta.hasMore` and `meta.moreUrl`; the way
 * out of a long list is that link, not a second page. Offering `page` invites exactly the
 * behaviour the MCP trigger's own instructions forbid — "do not page through a list to gather
 * more" — and offering `limit` lets a model ask for fewer than the cap for no reason. The
 * fifteen hand-written nodes omitted both, on every list tool; this keeps that true by
 * construction.
 */
export const NEVER_MODEL_FACING_PARAMS: ReadonlySet<string> = new Set(['page', 'limit']);

// ─────────────────────────────────────────────────────────────────────────────
// 2 · The node model — one entry per emitted tool
// ─────────────────────────────────────────────────────────────────────────────

/** The proven shape, copied from a live node rather than invented. */
const BEARER_CREDENTIAL = { id: 'lz5ivIop9DF8mPHa', name: 'jovi-mall-Bearer Auth account' };
export const HTTP_TOOL_TYPE = 'n8n-nodes-base.httpRequestTool';
const HTTP_TOOL_VERSION = 4.5;
const REQUEST_TIMEOUT_MS = 20000;

/**
 * ⛔ **WHO THE CUSTOMER IS — read from the flow, never asked of the model.**
 *
 * `Inbound` is `wi-mall-core`'s trigger node: the envelope a channel adapter built from the
 * WhatsApp or Telegram webhook itself. It is the same five fields, from the same node, that
 * `sync identity`, `product action` and every other deterministic call in that workflow send —
 * so a tool call and the turn it belongs to cannot disagree about who is talking.
 *
 * `.first()`, not `.item`: a tool node is a sub-node of the agent and has no paired item of its
 * own. `Show-Products` and `open_negotiation` read `Inbound` the same way.
 *
 * ⚠ **There must be no `$fromAI` anywhere in this expression.** One would put the identity back
 * in the model's hands, which is the whole defect this replaced. `test:bot-surface` § 15 scans
 * every emitted body for it.
 */
export const FLOW_IDENTITY =
    "{ channel: $('Inbound').first().json.channel, externalId: $('Inbound').first().json.externalId, "
    + "displayName: $('Inbound').first().json.displayName, handle: $('Inbound').first().json.handle, "
    + "language: $('Inbound').first().json.language }";

/**
 * Where the generated nodes sit on `wi-mall-core`'s canvas: one block, below everything
 * hand-built (the workflow's own nodes end at y = 2496, measured 2026-10-12). Positions are
 * emitted only when a node is ADDED — an operator who drags the block somewhere tidier must not
 * have it snap back on the next run.
 */
const GRID_ORIGIN: readonly [number, number] = [1600, 2760];
const GRID_COLUMNS = 12;
const GRID_STEP: readonly [number, number] = [220, 200];

export interface EmittedNode {
    name: string;
    tool: CatalogTool;
    parameters: Record<string, unknown>;
    credentials?: Record<string, { id: string; name: string }>;
    position: [number, number];
}

/**
 * The `$fromAI` type argument. The catalogue writes JSON Schema types; n8n takes three.
 * A union type (`['string','null']`, which `addresses_update` uses) is a `flow_only` shape and
 * cannot reach here, but degrade to `string` rather than emitting something n8n will not parse.
 */
function fromAiType(schema: CatalogParameter): 'string' | 'number' | 'boolean' {
    const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    if (t === 'integer' || t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    return 'string';
}

/**
 * The sentence the model reads for one argument.
 *
 * The catalogue's own `description` is the whole of it where there is one; the constraints are
 * appended because they are the difference between a model guessing a value and being told the
 * closed set. Nothing is invented — an enum, a bound and a 24-hex pattern are the schema
 * restated, in the words the schema already carries.
 */
export function describeParameter(name: string, schema: CatalogParameter): string {
    const parts: string[] = [];
    if (schema.description) parts.push(schema.description.trim());
    if (schema.enum && schema.enum.length) parts.push(`One of: ${schema.enum.join(', ')}.`);
    if (schema.format === 'date-time' && !/ISO-8601/i.test(parts.join(' '))) parts.push('ISO-8601.');
    if (typeof schema.maximum === 'number' && typeof schema.minimum === 'number') {
        parts.push(`Between ${schema.minimum} and ${schema.maximum}.`);
    }
    if (schema.maxLength) parts.push(`At most ${schema.maxLength} characters.`);
    if (schema.pattern === '^[a-f0-9]{24}$' && !parts.join(' ').includes('24-character')) {
        parts.push('A 24-character hexadecimal id.');
    }
    if (!parts.length) {
        // A generator that quietly emits an undescribed argument is a model guessing at it.
        throw new Error(
            `catalog.json: parameter \`${name}\` has neither a description nor an enum. ` +
            'Give it one — an undescribed $fromAI argument is a value the model invents.',
        );
    }
    return parts.join(' ');
}

/** A double-quoted JS string literal, for use INSIDE an n8n `{{ }}` expression. */
function quoted(text: string): string {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;
}

function fromAi(name: string, schema: CatalogParameter): string {
    return `$fromAI(${quoted(name)}, ${quoted(describeParameter(name, schema))}, ${quoted(fromAiType(schema))})`;
}

/** The tool's own blurb, composed from the four catalogue fields that carry the traps. */
export function composeToolDescription(tool: CatalogTool): string {
    const parts = [tool.description.trim(), `USE IT WHEN: ${tool.when_to_use.trim()}`];
    if (tool.when_not_to_use) parts.push(`NOT THIS TOOL: ${tool.when_not_to_use.trim()}`);
    // ⚠ The whatsapp note is where the safeguards live — `awaitingVendorApproval` not `status`,
    // `publiclyVisible` not `status`, `expired` rather than comparing dates, `slotId` is opaque.
    // Dropping it to save tokens drops those.
    if (tool.platform_notes?.whatsapp) parts.push(`⚠ ${tool.platform_notes.whatsapp.trim()}`);
    return parts.join(' ');
}

function schemaFor(tool: CatalogTool, param: string): CatalogParameter {
    const schema = tool.parameters.properties?.[param];
    if (!schema) {
        throw new Error(
            `catalog.json: \`${tool.name}\` maps \`${param}\` onto the wire in \`request\`, but ` +
            '`parameters.properties` does not declare it. The model has to supply it, so it needs a schema.',
        );
    }
    return schema;
}

/**
 * A model-supplied value on its way into a URL PATH — one segment, and never more than one.
 *
 * ⛔ **A path argument used to be interpolated RAW, and that quietly undid the `flow_only`
 * boundary this file exists to keep** (found 2026-10-12). The value is whatever the model
 * writes, so an "order id" of `<order>/cancel?x=` turned `orders_record_cancellation_reason`
 * into `POST /orders/<order>/cancel` — a `flow_only` route, with a body that route accepts and
 * no confirmation tap — and `../../negotiation/context` walked out of `/api/internal/bot`
 * altogether, carrying the service token. The tier filter decides which NODES exist; it says
 * nothing about where a node's request lands once the model chooses part of its path.
 *
 * Two steps, and the second is not redundant:
 *
 *   1. `encodeURIComponent` — `/`, `?`, `#`, `\` and `%` stop being URL syntax. Express decodes
 *      the segment back into the one route parameter, so a real id, an order number, a slug or
 *      a SKU containing a space arrives exactly as before.
 *   2. A value that is EMPTY or ONLY DOTS becomes `_`. `encodeURIComponent` leaves `.` alone,
 *      and a URL parser collapses a `..` segment whether or not anything else is encoded:
 *      `cart_remove_item` with a variant id of `..` was `DELETE /cart`, which is `cart_clear`.
 *      An empty one drops the segment the same way (`POST /tickets/` is `tickets_create`).
 *      `_` matches no id on this platform, so the call answers the ordinary not-found.
 *
 * ⚠ `test:bot-surface` § 15 EVALUATES the emitted expression against hostile values and parses
 * the result as a URL, rather than scanning for the word `encodeURIComponent` — a wrapper that
 * is present and wrong passes a scan.
 */
export function pathArgument(call: string): string {
    return `encodeURIComponent(String(${call}).trim()).replace(/^\\.*$/, "_")`;
}

/** `{name}` in the path template becomes an inline, path-safe `$fromAI` expression. */
function urlFor(tool: CatalogTool): string {
    const filled = tool.operation.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, param: string) =>
        `{{ ${pathArgument(fromAi(param, schemaFor(tool, param)))} }}`);
    return `={{ $env.JOVI_MALL_BASE_URL }}${filled}`;
}

/**
 * A `JSON.stringify({...})` expression over the model-supplied fields.
 *
 * ⚠ An optional argument is emitted as `… || undefined`, which `JSON.stringify` then drops, so
 * an argument the model did not supply is absent rather than sent as null. That also means a
 * FALSY supplied value is dropped — `false`, `0`, `''` — which is correct for every optional
 * argument on this surface (`unreadOnly: false` is the default; `minPrice: 0` filters nothing)
 * and is the behaviour the hand-written nodes already had. A required argument is emitted bare.
 */
function jsonExpression(tool: CatalogTool, params: string[], includeIdentity: boolean): string {
    const required = new Set(tool.parameters.required ?? []);
    const fields = includeIdentity ? [`identity: ${FLOW_IDENTITY}`] : [];
    for (const param of params) {
        if (NEVER_MODEL_FACING_PARAMS.has(param)) continue;
        const call = fromAi(param, schemaFor(tool, param));
        fields.push(`${param}: ${required.has(param) ? call : `${call} || undefined`}`);
    }
    return `={{ JSON.stringify({ ${fields.join(', ')} }) }}`;
}

export function buildNodes(tools: readonly CatalogTool[]): EmittedNode[] {
    const nodes: EmittedNode[] = [];
    let index = 0;

    for (const tool of tools) {
        const wire = tool.request ?? {};
        const parameters: Record<string, unknown> = {
            toolDescription: composeToolDescription(tool),
            method: tool.operation.method,
            url: urlFor(tool),
        };

        if (tool.surface === 'bot_internal') {
            parameters.authentication = 'genericCredentialType';
            parameters.genericAuthType = 'httpBearerAuth';
            parameters.sendHeaders = true;
            const headers = [{ name: 'X-Webhook-Secret', value: '={{ $env.BOT_WEBHOOK_SECRET }}' }];
            /**
             * ⚠ The surface REFUSES a mutating call without one.
             *
             * ⛔ **`$execution.id` ALONE IS NOT UNIQUE PER TOOL CALL, and the failure is
             * silent.** Inside `wi-mall-core` it is one value for the whole turn, so a model
             * that calls one tool twice in a turn would send the same key twice. (On the old
             * MCP server it was worse — the value repeated across separate turns. Measured on
             * 2026-09-08: `auth_send_login_link` was called four times and jovi-mall minted
             * **one** session; the other calls hit the idempotency store and were answered
             * with the FIRST call's stored body.)
             *
             * That is invisible to the model, and specifically so: `replay()` announces itself
             * with an `Idempotency-Replayed: true` **response header**, and the n8n HTTP node
             * surfaces only the body. So the model reads `{ sent: true }`, tells the customer
             * their link is on the way, and nothing was sent. The same mechanism silently
             * swallows a second `cart_add_item`, `wishlist_add` or `tickets_add_note` in the
             * same session.
             *
             * The millisecond makes it per-call. That deliberately gives up "a network retry
             * is free" — which was never reachable anyway, because `neverError: true` means
             * these nodes do not throw and n8n never retries them. What a model does when it
             * calls a tool twice is send TWO requests, not retry one, and the key now says so.
             * Rate limits, not this header, are what bound a loop.
             */
            if (tool.mutating) {
                headers.push({
                    name: 'Idempotency-Key',
                    value: `={{ $execution.id }}-{{ $now.toMillis() }}-${tool.name}`,
                });
            }
            parameters.headerParameters = { parameters: headers };
            // Always a body, even on DELETE: `bot-identity.middleware.ts` reads the identity
            // envelope out of `req.body` on every route on this surface, without exception.
            parameters.sendBody = true;
            parameters.specifyBody = 'json';
            parameters.jsonBody = jsonExpression(tool, wire.body ?? [], true);
        } else if ((wire.query ?? []).some((p) => !NEVER_MODEL_FACING_PARAMS.has(p))) {
            // `public` reads carry no identity, no bearer and no webhook secret — they are the
            // storefront's own unauthenticated catalogue.
            parameters.sendQuery = true;
            parameters.specifyQuery = 'json';
            parameters.jsonQuery = jsonExpression(tool, wire.query ?? [], false);
        }

        parameters.options = {
            response: { response: { neverError: true } },
            timeout: REQUEST_TIMEOUT_MS,
        };

        nodes.push({
            name: tool.name,
            tool,
            parameters,
            credentials: tool.surface === 'bot_internal' ? { httpBearerAuth: BEARER_CREDENTIAL } : undefined,
            position: [
                GRID_ORIGIN[0] + (index % GRID_COLUMNS) * GRID_STEP[0],
                GRID_ORIGIN[1] + Math.floor(index / GRID_COLUMNS) * GRID_STEP[1],
            ],
        });
        index++;
    }

    return nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Rendering — `update_workflow` operations against the live `wi-mall-core`
// ─────────────────────────────────────────────────────────────────────────────

/** The node every generated tool hangs off, in `wi-mall-core`. */
export const AGENT_NODE_NAME = 'AI Agent';

export interface UpdateOperation { type: string; [key: string]: unknown }

/** One node of the LIVE workflow, as `--existing` supplies it. */
export interface ExistingNode {
    name: string;
    type?: string;
    parameters?: Record<string, unknown>;
}

/**
 * A deterministic serialisation, for comparing what we would push against what is already
 * there. Keys are sorted at every level, because the value coming back from n8n has been
 * through its own storage and its key order is not ours to rely on.
 */
function stable(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

/**
 * Bring `wi-mall-core`'s generated tool nodes in line with the catalogue: add the ones it
 * lacks, correct the ones that changed, remove the ones that should no longer be there.
 *
 * ── ⛔ IT OWNS THE GENERATED NODES AND NOTHING ELSE ──────────────────────────
 * `wi-mall-core` is hand-built — ninety-odd nodes of identity sync, onboarding, commands, taps
 * and the send loop — and several of its own nodes are agent tools too (`Search-Products`,
 * `Show-Products`, `open_negotiation`, the two website readers). So "which nodes are mine" is
 * the question this function must never get wrong, and the answer is narrow on purpose:
 *
 *     an HTTP Request Tool node whose NAME is a tool in catalog.json
 *
 * Both halves are needed. The type alone would claim the two website readers; the name alone
 * would claim a hand-built node that happens to share a catalogue name. Anything else is left
 * exactly as it is — this emits no workflow metadata, no sticky note, and nothing for the agent
 * node itself.
 *
 * ⚠ **A name that is already taken by a node of ANOTHER type is refused, not overwritten.**
 * `addNode` would collide on it and fail the whole atomic call; the catalogue row is what is
 * wrong, and it should say so here rather than at the n8n API.
 *
 * ── `existing` MUST DESCRIBE THE WORKFLOW AS IT IS NOW ───────────────────────
 * It decides `addNode` versus `updateNodeParameters`, and both wrong answers fail the call:
 * adding a node that exists collides on the name, updating one that does not targets nothing.
 * It is passed in rather than fetched — this script holds no n8n credentials, and a generator
 * that reached out to a live service would not be runnable offline like every other one here.
 * A node whose pushed parameters are byte-identical to the live ones emits no operation at all,
 * so re-running with nothing changed emits an empty list.
 */
export function renderOperations(
    nodes: readonly EmittedNode[],
    existing: readonly ExistingNode[],
    catalogueToolNames: ReadonlySet<string>,
): UpdateOperation[] {
    const liveByName = new Map(existing.map((e) => [e.name, e]));
    const keep = new Set(nodes.map((n) => n.name));
    const ops: UpdateOperation[] = [];

    for (const live of existing) {
        const mine = live.type === HTTP_TOOL_TYPE && catalogueToolNames.has(live.name);
        if (mine && !keep.has(live.name)) ops.push({ type: 'removeNode', nodeName: live.name });
    }

    for (const node of nodes) {
        const live = liveByName.get(node.name);

        if (live && live.type !== HTTP_TOOL_TYPE) {
            throw new Error(
                `wi-mall-core already holds a node named \`${node.name}\` of type ${live.type ?? 'unknown'}. `
                + 'A generated tool cannot take that name — rename the catalogue row or the node.',
            );
        }

        if (live) {
            if (live.parameters === undefined || stable(live.parameters) !== stable(node.parameters)) {
                ops.push({ type: 'updateNodeParameters', nodeName: node.name, parameters: node.parameters, replace: true });
            }
            continue;
        }

        ops.push({
            type: 'addNode',
            node: {
                name: node.name,
                type: HTTP_TOOL_TYPE,
                typeVersion: HTTP_TOOL_VERSION,
                position: node.position,
                parameters: node.parameters,
                credentials: node.credentials,
            },
        });
        ops.push({
            type: 'addConnection',
            source: node.name,
            target: AGENT_NODE_NAME,
            connectionType: 'ai_tool',
        });
    }

    return ops;
}

/** n8n's own ceiling on one `update_workflow` call. A larger batch is rejected outright. */
export const MAX_OPERATIONS_PER_CALL = 100;

/**
 * Split the operations into calls n8n will accept.
 *
 * ⚠ **Several calls are safe here ONLY because `update_workflow` writes the DRAFT.** Each call
 * is atomic; the set of them is not — and that does not matter, because the agent runs the
 * PUBLISHED version until `publish_workflow` is called, once, after every batch has landed and
 * the draft has been checked. Never publish between batches.
 *
 * An even batch size, so a node and the connection that attaches it are never in two calls.
 */
export function batchOperations(ops: readonly UpdateOperation[]): UpdateOperation[][] {
    const size = MAX_OPERATIONS_PER_CALL - (MAX_OPERATIONS_PER_CALL % 2);
    const batches: UpdateOperation[][] = [];
    for (let i = 0; i < ops.length; i += size) batches.push(ops.slice(i, i + size));
    return batches;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4 · CLI
// ─────────────────────────────────────────────────────────────────────────────

export const OUTPUT_DIR = path.join(__dirname, '..', 'api-doc', 'n8n', 'generated');

/**
 * The live workflow's nodes, as `--existing <file>` supplies them: whatever
 * `get_workflow_details` returned for `wi-mall-core`, or just its `nodes` array.
 */
function readExisting(file: string): ExistingNode[] {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const nodes = Array.isArray(raw)
        ? raw
        : ((raw as { workflow?: { nodes?: unknown[] }; nodes?: unknown[] }).workflow?.nodes
            ?? (raw as { nodes?: unknown[] }).nodes
            ?? []);

    return (nodes as Array<Record<string, unknown>>)
        .filter((n) => typeof n?.name === 'string')
        .map((n) => ({
            name: String(n.name),
            type: typeof n.type === 'string' ? n.type : undefined,
            parameters: n.parameters as Record<string, unknown> | undefined,
        }));
}

function main(): void {
    const catalog = readCatalog();
    const tools = selectMcpTools(catalog);
    const nodes = buildNodes(tools);

    const existingFlag = process.argv.indexOf('--existing');
    const existingPath = existingFlag >= 0 ? process.argv[existingFlag + 1] : undefined;
    const existing = existingPath ? readExisting(existingPath) : [];

    const ops = renderOperations(nodes, existing, new Set(catalog.tools.map((t) => t.name)));
    const batches = batchOperations(ops);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const nodesPath = path.join(OUTPUT_DIR, 'wi-mall-core-tools.nodes.json');
    const opsPath = path.join(OUTPUT_DIR, 'wi-mall-core-tools.ops.json');
    const review = nodes.map((n) => ({
        name: n.name,
        type: HTTP_TOOL_TYPE,
        typeVersion: HTTP_TOOL_VERSION,
        parameters: n.parameters,
        credentials: n.credentials,
    }));
    fs.writeFileSync(nodesPath, `${JSON.stringify(review, null, 2)}\n`);
    fs.writeFileSync(opsPath, `${JSON.stringify(batches, null, 2)}\n`);

    const byTier = tools.reduce<Record<string, number>>((acc, t) => {
        acc[t.tier] = (acc[t.tier] ?? 0) + 1;
        return acc;
    }, {});
    const excluded = catalog.tools.length - tools.length;

    console.log(`${nodes.length} tools emitted (${byTier.core ?? 0} core, ${byTier.extended ?? 0} extended)`);
    console.log(`${excluded} catalogue rows excluded — ${catalog.tools.filter((t) => t.tier === 'flow_only').length} of them flow_only`);
    console.log(`  ${path.relative(process.cwd(), nodesPath)}`);
    console.log(`  ${path.relative(process.cwd(), opsPath)}  (${ops.length} operations, ${batches.length} call${batches.length === 1 ? '' : 's'})`);

    if (!existingPath) {
        console.warn(
            '\n⛔ --existing was not given, so every tool was rendered as a NEW node.\n'
            + '   Applying that to a workflow that already holds them fails on the first name.\n\n'
            + '   Fetch the live wi-mall-core (get_workflow_details), save the JSON, and re-run:\n'
            + '     npm run gen:mcp-workflow -- --existing <that-file.json>',
        );
    }

    if (batches.length > 1) {
        console.warn(
            `\n⚠ ${ops.length} operations need ${batches.length} update_workflow calls.\n`
            + '   That is safe ONLY because each call writes the draft: apply every batch, check the\n'
            + '   draft, then publish ONCE. Never publish between batches.',
        );
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`gen:mcp-workflow refused: ${(error as Error).message}`);
        process.exit(1);
    }
}
