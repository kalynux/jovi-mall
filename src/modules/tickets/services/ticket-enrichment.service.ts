import mongoose from 'mongoose';
import { ITicket } from '../models/ticket.model';
import { ITicketNote } from '../models/ticket-note.model';
import { ITicketAttachment } from '../models/ticket-attachment.model';
import { ActorRole } from '../types/ticket.types';
import { AdminModel } from '../../admins/admin.model';
import { VendorModel } from '../../vendors/vendor.model';
import { CustomerModel } from '../../customers/customer.model';
import { DeliveryAgentModel } from '../../agents';
import { DeliveryAgencyModel } from '../../delivery/delivery-agency.model';
import { OrderModel } from '../../orders/order.model';
import { ProductModel } from '../../catalog/models/product.model';
import { Booking } from '../../booking/models/booking.model';
import { TicketFollowerModel } from '../models/ticket-follower.model';
import { FileRepositoryMongo } from '../../catalog/repositories/mongo/file.repository.mongo';
import { getStorageProvider, IStorageProvider } from '../../../core/storage';

/**
 * TicketEnrichmentService
 *
 * Resolves the raw ObjectId references stored on tickets, notes and attachments
 * into human-readable summaries so the frontend can render names, avatars and
 * entity labels without issuing follow-up lookups.
 *
 * RESOLUTION SOURCES:
 * - Actors (user_id + role) → role-specific profile (Admin / Vendor / Customer / Agent / Agency)
 * - Entities (entity_type + entity_id) → owning collection (Order / Product / Booking / ...)
 *
 * All lookups are BATCHED ($in) so enriching a page of tickets stays at a fixed
 * number of queries regardless of page size. Unresolved references degrade
 * gracefully to a role/type-based placeholder rather than throwing.
 */

export interface ActorSummary {
    user_id: string;
    role: string;
    name: string;
    avatar_url: string | null;
}

export interface EntitySummary {
    type: string;
    id: string;
    label: string;
    reference: string | null;
}

interface ActorRef {
    userId: string;
    role: string;
}

export class TicketEnrichmentService {
    constructor(
        private readonly fileRepository: FileRepositoryMongo = new FileRepositoryMongo(),
        private readonly storageProvider: IStorageProvider = getStorageProvider(),
    ) { }

    /**
     * Enrich a single ticket (detail view). Resolves creator, assignee, active
     * admin, linked entity and the follower list into readable summaries.
     */
    async enrichTicket(ticket: ITicket): Promise<Record<string, any>> {
        const [enriched] = await this.enrichTickets([ticket], { includeFollowers: true });
        return enriched;
    }

    /**
     * Enrich a list of tickets (listing view). Batches every lookup across the
     * whole page. Followers are omitted unless `includeFollowers` is set.
     */
    async enrichTickets(
        tickets: ITicket[],
        options: { includeFollowers?: boolean } = {}
    ): Promise<Record<string, any>[]> {
        if (tickets.length === 0) return [];

        // ── Collect every reference to resolve in one pass ──
        const actorRefs: ActorRef[] = [];
        const adminIds: string[] = [];
        const entityRefs: Array<{ type: string; id: string }> = [];

        for (const ticket of tickets) {
            if (ticket.created_by_user_id) {
                actorRefs.push({ userId: ticket.created_by_user_id.toString(), role: ticket.created_by_role });
            }
            if (ticket.assigned_to_user_id && ticket.assigned_to_role) {
                actorRefs.push({ userId: ticket.assigned_to_user_id.toString(), role: ticket.assigned_to_role });
            }
            if (ticket.assigned_admin_id) {
                adminIds.push(ticket.assigned_admin_id.toString());
            }
            if (ticket.entity_type && ticket.entity_id) {
                entityRefs.push({ type: ticket.entity_type, id: ticket.entity_id });
            }
        }

        // ── Followers (detail view only) ──
        const followersByTicket = new Map<string, ActorRef[]>();
        if (options.includeFollowers) {
            const ticketIds = tickets.map(t => t._id);
            const followers = await TicketFollowerModel.find({ ticket_id: { $in: ticketIds } })
                .select('ticket_id user_id role added_at')
                .sort({ added_at: 1 })
                .lean();
            for (const f of followers) {
                const key = f.ticket_id.toString();
                if (!followersByTicket.has(key)) followersByTicket.set(key, []);
                const ref = { userId: f.user_id.toString(), role: f.role };
                followersByTicket.get(key)!.push(ref);
                actorRefs.push(ref);
            }
        }

        // ── Resolve everything in batch ──
        const actorMap = await this.resolveActors(actorRefs);
        const adminMap = await this.resolveAdmins(adminIds);
        const entityMap = await this.resolveEntities(entityRefs);

        // ── Assemble enriched payloads ──
        return tickets.map(ticket => {
            const obj = (ticket as any).toObject ? (ticket as any).toObject({ virtuals: true }) : { ...ticket };

            obj.created_by = ticket.created_by_user_id
                ? actorMap.get(this.actorKey(ticket.created_by_user_id.toString(), ticket.created_by_role))
                  ?? this.fallbackActor(ticket.created_by_user_id.toString(), ticket.created_by_role)
                : null;

            obj.assigned_to = ticket.assigned_to_user_id && ticket.assigned_to_role
                ? actorMap.get(this.actorKey(ticket.assigned_to_user_id.toString(), ticket.assigned_to_role))
                  ?? this.fallbackActor(ticket.assigned_to_user_id.toString(), ticket.assigned_to_role)
                : null;

            obj.assigned_admin = ticket.assigned_admin_id
                ? adminMap.get(ticket.assigned_admin_id.toString()) ?? null
                : null;

            obj.entity = ticket.entity_type && ticket.entity_id
                ? entityMap.get(this.entityKey(ticket.entity_type, ticket.entity_id))
                  ?? this.fallbackEntity(ticket.entity_type, ticket.entity_id)
                : null;

            if (options.includeFollowers) {
                const refs = followersByTicket.get(ticket._id.toString()) ?? [];
                obj.followers = refs.map(
                    r => actorMap.get(this.actorKey(r.userId, r.role)) ?? this.fallbackActor(r.userId, r.role)
                );
            }

            return obj;
        });
    }

    /**
     * Enrich ticket notes with their author summary.
     */
    async enrichNotes(notes: ITicketNote[]): Promise<Record<string, any>[]> {
        if (notes.length === 0) return [];

        const actorRefs: ActorRef[] = notes
            .filter(n => n.author_user_id)
            .map(n => ({ userId: n.author_user_id.toString(), role: n.author_role }));
        const actorMap = await this.resolveActors(actorRefs);

        return notes.map(note => {
            const obj = (note as any).toObject ? (note as any).toObject({ virtuals: true }) : { ...note };
            obj.author = note.author_user_id
                ? actorMap.get(this.actorKey(note.author_user_id.toString(), note.author_role))
                  ?? this.fallbackActor(note.author_user_id.toString(), note.author_role)
                : null;
            return obj;
        });
    }

    /**
     * Enrich attachment DTOs (plain objects from the attachment controller) with
     * their uploader summary. Mutates and returns the same array.
     */
    async enrichAttachments<T extends { uploadedBy: any; uploadedByRole: string }>(
        attachments: T[]
    ): Promise<Array<T & { uploadedByActor: ActorSummary | null }>> {
        if (attachments.length === 0) return attachments as any;

        const actorRefs: ActorRef[] = attachments
            .filter(a => a.uploadedBy)
            .map(a => ({ userId: a.uploadedBy.toString(), role: a.uploadedByRole }));
        const actorMap = await this.resolveActors(actorRefs);

        return attachments.map(att => ({
            ...att,
            uploadedByActor: att.uploadedBy
                ? actorMap.get(this.actorKey(att.uploadedBy.toString(), att.uploadedByRole))
                  ?? this.fallbackActor(att.uploadedBy.toString(), att.uploadedByRole)
                : null
        }));
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Internal resolvers
    // ──────────────────────────────────────────────────────────────────────────

    private actorKey(userId: string, role: string): string {
        return `${userId}:${role}`;
    }

    /**
     * Batch-resolve File ids into public URLs (e.g. a vendor's branding logo).
     * Used instead of a stored URL now that branding is attached-file based —
     * see FileDetail-style resolution in enrich-product-detail.ts.
     */
    private async resolveFileUrls(fileIds: string[]): Promise<Map<string, string>> {
        const uniqueIds = [...new Set(fileIds)];
        if (uniqueIds.length === 0) return new Map();
        const files = await this.fileRepository.findManyByIds(uniqueIds);
        return new Map(files.map(f => [f.id, this.storageProvider.getPublicUrl(f.key)]));
    }

    private entityKey(type: string, id: string): string {
        return `${type}:${id}`;
    }

    /**
     * Resolve (user_id, role) pairs into actor summaries. Groups ids by role and
     * issues at most one query per role-specific collection.
     */
    private async resolveActors(refs: ActorRef[]): Promise<Map<string, ActorSummary>> {
        const result = new Map<string, ActorSummary>();

        // De-duplicate and group user ids by role
        const idsByRole = new Map<string, Set<string>>();
        for (const { userId, role } of refs) {
            if (!userId) continue;
            if (!idsByRole.has(role)) idsByRole.set(role, new Set());
            idsByRole.get(role)!.add(userId);
        }

        for (const [role, idSet] of idsByRole) {
            const ids = [...idSet].map(id => new mongoose.Types.ObjectId(id));

            switch (role) {
                case ActorRole.ADMIN: {
                    const docs = await AdminModel.find({ user_id: { $in: ids } })
                        .select('user_id name avatar_url').lean();
                    for (const d of docs) {
                        result.set(this.actorKey(d.user_id.toString(), role), {
                            user_id: d.user_id.toString(), role, name: d.name, avatar_url: d.avatar_url ?? null
                        });
                    }
                    break;
                }
                case ActorRole.VENDOR: {
                    const docs = await VendorModel.find({ user_id: { $in: ids } })
                        .select('user_id business_name display_name branding.logo_file_id').lean();
                    const logoUrlByFileId = await this.resolveFileUrls(
                        docs.map(d => d.branding?.logo_file_id?.toString()).filter((id): id is string => !!id),
                    );
                    for (const d of docs) {
                        const logoFileId = d.branding?.logo_file_id?.toString();
                        result.set(this.actorKey(d.user_id.toString(), role), {
                            user_id: d.user_id.toString(), role,
                            name: d.display_name || d.business_name,
                            avatar_url: (logoFileId ? logoUrlByFileId.get(logoFileId) : undefined) ?? null
                        });
                    }
                    break;
                }
                case ActorRole.CUSTOMER: {
                    const docs = await CustomerModel.find({ user_id: { $in: ids } })
                        .select('user_id name avatar_url').lean();
                    for (const d of docs) {
                        result.set(this.actorKey(d.user_id.toString(), role), {
                            user_id: d.user_id.toString(), role, name: d.name, avatar_url: d.avatar_url ?? null
                        });
                    }
                    break;
                }
                case ActorRole.AGENT: {
                    const docs = await DeliveryAgentModel.find({ user_id: { $in: ids } })
                        .select('user_id name').lean();
                    for (const d of docs) {
                        result.set(this.actorKey(d.user_id.toString(), role), {
                            user_id: d.user_id.toString(), role, name: d.name, avatar_url: null
                        });
                    }
                    break;
                }
                case ActorRole.AGENCY: {
                    const docs = await DeliveryAgencyModel.find({ user_id: { $in: ids } })
                        .select('user_id agency_name logo_url').lean();
                    for (const d of docs) {
                        result.set(this.actorKey(d.user_id.toString(), role), {
                            user_id: d.user_id.toString(), role, name: d.agency_name, avatar_url: d.logo_url ?? null
                        });
                    }
                    break;
                }
            }
        }

        return result;
    }

    /**
     * Resolve assigned_admin_id values. The id may be a User id (active-admin
     * lock) or an Admin document id (assignment), so both are matched.
     */
    private async resolveAdmins(ids: string[]): Promise<Map<string, ActorSummary>> {
        const result = new Map<string, ActorSummary>();
        if (ids.length === 0) return result;

        const objectIds = [...new Set(ids)].map(id => new mongoose.Types.ObjectId(id));
        const docs = await AdminModel.find({
            $or: [{ user_id: { $in: objectIds } }, { _id: { $in: objectIds } }]
        }).select('user_id name avatar_url').lean();

        for (const d of docs) {
            const summary: ActorSummary = {
                user_id: d.user_id.toString(), role: ActorRole.ADMIN, name: d.name, avatar_url: d.avatar_url ?? null
            };
            // Index by both possible reference forms so lookup by either id hits.
            result.set(d._id.toString(), summary);
            result.set(d.user_id.toString(), summary);
        }

        return result;
    }

    /**
     * Resolve (entity_type, entity_id) pairs into entity summaries. Groups ids by
     * type and issues at most one query per owning collection.
     */
    private async resolveEntities(refs: Array<{ type: string; id: string }>): Promise<Map<string, EntitySummary>> {
        const result = new Map<string, EntitySummary>();

        const idsByType = new Map<string, Set<string>>();
        for (const { type, id } of refs) {
            if (!id || !mongoose.Types.ObjectId.isValid(id)) continue;
            const key = type.toUpperCase();
            if (!idsByType.has(key)) idsByType.set(key, new Set());
            idsByType.get(key)!.add(id);
        }

        for (const [type, idSet] of idsByType) {
            const ids = [...idSet].map(id => new mongoose.Types.ObjectId(id));

            switch (type) {
                case 'ORDER': {
                    const docs = await OrderModel.find({ _id: { $in: ids } })
                        .select('order_number').lean();
                    for (const d of docs) {
                        result.set(this.entityKey('ORDER', d._id.toString()), {
                            type, id: d._id.toString(), label: `Order ${d.order_number}`, reference: d.order_number
                        });
                    }
                    break;
                }
                case 'PRODUCT': {
                    const docs = await ProductModel.find({ _id: { $in: ids } })
                        .select('title slug').lean();
                    for (const d of docs) {
                        result.set(this.entityKey('PRODUCT', d._id.toString()), {
                            type, id: d._id.toString(), label: d.title, reference: d.slug ?? null
                        });
                    }
                    break;
                }
                case 'BOOKING': {
                    const docs = await Booking.find({ _id: { $in: ids } })
                        .select('startAt').lean();
                    for (const d of docs) {
                        const when = d.startAt ? new Date(d.startAt).toISOString() : null;
                        result.set(this.entityKey('BOOKING', d._id.toString()), {
                            type, id: d._id.toString(),
                            label: when ? `Booking on ${when.slice(0, 10)}` : `Booking ${d._id.toString().slice(-6)}`,
                            reference: d._id.toString()
                        });
                    }
                    break;
                }
                // Other entity types (USER/VENDOR/CUSTOMER/AGENT/AGENCY/SHIPMENT/DELIVERY/OTHER)
                // fall through to the generic placeholder below.
            }
        }

        return result;
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Fallbacks for unresolved references
    // ──────────────────────────────────────────────────────────────────────────

    private fallbackActor(userId: string, role: string): ActorSummary {
        const label = role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : 'Unknown user';
        return { user_id: userId, role, name: label, avatar_url: null };
    }

    private fallbackEntity(type: string, id: string): EntitySummary {
        const pretty = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
        return { type: type.toUpperCase(), id, label: `${pretty} ${id.slice(-6)}`, reference: id };
    }
}
