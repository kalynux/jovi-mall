import { Types } from 'mongoose';
import {
    VendorSettingsModel,
    IVendorSettings,
    IVendorCustomerFlagSub,
    IVendorCodTermsSub,
    IVendorDeliveryTermsSub,
    VendorDeliveryTermsMode
} from '../models/vendor-settings.model';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

/**
 * VendorSettingsRepository - Persistence for the per-vendor settings document.
 *
 * Currently exposes CRUD over the vendor's embedded customer flags. The settings
 * document is created lazily (upsert) the first time it is read or written.
 * All flag operations are vendor-scoped and ignore soft-deleted flags.
 */
export class VendorSettingsRepository {
    /** Fetch the vendor's settings document, creating an empty one if absent. */
    async getOrCreate(vendorId: string): Promise<IVendorSettings> {
        const settings = await VendorSettingsModel.findOneAndUpdate(
            { vendor_id: new Types.ObjectId(vendorId) },
            { $setOnInsert: { vendor_id: new Types.ObjectId(vendorId), customer_flags: [] } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).exec();
        return settings!;
    }

    // ─── Plan expiry notification preference ─────────────────────────────────────

    /** Days before plan expiry to notify the vendor (defaults to 7). */
    async getNotifyDaysBeforeExpiry(vendorId: string): Promise<number> {
        const settings = await this.getOrCreate(vendorId);
        return settings.notify_days_before_expiry ?? 7;
    }

    async setNotifyDaysBeforeExpiry(vendorId: string, days: number): Promise<number> {
        const settings = await this.getOrCreate(vendorId);
        settings.notify_days_before_expiry = days;
        await settings.save();
        return settings.notify_days_before_expiry;
    }

    // ─── Auto-redirect orders to agency ──────────────────────────────────────────

    /** Whether paid physical orders auto-dispatch to their agency (defaults to false). */
    async getAutoRedirectOrdersToAgency(vendorId: string): Promise<boolean> {
        const settings = await this.getOrCreate(vendorId);
        return settings.auto_redirect_orders_to_agency ?? false;
    }

    async setAutoRedirectOrdersToAgency(vendorId: string, enabled: boolean): Promise<boolean> {
        const settings = await this.getOrCreate(vendorId);
        settings.auto_redirect_orders_to_agency = enabled;
        await settings.save();
        return settings.auto_redirect_orders_to_agency;
    }

    // ─── Auto-redirect threshold ─────────────────────────────────────────────────

    /** Max order total for which auto-redirect applies (null = no cap). */
    async getAutoRedirectThresholdAmount(vendorId: string): Promise<number | null> {
        const settings = await this.getOrCreate(vendorId);
        return settings.auto_redirect_threshold_amount ?? null;
    }

    async setAutoRedirectThresholdAmount(
        vendorId: string,
        amount: number | null
    ): Promise<number | null> {
        const settings = await this.getOrCreate(vendorId);
        settings.auto_redirect_threshold_amount = amount;
        await settings.save();
        return settings.auto_redirect_threshold_amount ?? null;
    }

    // ─── Auto-cancel unpaid orders ───────────────────────────────────────────────

    /** Days an order may stay unpaid before auto-cancellation (defaults to 3). */
    async getAutoCancelUnpaidDays(vendorId: string): Promise<number> {
        const settings = await this.getOrCreate(vendorId);
        return settings.auto_cancel_unpaid_days ?? 3;
    }

    async setAutoCancelUnpaidDays(vendorId: string, days: number): Promise<number> {
        const settings = await this.getOrCreate(vendorId);
        settings.auto_cancel_unpaid_days = days;
        await settings.save();
        return settings.auto_cancel_unpaid_days;
    }

    // ─── COD terms (2026-10-02) ──────────────────────────────────────────────────

    /**
     * The vendor's raw COD terms block, or null when never set. READ-ONLY: unlike the
     * getters above it never upserts, because checkout and dispatch read it and must
     * not write a settings document as a side effect. Callers apply the defaults with
     * `vendorCodTermsOf()`.
     */
    async findCodTerms(vendorId: string): Promise<IVendorCodTermsSub | null> {
        const doc = await VendorSettingsModel.findOne(
            { vendor_id: new Types.ObjectId(vendorId) },
            { cod_terms: 1 }
        ).lean().exec();
        return (doc?.cod_terms as IVendorCodTermsSub | null | undefined) ?? null;
    }

    /** The same, for many vendors at once — keyed by vendor id; absent = never set. */
    async findCodTermsForVendors(vendorIds: string[]): Promise<Map<string, IVendorCodTermsSub>> {
        const ids = [...new Set(vendorIds)].filter((id) => Types.ObjectId.isValid(id));
        const out = new Map<string, IVendorCodTermsSub>();
        if (ids.length === 0) return out;
        const docs = await VendorSettingsModel.find(
            { vendor_id: { $in: ids.map((id) => new Types.ObjectId(id)) } },
            { vendor_id: 1, cod_terms: 1 }
        ).lean().exec();
        for (const d of docs) {
            if (d.cod_terms) out.set(String(d.vendor_id), d.cod_terms as IVendorCodTermsSub);
        }
        return out;
    }

    /** Replace the vendor's COD terms wholesale. Upserts the settings document. */
    async setCodTerms(
        vendorId: string,
        terms: { cod_enabled: boolean; max_cash_per_agency: number | null }
    ): Promise<IVendorCodTermsSub> {
        const doc = await VendorSettingsModel.findOneAndUpdate(
            { vendor_id: new Types.ObjectId(vendorId) },
            {
                $set: {
                    cod_terms: {
                        cod_enabled: terms.cod_enabled,
                        max_cash_per_agency: terms.max_cash_per_agency,
                        updated_at: new Date(),
                    },
                },
                $setOnInsert: { vendor_id: new Types.ObjectId(vendorId), customer_flags: [] },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        ).lean().exec();
        return doc!.cod_terms as IVendorCodTermsSub;
    }

    // ─── Delivery terms (ADR-A11, 2026-10-03) ────────────────────────────────────

    /**
     * The shop's raw delivery-terms block, or null when never set. READ-ONLY, for the
     * same reason as `findCodTerms`: checkout and the public catalogue read it and must
     * not write a settings document as a side effect. Callers apply the default with
     * `vendorDeliveryTermsOf()`.
     */
    async findDeliveryTerms(vendorId: string): Promise<IVendorDeliveryTermsSub | null> {
        if (!Types.ObjectId.isValid(vendorId)) return null;
        const doc = await VendorSettingsModel.findOne(
            { vendor_id: new Types.ObjectId(vendorId) },
            { delivery_terms: 1 }
        ).lean().exec();
        return (doc?.delivery_terms as IVendorDeliveryTermsSub | null | undefined) ?? null;
    }

    /** The same, for many vendors at once — keyed by vendor id; absent = never set. */
    async findDeliveryTermsForVendors(vendorIds: string[]): Promise<Map<string, IVendorDeliveryTermsSub>> {
        const ids = [...new Set(vendorIds)].filter((id) => Types.ObjectId.isValid(id));
        const out = new Map<string, IVendorDeliveryTermsSub>();
        if (ids.length === 0) return out;
        const docs = await VendorSettingsModel.find(
            { vendor_id: { $in: ids.map((id) => new Types.ObjectId(id)) } },
            { vendor_id: 1, delivery_terms: 1 }
        ).lean().exec();
        for (const d of docs) {
            if (d.delivery_terms) out.set(String(d.vendor_id), d.delivery_terms as IVendorDeliveryTermsSub);
        }
        return out;
    }

    /** Replace the shop's delivery terms wholesale. Upserts the settings document. */
    async setDeliveryTerms(
        vendorId: string,
        terms: { mode: VendorDeliveryTermsMode; free_above_amount: number | null }
    ): Promise<IVendorDeliveryTermsSub> {
        const doc = await VendorSettingsModel.findOneAndUpdate(
            { vendor_id: new Types.ObjectId(vendorId) },
            {
                $set: {
                    delivery_terms: {
                        mode: terms.mode,
                        free_above_amount: terms.mode === 'above' ? terms.free_above_amount : null,
                        updated_at: new Date(),
                    },
                },
                $setOnInsert: { vendor_id: new Types.ObjectId(vendorId), customer_flags: [] },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
        ).lean().exec();
        return doc!.delivery_terms as IVendorDeliveryTermsSub;
    }

    // ─── Customer flags ────────────────────────────────────────────────────────

    /** All non-deleted flags for the vendor, oldest first. */
    async listFlags(vendorId: string): Promise<IVendorCustomerFlagSub[]> {
        const settings = await this.getOrCreate(vendorId);
        return settings.customer_flags
            .filter((f) => !f.deletedAt)
            .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    }

    async createFlag(
        vendorId: string,
        data: { name: string; color: string; description?: string | null }
    ): Promise<IVendorCustomerFlagSub> {
        const settings = await this.getOrCreate(vendorId);
        this.assertNameAvailable(settings, data.name, null);

        const flags = settings.customer_flags as any;
        const created = flags.create({
            name: data.name,
            color: data.color,
            description: data.description ?? null
        });
        flags.push(created);
        await settings.save();
        return created;
    }

    /** Find a single non-deleted flag by id (vendor-scoped). */
    async findFlagById(vendorId: string, flagId: string): Promise<IVendorCustomerFlagSub | null> {
        if (!Types.ObjectId.isValid(flagId)) return null;
        const settings = await this.getOrCreate(vendorId);
        const flag = (settings.customer_flags as any).id(flagId) as IVendorCustomerFlagSub | null;
        return flag && !flag.deletedAt ? flag : null;
    }

    async updateFlag(
        vendorId: string,
        flagId: string,
        updates: { name?: string; color?: string; description?: string | null }
    ): Promise<IVendorCustomerFlagSub | null> {
        if (!Types.ObjectId.isValid(flagId)) return null;
        const settings = await this.getOrCreate(vendorId);
        const flag = (settings.customer_flags as any).id(flagId) as IVendorCustomerFlagSub | null;
        if (!flag || flag.deletedAt) return null;

        if (updates.name !== undefined) {
            this.assertNameAvailable(settings, updates.name, flagId);
            flag.name = updates.name;
        }
        if (updates.color !== undefined) flag.color = updates.color;
        if (updates.description !== undefined) flag.description = updates.description ?? null;

        await settings.save();
        return flag;
    }

    /** Soft-delete a flag. Returns true if a non-deleted flag was found and deleted. */
    async softDeleteFlag(vendorId: string, flagId: string): Promise<boolean> {
        if (!Types.ObjectId.isValid(flagId)) return false;
        const settings = await this.getOrCreate(vendorId);
        const flag = (settings.customer_flags as any).id(flagId) as IVendorCustomerFlagSub | null;
        if (!flag || flag.deletedAt) return false;
        flag.deletedAt = new Date();
        await settings.save();
        return true;
    }

    /**
     * Return the subset of the given flag ids that exist, belong to the vendor,
     * and are not soft-deleted. Used to validate flag assignment.
     */
    async findOwnedFlagIds(vendorId: string, flagIds: string[]): Promise<string[]> {
        const valid = new Set(flagIds.filter((id) => Types.ObjectId.isValid(id)));
        if (valid.size === 0) return [];
        const settings = await this.getOrCreate(vendorId);
        return settings.customer_flags
            .filter((f) => !f.deletedAt && valid.has(f._id.toString()))
            .map((f) => f._id.toString());
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    /** Reject a name already used by another non-deleted flag (case-insensitive). */
    private assertNameAvailable(
        settings: IVendorSettings,
        name: string,
        excludeFlagId: string | null
    ): void {
        const normalized = name.trim().toLowerCase();
        const clash = settings.customer_flags.find(
            (f) =>
                !f.deletedAt &&
                f._id.toString() !== excludeFlagId &&
                f.name.trim().toLowerCase() === normalized
        );
        if (clash) {
            throw createAppError(
                ERROR_CODES.VENDOR_CUSTOMER_FLAG_DUPLICATE,
                409,
                'A flag with this name already exists'
            );
        }
    }
}
