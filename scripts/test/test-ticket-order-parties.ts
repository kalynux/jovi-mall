/**
 * Test: the parties of an order follow every ticket about it (owner decision 2026-10-09).
 *
 * Follows the scripts/test convention (plain ts-node, hand-rolled asserts, no framework).
 * DB-free. Pins three kinds of thing:
 *
 *   1. the planning rule (`planOrderPartyFollowers`) — dedupe, skip existing, skip removed
 *   2. the cap exemption — order parties and administrator adds never count toward the 5
 *   3. the WIRING, by source scan — because every failure here is silent. A dropped hook
 *      leaves an agent unable to see a ticket about their own delivery, and nothing errors.
 *      In particular both outside hooks must run AFTER their commit: a follower row written
 *      for an accept that rolled back shows an agent a ticket about a delivery they never got.
 *
 * Run: npm run test:ticket-order-parties
 */
process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';
import { planOrderPartyFollowers, OrderParty } from '../../src/modules/tickets/services/ticket-order-parties.service';
import {
    CAP_EXEMPT_FOLLOWER_SOURCES,
    TICKET_FOLLOWER_SOURCES,
    TicketFollowerModel,
} from '../../src/modules/tickets/models/ticket-follower.model';
import { TicketModel } from '../../src/modules/tickets/models/ticket.model';
import { AddFollowerSchema } from '../../src/modules/tickets/validators/ticket.validator';
import { ActorRole } from '../../src/modules/tickets/types/ticket.types';
import { ERROR_CODES } from '../../src/core/error-codes';
import { DEFAULT_ERROR_MESSAGES } from '../../src/core/errors';

let passed = 0;
let failed = 0;

function assert(name: string, fn: () => boolean): void {
    let ok: boolean;
    try {
        ok = fn();
    } catch (err) {
        console.error(`  ❌ THROW: ${name} — ${(err as Error).message}`);
        failed++;
        return;
    }
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.error(`  ❌ FAIL: ${name}`);
        failed++;
    }
}

const SRC = path.join(__dirname, '../../src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const vendor: OrderParty = { userId: 'u-vendor', role: ActorRole.VENDOR };
const agencyA: OrderParty = { userId: 'u-agency-a', role: ActorRole.AGENCY };
const agencyB: OrderParty = { userId: 'u-agency-b', role: ActorRole.AGENCY };
const agent: OrderParty = { userId: 'u-agent', role: ActorRole.AGENT };

console.log('\n1. planOrderPartyFollowers');

assert('adds every party to a ticket nobody follows yet, in order', () => {
    const plan = planOrderPartyFollowers([vendor, agencyA, agencyB, agent], [], []);
    return plan.map((p) => p.userId).join() === 'u-vendor,u-agency-a,u-agency-b,u-agent';
});

assert('skips a party already following (the vendor who opened the ticket)', () => {
    const plan = planOrderPartyFollowers([vendor, agencyA, agent], ['u-vendor', 'u-customer'], []);
    return plan.map((p) => p.userId).join() === 'u-agency-a,u-agent';
});

assert('skips a party an administrator removed', () => {
    const plan = planOrderPartyFollowers([vendor, agencyA, agent], [], ['u-agency-a']);
    return plan.map((p) => p.userId).join() === 'u-vendor,u-agent';
});

assert('one row per user — a user holding two of the order roles keeps the first', () => {
    const plan = planOrderPartyFollowers([vendor, { userId: 'u-vendor', role: ActorRole.AGENCY }], [], []);
    return plan.length === 1 && plan[0].role === ActorRole.VENDOR;
});

assert('nothing to add when everyone already follows', () =>
    planOrderPartyFollowers([vendor, agent], ['u-vendor', 'u-agent'], []).length === 0);

console.log('\n2. The cap exemption');

assert('order_party and admin are exempt from the 5-user limit', () =>
    CAP_EXEMPT_FOLLOWER_SOURCES.includes('order_party') && CAP_EXEMPT_FOLLOWER_SOURCES.includes('admin'));

assert('creator and assignee still count — the limit still bounds user-driven assignment', () =>
    !CAP_EXEMPT_FOLLOWER_SOURCES.includes('creator') && !CAP_EXEMPT_FOLLOWER_SOURCES.includes('assignee'));

assert('the follower schema stores `source`, constrained to the four values, with NO default', () => {
    const p = TicketFollowerModel.schema.path('source') as any;
    return !!p
        && JSON.stringify(p.enumValues) === JSON.stringify([...TICKET_FOLLOWER_SOURCES])
        && p.defaultValue === undefined;
});

assert('the cap query excludes exempt sources with $nin (so a pre-2026-10-09 row, no source, still counts)', () => {
    const repo = read('modules/tickets/repositories/ticket-follower.repository.ts');
    return /source:\s*\{\s*\$nin:\s*\[\.\.\.CAP_EXEMPT_FOLLOWER_SOURCES\]\s*\}/.test(repo)
        && !repo.includes('getDistinctNonAdminUserIds');
});

console.log('\n3. Administrator removals stick');

assert('the ticket schema carries removed_follower_user_ids', () =>
    !!TicketModel.schema.path('removed_follower_user_ids'));

assert('removeFollower records the removal; addFollowerByAdmin lifts it', () => {
    const svc = read('modules/tickets/services/ticket-follower.service.ts');
    return svc.includes('this.ticketRepo.markFollowerRemoved(ticketId, userIdToRemove)')
        && svc.includes('this.ticketRepo.clearFollowerRemoved(ticketId, userId)');
});

console.log('\n4. The administrator add path');

assert('AddFollowerSchema accepts a platform role', () =>
    AddFollowerSchema.safeParse({ userId: 'a'.repeat(24), role: 'agent' }).success);

assert('AddFollowerSchema refuses role "admin" — administrators are not followers', () =>
    !AddFollowerSchema.safeParse({ userId: 'a'.repeat(24), role: 'admin' }).success);

assert('AddFollowerSchema refuses a non-hex id and an unknown key', () =>
    !AddFollowerSchema.safeParse({ userId: 'nope', role: 'agent' }).success
    && !AddFollowerSchema.safeParse({ userId: 'a'.repeat(24), role: 'agent', extra: 1 }).success);

assert('the controller validates, goes through addFollowerByAdmin, and answers with data', () => {
    const ctl = read('modules/tickets/controllers/ticket.controller.ts');
    const body = ctl.slice(ctl.indexOf('static addFollower'), ctl.indexOf('static removeFollower'));
    return body.includes('AddFollowerSchema.parse(req.body)')
        && body.includes('followerService.addFollowerByAdmin(')
        && /data:\s*enriched/.test(body);
});

assert('addFollowerByAdmin checks the ticket, the user and the role, and writes source "admin"', () => {
    const svc = read('modules/tickets/services/ticket-follower.service.ts');
    const body = svc.slice(svc.indexOf('async addFollowerByAdmin'), svc.indexOf('async removeFollower'));
    return body.includes('ERROR_CODES.TICKET_NOT_FOUND')
        && body.includes('ERROR_CODES.USER_NOT_FOUND')
        && body.includes('ERROR_CODES.TICKET_FOLLOWER_ROLE_MISMATCH')
        && body.includes("source: 'admin'");
});

assert('TICKET_FOLLOWER_ROLE_MISMATCH is registered with a default message', () =>
    ERROR_CODES.TICKET_FOLLOWER_ROLE_MISMATCH === 'TICKET_FOLLOWER_ROLE_MISMATCH'
    && typeof DEFAULT_ERROR_MESSAGES[ERROR_CODES.TICKET_FOLLOWER_ROLE_MISMATCH] === 'string');

console.log('\n5. Wiring (source scans)');

assert('createTicket adds the order parties, best-effort (inside a try)', () => {
    const svc = read('modules/tickets/services/ticket.service.ts');
    const body = svc.slice(svc.indexOf('async createTicket('), svc.indexOf('async updateStatus('));
    const call = body.indexOf('ticketOrderPartiesService.addToTicket(ticket)');
    return call > 0 && body.lastIndexOf('try {', call) > body.indexOf("source: 'creator'");
});

assert('reopenTicket re-syncs the order', () => {
    const svc = read('modules/tickets/services/ticket.service.ts');
    const body = svc.slice(svc.indexOf('async reopenTicket('), svc.indexOf('async updateTicket('));
    return body.includes('ticketOrderPartiesService.syncOrder(orderId)');
});

assert('the assignee keeps counting toward the limit (source "assignee")', () =>
    read('modules/tickets/services/ticket.service.ts').includes("{ source: 'assignee', silent: true }"));

assert('an agent accepting syncs AFTER the accept transaction commits', () => {
    const svc = read('modules/shipment-assignment/domain/services/shipment-assignment.service.ts');
    const start = svc.indexOf('async accept(');
    const postCommit = svc.indexOf('// ── Post-commit, best-effort', start);
    const call = svc.indexOf("syncTicketFollowersForOrder(offer.order_id.toString(), 'shipment-assignment.accept')", start);
    return start > 0 && postCommit > start && call > postCommit;
});

assert('a change of agency syncs AFTER the move transaction commits', () => {
    const svc = read('modules/orders/vendor-order.service.ts');
    const start = svc.indexOf('async moveItemsToAgency(');
    const afterCommit = svc.indexOf('for (const effect of outcome.afterCommit)', start);
    const call = svc.indexOf("syncTicketFollowersForOrder(orderId, 'vendor-order.move-items-to-agency')", start);
    return start > 0 && afterCommit > start && call > afterCommit;
});

assert('agent binding has ONE write path — the accept hook covers every agent assignment', () => {
    const callers = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return callers(p);
        if (!p.endsWith('.ts')) return [];
        return /\.(bindAgentIfUnassigned|assignAgent)\(/.test(fs.readFileSync(p, 'utf8')) ? [p] : [];
    });
    const found = callers(path.join(SRC, 'modules'));
    return found.length === 1 && found[0].endsWith('shipment-assignment.service.ts');
});

assert('the outside hook never throws — it swallows and logs', () => {
    const svc = read('modules/tickets/services/ticket-order-parties.service.ts');
    const body = svc.slice(svc.indexOf('export function syncTicketFollowersForOrder'));
    return body.includes('void ticketOrderPartiesService.syncOrder(orderId).catch(');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
