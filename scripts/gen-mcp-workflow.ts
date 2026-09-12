/*
 * gen-mcp-workflow.ts — build the `wi-mall-mcp` MCP server from `api-doc/n8n/tools/catalog.json`.
 *
 * MCP parity plan, Step 8. Fifteen tool nodes were ever hand-added to that workflow while the
 * backend grew to 46 model-facing ones, so the agent could not open an order, empty a cart or
 * reach the product catalogue at all. Hand-adding the rest makes the next 40 invisible the same
 * way; this reads the catalogue and emits every one of them.
 *
 * ── THE PROPERTY THIS FILE EXISTS FOR ────────────────────────────────────────
 * ⛔ **A `flow_only` tool is NEVER emitted.** That tier holds every money movement, every
 * destructive action, both slot-holding booking writes and all seven payment-method and address
 * writes. The tier is the only thing keeping that boundary real: a generator that ignored it
 * would hand a language model `checkout_create_orders` and `payment_initiate`. `SELECTION` below
 * is the whole rule, exported so `test:bot-surface` § 15 asserts it rather than trusting it.
 *
 * ── TWO RENDERINGS, ONE MODEL ────────────────────────────────────────────────
 *   --sdk (default)  n8n Workflow SDK source, for review and for building the server from code
 *   --ops            `update_workflow` operations, for rebuilding the LIVE workflow in place
 *
 * The second exists because no tool can apply SDK code to an existing workflow, and
 * `wi-mall-mcp` must keep its id: `wi-mall-core`'s MCP Client Tool points at the endpoint path
 * `wi-mall-customer`, and a second workflow claiming that path collides with it. Both renderings
 * walk the SAME node model, so they cannot disagree about what the server holds.
 *
 * Run:  npm run gen:mcp-workflow            # writes both files
 *       npm run gen:mcp-workflow -- --stdout
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
// 1 · Selection — which catalogue rows become MCP tools
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
const MCP_DOOR_CREDENTIAL = { id: 'bvt8A3ugMaycaW8i', name: 'wi-mall MCP door' };
const HTTP_TOOL_TYPE = 'n8n-nodes-base.httpRequestTool';
const HTTP_TOOL_VERSION = 4.5;
const REQUEST_TIMEOUT_MS = 20000;

const BOT_TOKEN_ARGUMENT =
    '$fromAI("botToken", "The sealed identity token, copied verbatim from the botToken line in your system prompt", "string")';

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

/** `{name}` in the path template becomes an inline `$fromAI` expression. */
function urlFor(tool: CatalogTool): string {
    const filled = tool.operation.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, param: string) =>
        `{{ ${fromAi(param, schemaFor(tool, param))} }}`);
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
    const fields = includeIdentity ? [`identity: { token: ${BOT_TOKEN_ARGUMENT} }`] : [];
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
             * ⛔ **`$execution.id` ALONE IS NOT UNIQUE PER TOOL CALL HERE, and the failure is
             * silent.** It is unique per turn inside `wi-mall-core`, which is where that
             * pattern came from — but on the MCP server the tool node runs as a sub-node of
             * the MCP Server Trigger, and the value demonstrably repeats across separate
             * calls. Measured on 2026-09-08: `auth_send_login_link` was called four times and
             * jovi-mall minted **one** session; the other calls hit the idempotency store and
             * were answered with the FIRST call's stored body.
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
            position: [40 + (index % 8) * 200, 328 + Math.floor(index / 8) * 200],
        });
        index++;
    }

    return nodes;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · The trigger
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_TRIGGER_NAME = 'MCP Server Trigger';
export const MCP_PATH = 'wi-mall-customer';

/**
 * The server instructions every MCP client prepends to its system prompt.
 *
 * ⚠ These describe the **sealed botToken** transport. The workflow's own description and its
 * sticky note both described an abandoned query-string design until this generator replaced
 * them; nothing on the server has ever read identity off the endpoint URL.
 */
export const MCP_INSTRUCTIONS = [
    'These tools act on ONE customer: the person currently chatting.',
    '',
    'THE IDENTITY RULE',
    '- Every customer-scoped tool takes a `botToken` argument. Copy it VERBATIM from the `botToken:` line in your system prompt.',
    '- Never invent, edit, shorten or guess a botToken. Never use one from an earlier conversation. Never show it to the customer or mention that it exists.',
    '- If a tool answers BOT_IDENTITY_TOKEN_EXPIRED or BOT_IDENTITY_TOKEN_INVALID, do NOT retry with a different value. Tell the customer to send their message again.',
    '- Never ask the customer for a phone number or account id in order to use a tool.',
    '- The catalogue tools (catalog_*) take no botToken: they read the public shop and are the same for everybody.',
    '',
    'LISTS',
    '- A list answer carries at most 5 rows. That is a hard limit: asking for more is refused, so do not try, and do not page through a list to gather more.',
    '- Every list reports `meta.total`, `meta.hasMore` and `meta.moreUrl`. When `hasMore` is true, show the rows you were given, say how many there are in total, and give the customer `meta.moreUrl` exactly as written.',
    '- NEVER invent a link. If `meta.moreUrl` is null there is no page to send them to.',
    '',
    'RULES',
    '- Never invent product data, prices, stock, order status or delivery dates. If a tool did not return it, say you do not have it.',
    '- A tool response is JSON with success, data and sometimes error.customerMessage. On failure, relay error.customerMessage in the customer\'s language rather than inventing an explanation.',
    '- Do not call a mutating tool (anything that adds, changes, cancels or sends) unless the customer has just asked for that exact action in their own words.',
].join('\n');

/** ⚠ n8n caps a workflow description at 255 characters and REFUSES the write over it. */
export const MCP_DESCRIPTION =
    'GENERATED from api-doc/n8n/tools/catalog.json by jovi-mall/scripts/gen-mcp-workflow.ts — ' +
    'edit the catalogue, not the nodes. Identity is a sealed botToken tool argument, never a ' +
    'URL. flow_only rows (money, destructive) are never emitted.';

/** The canvas note. Named so the generator can find and replace it on every run. */
export const STICKY_NAME = 'Generated — do not edit nodes by hand';

export const STICKY_CONTENT = [
    '## wi-mall MCP server — GENERATED',
    '',
    'Every tool node below is emitted by `jovi-mall/scripts/gen-mcp-workflow.ts` from',
    '`api-doc/n8n/tools/catalog.json`. **Edit the catalogue and re-run `npm run gen:mcp-workflow`;',
    'a node edited by hand is overwritten on the next run.**',
    '',
    '**Identity is a tool ARGUMENT, not a URL.** Every `/api/internal/bot/*` tool takes',
    '`botToken` as a tool argument — a sealed, signed token `wi-mall-core` puts in the system prompt.',
    'The model can echo it and cannot author one for somebody else. Nothing here has ever read',
    'identity off the endpoint query string.',
    '',
    '⛔ **`flow_only` catalogue rows are never emitted** — money movements, destructive actions,',
    'the slot-holding booking writes and every payment-method and address write. That tier is the',
    'boundary; `wi-mall-core` calls those with deterministic nodes.',
    '',
    '`neverError` is ON: a 4xx body carries `error.customerMessage` and reaches the agent instead',
    'of throwing.',
].join('\n');

// ─────────────────────────────────────────────────────────────────────────────
// 4 · Rendering — the n8n Workflow SDK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A JS literal for the SDK file.
 *
 * ⚠ `JSON.stringify` rather than a hand-rolled single-quoted literal, and that is not a
 * shortcut: every `$fromAI` argument is DOUBLE-quoted inside the expression, and the catalogue's
 * prose is full of apostrophes. Escaping by hand at two levels is where this would go wrong.
 */
function literal(value: unknown, indent: number): string {
    const pad = ' '.repeat(indent);
    if (value === undefined) return 'undefined';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) {
        if (!value.length) return '[]';
        const rows = value.map((v) => `${pad}  ${literal(v, indent + 2)}`);
        return `[\n${rows.join(',\n')}\n${pad}]`;
    }
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    const rows = entries.map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${literal(v, indent + 2)}`);
    return `{\n${rows.join(',\n')}\n${pad}}`;
}

export function renderSdk(nodes: readonly EmittedNode[]): string {
    const out: string[] = [];
    out.push("import { workflow, trigger, tool, sticky } from '@n8n/workflow-sdk';");
    out.push('');

    for (const node of nodes) {
        out.push(`const ${node.name} = tool({`);
        out.push(`  type: ${JSON.stringify(HTTP_TOOL_TYPE)},`);
        out.push(`  version: ${HTTP_TOOL_VERSION},`);
        out.push('  config: {');
        out.push(`    name: ${JSON.stringify(node.name)},`);
        out.push(`    position: ${JSON.stringify(node.position)},`);
        out.push(`    parameters: ${literal(node.parameters, 4)},`);
        if (node.credentials) out.push(`    credentials: ${literal(node.credentials, 4)},`);
        out.push('  },');
        out.push('  output: [{ success: true }],');
        out.push('});');
        out.push('');
    }

    out.push(`const mcpServerTrigger = trigger({`);
    out.push(`  type: ${JSON.stringify('@n8n/n8n-nodes-langchain.mcpTrigger')},`);
    out.push('  version: 2.1,');
    out.push('  config: {');
    out.push(`    name: ${JSON.stringify(MCP_TRIGGER_NAME)},`);
    out.push('    position: [1720, 96],');
    out.push(`    parameters: ${literal({ authentication: 'headerAuth', path: MCP_PATH, instructions: MCP_INSTRUCTIONS }, 4)},`);
    out.push(`    credentials: ${literal({ httpHeaderAuth: MCP_DOOR_CREDENTIAL }, 4)},`);
    out.push(`    subnodes: { tools: [${nodes.map((n) => n.name).join(', ')}] },`);
    out.push('  },');
    out.push('  output: [{}],');
    out.push('});');
    out.push('');
    out.push(`const generatedNote = sticky(${JSON.stringify(STICKY_CONTENT)}, [], { color: 4, height: 460, width: 460 });`);
    out.push('');
    // The SDK id stays `wi-mall-mcp`; only the DISPLAY NAME carries the `UP-` prefix the
    // instance adopted on 2026-09-07. Kept in step deliberately — this file is the review
    // artefact, and a rendering that disagrees with the live workflow's name is the kind of
    // drift nobody notices until they diff the two.
    out.push(`export default workflow('wi-mall-mcp', 'UP-wi-mall-mcp').add(mcpServerTrigger).add(generatedNote);`);
    out.push('');

    return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5 · Rendering — `update_workflow` operations, for the live workflow
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateOperation { type: string; [key: string]: unknown }

/**
 * One tool node as the LIVE workflow currently holds it. Supplied by `--existing`.
 *
 * `parameters` and `position` are optional so a caller that knows only the names still gets
 * correct add-vs-update decisions — it simply gets a full re-push of every node instead of a
 * minimal diff.
 */
export interface ExistingToolNode {
    name: string;
    parameters?: Record<string, unknown>;
    position?: [number, number];
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
 * Rebuild the tool nodes of the EXISTING workflow: drop whatever tools it holds and should not,
 * add the ones it lacks, correct the ones that have changed, and correct the trigger itself.
 *
 * `existing` is passed in rather than fetched — this script has no n8n credentials, and a
 * generator that reached out to a live service would not be runnable offline like every other
 * script here.
 *
 * ── ⛔ IT MUST DESCRIBE THE SERVER AS IT IS NOW, NOT AS IT ONCE WAS ──────────
 * This argument decides `addNode` versus `updateNodeParameters`, and both wrong answers fail
 * the whole atomic call: adding a node that exists collides on the name, updating one that does
 * not exist targets nothing.
 *
 * ⚠ **That is not hypothetical — it is what this file shipped with.** `main()` passed the
 * hardcoded `HAND_WRITTEN_NODES`, the fifteen names the workflow held *before* Step 8. It was
 * true on the day it was written and false the moment Step 8's own output was applied, so the
 * next run emitted `addNode` for thirty-one nodes that already existed. The same
 * "a guard that names its subjects in a hardcoded list WILL drift" that this plan has now hit
 * three times. Pass `--existing`; see the CLI below for how to produce it.
 *
 * ── MINIMAL DIFF, AND THE REASON IS THE 100-OP CAP ──────────────────────────
 * When `parameters`/`position` are supplied, a node whose pushed value is byte-identical to the
 * live one emits **no operation at all**. Without that, a 49-tool workflow needs ~103
 * operations and `update_workflow` accepts **100 per call** — so a full re-push has to be split
 * across calls, and a split loses the atomicity that makes this safe to run against a live
 * server. Re-running the generator with nothing changed now emits an empty tool diff, which is
 * also the property that makes it cheap to run often.
 */
export function renderOperations(
    nodes: readonly EmittedNode[],
    existing: readonly (string | ExistingToolNode)[],
    existingStickyNodes: readonly string[] = [],
): UpdateOperation[] {
    const existingNodes: ExistingToolNode[] = existing.map((e) => (typeof e === 'string' ? { name: e } : e));
    const existingToolNodes = existingNodes.map((e) => e.name);
    const liveByName = new Map(existingNodes.map((e) => [e.name, e]));
    const ops: UpdateOperation[] = [];
    const keep = new Set(nodes.map((n) => n.name));

    // ⚠ The workflow's description and its canvas note both described an abandoned
    // query-string identity design, on a server where every node has always used $fromAI.
    for (const sticky of existingStickyNodes) ops.push({ type: 'removeNode', nodeName: sticky });
    ops.push({
        type: 'addNode',
        node: {
            name: STICKY_NAME,
            type: 'n8n-nodes-base.stickyNote',
            typeVersion: 1,
            position: [2020, -420],
            parameters: { content: STICKY_CONTENT, color: 4, height: 460, width: 460 },
        },
    });
    ops.push({ type: 'setWorkflowMetadata', description: MCP_DESCRIPTION });

    for (const name of existingToolNodes) {
        if (!keep.has(name)) ops.push({ type: 'removeNode', nodeName: name });
    }

    for (const node of nodes) {
        const live = liveByName.get(node.name);
        if (live) {
            /**
             * ⚠ **Only when it actually differs.** `parameters === undefined` means the caller
             * gave names alone and cannot know — push in that case, because a missed update is
             * a tool silently running last week's description, while a redundant one costs an
             * operation out of the budget.
             */
            if (live.parameters === undefined || stable(live.parameters) !== stable(node.parameters)) {
                ops.push({ type: 'updateNodeParameters', nodeName: node.name, parameters: node.parameters, replace: true });
            }
            if (live.position === undefined || stable(live.position) !== stable(node.position)) {
                ops.push({ type: 'setNodePosition', nodeName: node.name, position: node.position });
            }
        } else {
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
                target: MCP_TRIGGER_NAME,
                connectionType: 'ai_tool',
            });
        }
    }

    ops.push({
        type: 'setNodeParameter',
        nodeName: MCP_TRIGGER_NAME,
        path: '/instructions',
        value: MCP_INSTRUCTIONS,
    });

    return ops;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6 · CLI
// ─────────────────────────────────────────────────────────────────────────────

export const OUTPUT_DIR = path.join(__dirname, '..', 'api-doc', 'n8n', 'generated');

/**
 * ⛔ **A HISTORICAL RECORD, NOT A DEFAULT ANY MORE.** These are the fifteen tool nodes
 * `wi-mall-mcp` held before Step 8 — hand-added over Steps 0–5.
 *
 * It was `main()`'s `existing` argument, and it was wrong from the instant Step 8's own output
 * was applied: the workflow then held 46, so the next run emitted `addNode` for 31 nodes that
 * already existed and the whole atomic call would have been rejected. Kept only so the first
 * apply remains reproducible from the repository, and so the next person can see what the
 * drift looked like. **Pass `--existing` instead.**
 */
export const HAND_WRITTEN_NODES: readonly string[] = [
    'cart_get', 'orders_list_groups', 'cart_add_item', 'profile_update', 'recently_viewed_list',
    'notifications_list', 'notifications_unread_count', 'notifications_mark_read',
    'reviews_list_mine', 'bookings_list', 'bookings_get_availability', 'bookings_get',
    'bookings_get_balance', 'bookings_payment_status', 'payment_methods_list',
];

/** The sticky notes the workflow held. Removed and replaced on every run. */
export const HAND_WRITTEN_STICKIES: readonly string[] = ['Sticky Note 9750b69c', STICKY_NAME];

/** n8n's own ceiling on one `update_workflow` call. A larger batch is rejected outright. */
export const MAX_OPERATIONS_PER_CALL = 100;

/**
 * The live tool nodes, as `--existing <file>` supplies them.
 *
 * The file is whatever `get_workflow_details` returned, or just its `nodes` array, or a bare
 * array of names — all three are accepted, because the useful thing is that somebody looked at
 * the server, and making them reshape the payload first is one more step to get wrong.
 */
function readExisting(file: string): { tools: ExistingToolNode[]; stickies: string[] } {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const nodes = Array.isArray(raw)
        ? raw
        : ((raw as { workflow?: { nodes?: unknown[] }; nodes?: unknown[] }).workflow?.nodes
            ?? (raw as { nodes?: unknown[] }).nodes
            ?? []);

    const named = (nodes as Array<string | Record<string, unknown>>)
        .map((n) => (typeof n === 'string' ? { name: n } : n))
        .filter((n) => typeof (n as { name?: unknown }).name === 'string') as Array<Record<string, unknown>>;

    return {
        /**
         * Tool nodes only. The trigger is deliberately excluded — treating it as a tool would
         * emit a `removeNode` for the very node every tool hangs off.
         *
         * A bare array of NAMES carries no `type`, so an untyped entry is taken as a tool: that
         * is the shape a caller supplies when they know only the names, and it is the reading
         * that makes the add-vs-update decision come out right.
         */
        tools: named
            .filter((n) => n.type === undefined || n.type === HTTP_TOOL_TYPE)
            .map((n) => ({
                name: String(n.name),
                parameters: n.parameters as Record<string, unknown> | undefined,
                position: n.position as [number, number] | undefined,
            })),
        /**
         * ⚠ **Derived, not hardcoded — the same drift that made `HAND_WRITTEN_NODES` wrong.**
         * `HAND_WRITTEN_STICKIES` names a note Step 8 already deleted, so a second run emits a
         * `removeNode` for something that is not there. `update_workflow` is atomic, so if the
         * server treats that as an error rather than a no-op it takes the whole batch with it —
         * and the batch is the only thing standing between a live agent and a half-applied
         * tool set. Reading the server's own list means never asking that question.
         */
        stickies: named
            .filter((n) => n.type === 'n8n-nodes-base.stickyNote')
            .map((n) => String(n.name)),
    };
}

function main(): void {
    const catalog = readCatalog();
    const tools = selectMcpTools(catalog);
    const nodes = buildNodes(tools);

    const existingFlag = process.argv.indexOf('--existing');
    const existingPath = existingFlag >= 0 ? process.argv[existingFlag + 1] : undefined;
    const existing = existingPath
        ? readExisting(existingPath)
        : { tools: [...HAND_WRITTEN_NODES], stickies: [...HAND_WRITTEN_STICKIES] };

    const sdk = renderSdk(nodes);
    const ops = renderOperations(nodes, existing.tools, existing.stickies);

    if (process.argv.includes('--stdout')) {
        console.log(sdk);
        return;
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const sdkPath = path.join(OUTPUT_DIR, 'wi-mall-mcp.workflow.ts');
    const opsPath = path.join(OUTPUT_DIR, 'wi-mall-mcp.ops.json');
    fs.writeFileSync(sdkPath, sdk);
    fs.writeFileSync(opsPath, `${JSON.stringify(ops, null, 2)}\n`);

    const byTier = tools.reduce<Record<string, number>>((acc, t) => {
        acc[t.tier] = (acc[t.tier] ?? 0) + 1;
        return acc;
    }, {});
    const excluded = catalog.tools.length - tools.length;

    console.log(`${nodes.length} tools emitted (${byTier.core ?? 0} core, ${byTier.extended ?? 0} extended)`);
    console.log(`${excluded} catalogue rows excluded — ${catalog.tools.filter((t) => t.tier === 'flow_only').length} of them flow_only`);
    console.log(`  ${path.relative(process.cwd(), sdkPath)}`);
    console.log(`  ${path.relative(process.cwd(), opsPath)}  (${ops.length} operations)`);

    if (!existingPath) {
        console.warn(
            '\n⛔ --existing was not given, so the operations were rendered against '
            + `HAND_WRITTEN_NODES (${HAND_WRITTEN_NODES.length} names from before Step 8).\n`
            + '   That list is a HISTORICAL RECORD and is almost certainly not what the server holds.\n'
            + '   Applying these operations will fail on the first node that already exists.\n\n'
            + '   Fetch the live workflow, save the JSON, and re-run:\n'
            + '     npm run gen:mcp-workflow -- --existing <that-file.json>',
        );
    }

    if (ops.length > MAX_OPERATIONS_PER_CALL) {
        console.warn(
            `\n⚠ ${ops.length} operations, and update_workflow accepts ${MAX_OPERATIONS_PER_CALL} per call.\n`
            + '   Splitting them across calls loses atomicity — the thing that makes this safe to run\n'
            + '   against a live server. Pass --existing so unchanged nodes emit nothing.',
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
