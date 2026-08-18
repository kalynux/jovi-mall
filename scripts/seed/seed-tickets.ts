/**
 * Seed: Ticket System Test Data (linked to seed-orders.js)
 *
 * This seeder does NOT create its own user accounts. Instead it reuses the SAME
 * fixed-ObjectId users created by `seed-orders.js` (vendor, customers alice/bob/
 * carol, agency, agents) so that every ticket, follower, note and attachment shows
 * up inside those existing accounts. Tickets are also linked to the REAL orders and
 * products from that script (e.g. the delivered order, the refunded order, the
 * revoked digital entitlement).
 *
 * One exception: `seed-orders.js` has no ADMIN user, and the ticket module needs
 * one (assignment, admin exclusivity, private notes). So this script creates a
 * single admin — fixed IDs `a0…99 / b0…99`, login `admin@jovitest.cm` — with a
 * real bcrypt password so it can actually log in.
 *
 * PREREQUISITE: run `seed-orders.js` first so the referenced users/orders exist.
 *   mongosh "mongodb://localhost:27017/jovi_mall" seed-orders.js
 *
 * Run:
 *   npx ts-node scripts/seed/seed-tickets.ts          # wipe ticket data + reseed
 *   npx ts-node scripts/seed/seed-tickets.ts --clean  # wipe ticket data only
 *
 * Idempotent: it wipes the four ticket collections (owned solely by this module),
 * the admin it created, and its seed files — then re-inserts. Order/user data from
 * seed-orders.js is never touched.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

import { UserModel } from '../../src/modules/users/user.model';
import { AdminModel } from '../../src/modules/admins/admin.model';
import { FileModel } from '../../src/modules/catalog/models/file.model';

import { TicketModel } from '../../src/modules/tickets/models/ticket.model';
import { TicketFollowerModel } from '../../src/modules/tickets/models/ticket-follower.model';
import { TicketNoteModel } from '../../src/modules/tickets/models/ticket-note.model';
import { TicketAttachmentModel } from '../../src/modules/tickets/models/ticket-attachment.model';
import {
    TicketType,
    TicketStatus,
    TicketPriority,
    TicketImportance,
    ActorRole,
    EntityType,
    NoteVisibility,
} from '../../src/modules/tickets/types/ticket.types';

dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/jovi_mall';
const SEED_FILE_PREFIX = 'seed/tickets/';
const ADMIN_PASSWORD = 'Password123!';
const oid = (hex: string) => new mongoose.Types.ObjectId(hex);
const ObjectId = mongoose.Types.ObjectId;

// Same date base as seed-orders.js so timelines line up.
const now = new Date('2026-05-14T10:00:00.000Z');
const d = (offsetDays: number) => new Date(now.getTime() + offsetDays * 86400000);

const log = (msg: string) => console.log(msg);

// ─────────────────────────────────────────────────────────────────────────────
// Actor registry — fixed IDs mirrored from seed-orders.js (+ a new admin)
// userId  = users._id   |   entityId = role-entity _id (vendors/customers/.../admins)
// ─────────────────────────────────────────────────────────────────────────────
interface Actor {
    key: string;
    userId: mongoose.Types.ObjectId;
    entityId: mongoose.Types.ObjectId;
    role: ActorRole;
    label: string;
}

const ACTORS = {
    // From seed-orders.js (do NOT recreate these)
    vendor: { key: 'vendor', userId: oid('a00000000000000000000001'), entityId: oid('b00000000000000000000001'), role: ActorRole.VENDOR, label: 'TechStyle (vendor)' },
    alice: { key: 'alice', userId: oid('a00000000000000000000002'), entityId: oid('b00000000000000000000002'), role: ActorRole.CUSTOMER, label: 'Alice Mbarga (customer)' },
    bob: { key: 'bob', userId: oid('a00000000000000000000003'), entityId: oid('b00000000000000000000003'), role: ActorRole.CUSTOMER, label: 'Bob Nkeng (customer)' },
    carol: { key: 'carol', userId: oid('a00000000000000000000004'), entityId: oid('b00000000000000000000004'), role: ActorRole.CUSTOMER, label: 'Carol Tagne (customer)' },
    agency: { key: 'agency', userId: oid('a00000000000000000000005'), entityId: oid('b00000000000000000000005'), role: ActorRole.AGENCY, label: 'Express Delivery (agency)' },
    agent1: { key: 'agent1', userId: oid('a00000000000000000000006'), entityId: oid('b00000000000000000000006'), role: ActorRole.AGENT, label: 'Pierre Ekang (agent)' },
    agent2: { key: 'agent2', userId: oid('a00000000000000000000007'), entityId: oid('b00000000000000000000007'), role: ActorRole.AGENT, label: 'Samuel Biya (agent)' },
    // NEW admin (seed-orders.js has none) — created by this script
    admin: { key: 'admin', userId: oid('a00000000000000000000099'), entityId: oid('b00000000000000000000099'), role: ActorRole.ADMIN, label: 'Support Admin' },
} satisfies Record<string, Actor>;

// Real entity references from seed-orders.js (used as ticket.entity_id strings)
const REF = {
    // Orders
    ord3_failedPayment: 'f00000000000000000000003',
    ord6_inTransit: 'f00000000000000000000006',
    ord7_delivered: 'f00000000000000000000007',
    ord9_cancelledAfterPaid: 'f00000000000000000000009',
    ord10_refunded: 'f00000000000000000000010',
    ord13_revokedEntitlement: 'f00000000000000000000013',
    // Shipment
    ship3_inTransit: '1f0000000000000000000003',
    // Products
    prodTshirt: 'c00000000000000000000001',
    prodHeadphones: 'c00000000000000000000002',
};

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup — wipe ticket collections + the admin this script owns + seed files
// (Order/user data from seed-orders.js is left untouched.)
// ─────────────────────────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
    log('\n🧹 Cleaning previous ticket data...');

    const f = await TicketFollowerModel.deleteMany({});
    // Notes are append-only at the model layer (pre-delete hook throws), so delete
    // via the native collection driver to bypass that middleware during teardown.
    const n = await TicketNoteModel.collection.deleteMany({});
    const a = await TicketAttachmentModel.deleteMany({});
    const t = await TicketModel.deleteMany({});

    // Remove only the admin this script created (fixed IDs).
    await AdminModel.deleteMany({ user_id: ACTORS.admin.userId });
    await UserModel.deleteMany({ _id: ACTORS.admin.userId });

    const files = await FileModel.deleteMany({ key: { $regex: `^${SEED_FILE_PREFIX}` } });

    log(`   removed ${t.deletedCount} tickets, ${f.deletedCount} followers, ${n.deletedCount} notes, ${a.deletedCount} attachments`);
    log(`   removed seed admin + ${files.deletedCount} seed files`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verify the seed-orders.js users exist; create the admin.
// ─────────────────────────────────────────────────────────────────────────────
async function ensureAdminAndCheckRefs(): Promise<void> {
    const vendorExists = await UserModel.exists({ _id: ACTORS.vendor.userId });
    if (!vendorExists) {
        log('\n⚠️  WARNING: seed-orders.js users were not found in this database.');
        log('   Run it first:  mongosh "' + MONGO_URI + '" seed-orders.js');
        log('   Tickets will still be inserted, but they will reference users/orders that do not exist yet.\n');
    } else {
        log('\n✅ Found seed-orders.js users — tickets will attach to those accounts.');
    }

    log('👤 Creating admin user (not present in seed-orders.js)...');
    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await UserModel.create({
        _id: ACTORS.admin.userId,
        login_email: 'admin@jovitest.cm',
        password_hash: passwordHash,
        roles: ['admin'],
        status: 'active',
        created_at: d(-90),
        updated_at: d(-1),
    });
    await AdminModel.create({
        _id: ACTORS.admin.entityId,
        user_id: ACTORS.admin.userId,
        name: 'Support Admin',
        email: 'admin@jovitest.cm',
        created_at: d(-90),
        updated_at: d(-1),
    });
    log(`   admin  user=${ACTORS.admin.userId}  entity=${ACTORS.admin.entityId}  (admin@jovitest.cm / ${ADMIN_PASSWORD})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Files (for attachments)
// ─────────────────────────────────────────────────────────────────────────────
async function seedFile(name: string, mime: string, size: number, owner: Actor) {
    return FileModel.create({
        key: `${SEED_FILE_PREFIX}${new ObjectId().toString()}-${name}`,
        provider: 'local',
        mimeType: mime,
        size,
        originalName: name,
        ownerType: owner.role,
        ownerId: owner.userId,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket factory
// ─────────────────────────────────────────────────────────────────────────────
interface NoteSpec {
    author: Actor;
    content: string;
    visibility?: NoteVisibility;
    isSystem?: boolean;
    visibleTo?: Actor[];
}
interface AttachmentSpec {
    uploader: Actor;
    name: string;
    mime: string;
    size: number;
    visibility?: 'PUBLIC' | 'PRIVATE';
    visibleTo?: Actor[];
}
interface TicketSpec {
    subject: string;
    description: string;
    type: TicketType;
    status: TicketStatus;
    priority: TicketPriority;
    importance: TicketImportance;
    entityType: EntityType;
    entityId: string;
    creator: Actor;
    assignedToRole?: ActorRole;
    assignedTo?: Actor | null;
    assignedAdmin?: Actor;
    priorityLockedBy?: Actor;
    followers?: Actor[];
    notes?: NoteSpec[];
    attachments?: AttachmentSpec[];
    daysAgo?: number;
}

let ticketCount = 0;

async function createTicket(spec: TicketSpec) {
    ticketCount++;
    const createdAt = d(-(spec.daysAgo ?? 0));

    const followerActors = new Map<string, Actor>();
    followerActors.set(spec.creator.userId.toString(), spec.creator);
    if (spec.assignedTo) followerActors.set(spec.assignedTo.userId.toString(), spec.assignedTo);
    for (const f of spec.followers ?? []) followerActors.set(f.userId.toString(), f);

    const ticket = await TicketModel.create({
        subject: spec.subject,
        description: spec.description,
        type: spec.type,
        status: spec.status,
        priority: spec.priority,
        importance: spec.importance,
        priority_locked: !!spec.priorityLockedBy,
        priority_locked_by: spec.priorityLockedBy?.userId,
        priority_locked_at: spec.priorityLockedBy ? createdAt : undefined,
        entity_type: spec.entityType,
        entity_id: spec.entityId,
        created_by_role: spec.creator.role,
        created_by_user_id: spec.creator.userId,
        assigned_to_role: spec.assignedToRole ?? (spec.assignedTo ? spec.assignedTo.role : undefined),
        assigned_to_user_id: spec.assignedTo ? spec.assignedTo.userId : undefined,
        assigned_admin_id: spec.assignedAdmin ? spec.assignedAdmin.entityId : undefined,
        updated_by: [...followerActors.values()].map((a) => a.userId),
        createdAt,
        updatedAt: createdAt,
    });

    for (const actor of followerActors.values()) {
        await TicketFollowerModel.create({
            ticket_id: ticket._id,
            user_id: actor.userId,
            role: actor.role,
            is_admin: actor.role === ActorRole.ADMIN,
            added_by_user_id: spec.creator.userId,
            added_at: createdAt,
        });
    }

    for (const note of spec.notes ?? []) {
        const visibility = note.isSystem ? NoteVisibility.PUBLIC : note.visibility ?? NoteVisibility.PUBLIC;
        let visibleTo: mongoose.Types.ObjectId[] = [];
        if (visibility === NoteVisibility.PRIVATE) {
            const ids = new Set<string>();
            ids.add(note.author.userId.toString());
            for (const v of note.visibleTo ?? []) ids.add(v.userId.toString());
            for (const a of followerActors.values()) if (a.role === ActorRole.ADMIN) ids.add(a.userId.toString());
            visibleTo = [...ids].map((id) => new ObjectId(id));
        }
        await TicketNoteModel.create({
            ticket_id: ticket._id,
            author_user_id: note.author.userId,
            author_role: note.author.role,
            content: note.content,
            visibility,
            is_system_note: !!note.isSystem,
            visible_to_user_ids: visibleTo,
            created_at: createdAt,
        });
    }

    for (const att of spec.attachments ?? []) {
        const file = await seedFile(att.name, att.mime, att.size, att.uploader);
        await TicketAttachmentModel.create({
            ticket_id: ticket._id,
            uploaded_by_user_id: att.uploader.userId,
            uploaded_by_role: att.uploader.role,
            file_id: file._id,
            file_name: att.name,
            file_size: att.size,
            mime_type: att.mime,
            visibility: att.visibility ?? 'PUBLIC',
            visible_to_user_ids: (att.visibleTo ?? []).map((a) => a.userId),
            created_at: createdAt,
        });
    }

    log(`   [${String(ticketCount).padStart(2, '0')}] ${ticket._id}  ${spec.status.padEnd(11)} ${spec.priority.padEnd(7)} ${spec.creator.key.padEnd(7)} ${spec.type}`);
    return ticket;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tickets — owned by seed-orders.js accounts, linked to real orders/products
// ─────────────────────────────────────────────────────────────────────────────
async function seedTickets(): Promise<void> {
    log('\n🎫 Creating tickets...');
    const { vendor, alice, bob, carol, agency, agent2, admin } = ACTORS;

    // 1. OPEN / NORMAL — Alice, damaged item on her DELIVERED order (ORD-7)
    await createTicket({
        subject: 'Item arrived damaged',
        description: 'The t-shirt from my delivered order ORD-2026-000007 had a torn seam.',
        type: TicketType.ORDER_ISSUE,
        status: TicketStatus.OPEN,
        priority: TicketPriority.NORMAL,
        importance: TicketImportance.MEDIUM,
        entityType: EntityType.ORDER,
        entityId: REF.ord7_delivered,
        creator: alice,
        daysAgo: 1,
        notes: [{ author: alice, content: 'Attaching a photo of the torn seam.' }],
        attachments: [{ uploader: alice, name: 'torn-seam.jpg', mime: 'image/jpeg', size: 245_120 }],
    });

    // 2. IN_PROGRESS / HIGH — Carol, failed payment on ORD-3, locked to admin
    await createTicket({
        subject: 'My payment keeps failing',
        description: 'I tried to pay for ORD-2026-000003 but it failed twice. Funds are available.',
        type: TicketType.PAYMENT_FAILED,
        status: TicketStatus.IN_PROGRESS,
        priority: TicketPriority.HIGH,
        importance: TicketImportance.HIGH,
        entityType: EntityType.ORDER,
        entityId: REF.ord3_failedPayment,
        creator: carol,
        assignedTo: admin,
        assignedAdmin: admin,
        priorityLockedBy: admin,
        daysAgo: 3,
        followers: [admin],
        notes: [
            { author: admin, content: 'Status changed from "open" to "in_progress"', isSystem: true },
            { author: admin, content: 'Priority changed from "normal" to "high" and locked by admin', isSystem: true },
            { author: admin, content: 'Gateway shows a 3-D Secure timeout. Asked customer to retry on card.', visibility: NoteVisibility.PRIVATE },
            { author: carol, content: 'Okay, I will try again with my card.' },
        ],
    });

    // 3. WAITING / URGENT — Vendor, missing payout, admin pool
    await createTicket({
        subject: 'May payout has not arrived',
        description: 'My May settlement is overdue. Expected ~XAF 200,000 across recent orders.',
        type: TicketType.PAYOUT_DELAY,
        status: TicketStatus.WAITING_ON_ADMIN,
        priority: TicketPriority.URGENT,
        importance: TicketImportance.CRITICAL,
        entityType: EntityType.VENDOR,
        entityId: vendor.entityId.toString(),
        creator: vendor,
        assignedToRole: ActorRole.ADMIN,
        priorityLockedBy: admin,
        daysAgo: 5,
        followers: [admin],
        notes: [
            { author: admin, content: 'Assigned to admin pool', isSystem: true },
            { author: admin, content: 'Escalated to finance, awaiting the payout batch run.', visibility: NoteVisibility.PRIVATE },
        ],
        attachments: [{ uploader: vendor, name: 'payout-statement.pdf', mime: 'application/pdf', size: 88_300, visibility: 'PRIVATE', visibleTo: [admin] }],
    });

    // 4. RESOLVED / HIGH — Alice, refund on the REFUNDED order (ORD-10)
    await createTicket({
        subject: 'Confirming my refund for ORD-2026-000010',
        description: 'I returned the damaged t-shirts. Just confirming the XAF 30,000 refund.',
        type: TicketType.ORDER_REFUND,
        status: TicketStatus.RESOLVED,
        priority: TicketPriority.HIGH,
        importance: TicketImportance.HIGH,
        entityType: EntityType.ORDER,
        entityId: REF.ord10_refunded,
        creator: alice,
        assignedTo: admin,
        priorityLockedBy: admin,
        daysAgo: 4,
        followers: [admin, vendor],
        notes: [
            { author: admin, content: 'Refund of XAF 30,000 completed via MyCoolPay (ref MCP-REFUND-ORD10-001).' },
            { author: alice, content: 'Received it, thank you!' },
            { author: admin, content: 'Status changed from "in_progress" to "resolved"', isSystem: true },
        ],
    });

    // 5. CLOSED / LOW — Bob, profile update question, closed by creator
    await createTicket({
        subject: 'How do I change my account email?',
        description: 'I would like to update the email on my account.',
        type: TicketType.PROFILE_UPDATE,
        status: TicketStatus.CLOSED,
        priority: TicketPriority.LOW,
        importance: TicketImportance.LOW,
        entityType: EntityType.USER,
        entityId: bob.userId.toString(),
        creator: bob,
        daysAgo: 14,
        notes: [
            { author: admin, content: 'You can change it under Settings → Account.' },
            { author: bob, content: 'Got it, thanks!' },
            { author: bob, content: 'Ticket closed', isSystem: true },
        ],
    });

    // 6. OPEN / HIGH — Carol, delivery stuck on her IN-TRANSIT order (ORD-6 / ship3)
    await createTicket({
        subject: 'My delivery has been stuck in transit',
        description: 'Shipment for ORD-2026-000006 has not moved in 3 days.',
        type: TicketType.DELIVERY_DELAY,
        status: TicketStatus.OPEN,
        priority: TicketPriority.HIGH,
        importance: TicketImportance.HIGH,
        entityType: EntityType.SHIPMENT,
        entityId: REF.ship3_inTransit,
        creator: carol,
        assignedTo: agent2,
        daysAgo: 2,
        // creator(carol) + assignee(agent2) + agency + vendor = 4 non-admin (<=5) + admin
        followers: [agency, vendor, admin],
        notes: [
            { author: agency, content: 'Checking with the driver now.', visibility: NoteVisibility.PRIVATE, visibleTo: [agent2, vendor] },
            { author: agent2, content: 'Vehicle issue on my route — parcel will move today.' },
        ],
        attachments: [{ uploader: agent2, name: 'route-log.png', mime: 'image/png', size: 132_400 }],
    });

    // 7. IN_PROGRESS / URGENT — Vendor, security issue, locked to admin
    await createTicket({
        subject: 'Suspicious login attempts on my vendor account',
        description: 'I received several "new device" alerts I did not trigger.',
        type: TicketType.SECURITY_ISSUE,
        status: TicketStatus.IN_PROGRESS,
        priority: TicketPriority.URGENT,
        importance: TicketImportance.CRITICAL,
        entityType: EntityType.USER,
        entityId: vendor.userId.toString(),
        creator: vendor,
        assignedTo: admin,
        assignedAdmin: admin,
        priorityLockedBy: admin,
        daysAgo: 1,
        followers: [admin],
        notes: [
            { author: admin, content: 'Forced a session reset and enabled 2FA enforcement.', visibility: NoteVisibility.PRIVATE },
            { author: admin, content: 'Status changed from "open" to "in_progress"', isSystem: true },
        ],
    });

    // 8. OPEN / NORMAL — Vendor, inventory problem on the t-shirt PRODUCT, unassigned
    await createTicket({
        subject: 'Stock count looks wrong for the cotton t-shirt',
        description: 'The Classic Cotton T-Shirt shows fewer units than I actually have.',
        type: TicketType.INVENTORY_PROBLEM,
        status: TicketStatus.OPEN,
        priority: TicketPriority.NORMAL,
        importance: TicketImportance.MEDIUM,
        entityType: EntityType.PRODUCT,
        entityId: REF.prodTshirt,
        creator: vendor,
        daysAgo: 6,
        notes: [{ author: vendor, content: 'This is blocking sales on a popular item.' }],
    });

    // 9. WAITING / LOW — Vendor, API access request, admin pool
    await createTicket({
        subject: 'Requesting API access for inventory sync',
        description: 'We would like API keys to sync stock from our ERP.',
        type: TicketType.API_ACCESS,
        status: TicketStatus.WAITING_ON_ADMIN,
        priority: TicketPriority.LOW,
        importance: TicketImportance.LOW,
        entityType: EntityType.VENDOR,
        entityId: vendor.entityId.toString(),
        creator: vendor,
        assignedToRole: ActorRole.ADMIN,
        daysAgo: 10,
        followers: [admin],
        notes: [
            { author: admin, content: 'Needs platform-team approval first.', visibility: NoteVisibility.PRIVATE },
            { author: admin, content: 'Status changed from "open" to "waiting"', isSystem: true },
        ],
    });

    // 10. RESOLVED / HIGH — Carol, dispute on the order that was PAID then CANCELLED (ORD-9)
    await createTicket({
        subject: 'Why was my paid order cancelled?',
        description: 'I paid for ORD-2026-000009 (2x headphones) and it was later cancelled.',
        type: TicketType.ORDER_DISPUTE,
        status: TicketStatus.RESOLVED,
        priority: TicketPriority.HIGH,
        importance: TicketImportance.HIGH,
        entityType: EntityType.ORDER,
        entityId: REF.ord9_cancelledAfterPaid,
        creator: carol,
        assignedTo: admin,
        daysAgo: 6,
        followers: [admin, vendor],
        notes: [
            { author: vendor, content: 'Apologies — a stock discrepancy was found after payment.' },
            { author: admin, content: 'Cancellation confirmed; a refund has been arranged.' },
            { author: admin, content: 'Status changed from "in_progress" to "resolved"', isSystem: true },
        ],
    });

    // 11. CLOSED / NORMAL — Vendor, policy question, closed
    await createTicket({
        subject: 'Return policy for digital goods?',
        description: 'Are digital downloads eligible for returns under platform policy?',
        type: TicketType.POLICY_QUESTION,
        status: TicketStatus.CLOSED,
        priority: TicketPriority.NORMAL,
        importance: TicketImportance.LOW,
        entityType: EntityType.OTHER,
        entityId: 'POLICY-RETURNS',
        creator: vendor,
        daysAgo: 20,
        followers: [admin],
        notes: [
            { author: admin, content: 'Digital goods are non-returnable once downloaded.' },
            { author: vendor, content: 'Understood, thanks.' },
            { author: vendor, content: 'Ticket closed', isSystem: true },
        ],
    });

    // 12. OPEN / URGENT — Vendor, chargeback on the IN-TRANSIT order (ORD-6), admin pool
    await createTicket({
        subject: 'Chargeback filed on an in-transit order',
        description: 'A chargeback was filed on ORD-2026-000006 which is still in transit.',
        type: TicketType.CHARGEBACK,
        status: TicketStatus.OPEN,
        priority: TicketPriority.URGENT,
        importance: TicketImportance.CRITICAL,
        entityType: EntityType.ORDER,
        entityId: REF.ord6_inTransit,
        creator: vendor,
        assignedToRole: ActorRole.ADMIN,
        daysAgo: 1,
        followers: [admin, agency],
        notes: [
            { author: vendor, content: 'Attaching the dispatch and tracking records.' },
            { author: admin, content: 'Gathering evidence to contest the chargeback.', visibility: NoteVisibility.PRIVATE, visibleTo: [vendor] },
        ],
        attachments: [
            { uploader: vendor, name: 'tracking-record.pdf', mime: 'application/pdf', size: 156_700 },
            { uploader: agency, name: 'dispatch-proof.jpg', mime: 'image/jpeg', size: 98_500, visibility: 'PRIVATE', visibleTo: [admin, vendor] },
        ],
    });

    // 13. OPEN / HIGH — Carol, lost access to her REVOKED digital entitlement (ORD-13)
    await createTicket({
        subject: 'I lost access to my purchased license',
        description: 'My DesignPro license from ORD-2026-000013 no longer works.',
        type: TicketType.ORDER_ISSUE,
        status: TicketStatus.OPEN,
        priority: TicketPriority.HIGH,
        importance: TicketImportance.HIGH,
        entityType: EntityType.ORDER,
        entityId: REF.ord13_revokedEntitlement,
        creator: carol,
        assignedToRole: ActorRole.ADMIN,
        daysAgo: 2,
        followers: [admin, vendor],
        notes: [
            { author: carol, content: 'I did not violate any terms — please restore my access.' },
            { author: vendor, content: 'Reviewing the revocation reason on my side.', visibility: NoteVisibility.PRIVATE, visibleTo: [admin] },
        ],
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
    const cleanOnly = process.argv.includes('--clean');

    await mongoose.connect(MONGO_URI);
    log(`✅ Connected to MongoDB (${MONGO_URI.replace(/\/\/[^@]*@/, '//<credentials>@')})`);

    await cleanup();

    if (cleanOnly) {
        log('\n✨ Clean complete (--clean). No data seeded.');
        await mongoose.disconnect();
        return;
    }

    await ensureAdminAndCheckRefs();
    await seedTickets();

    log('\n📋 Ticket actors (reusing seed-orders.js accounts):');
    for (const a of Object.values(ACTORS)) {
        const origin = a.key === 'admin' ? 'NEW (admin@jovitest.cm / ' + ADMIN_PASSWORD + ')' : 'from seed-orders.js';
        log(`   ${a.role.padEnd(9)} ${a.key.padEnd(7)} user=${a.userId}  — ${origin}`);
    }

    log(`\n✨ Done. Seeded ${ticketCount} tickets (followers, notes, attachments) under the seed-orders.js accounts.`);
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error('\n❌ Seed failed:', err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
