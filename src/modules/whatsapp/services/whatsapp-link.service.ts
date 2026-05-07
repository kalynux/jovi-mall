import { VendorRepository } from '../../vendors/vendor.repository';
import { CustomerRepository } from '../../customers/customer.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { DeliveryAgentRepository } from '../../delivery/delivery-agent.repository';
import { UserRepository } from '../../users/user.repository';
import { getRedisClient, WA_VERIFY_DB } from '../../../infra/redis/redis.factory';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';

export interface LinkStatus {
    linked: boolean;
    wa_phone_id?: string;
    name?: string;
    bound_at?: Date;
}

/**
 * WhatsAppLinkService
 * 
 * Handles WhatsApp account linking/unlinking using the role entity's `wa` field.
 * Unlike Telegram, there's no separate link model - everything is stored in the role entity.
 */
export class WhatsAppLinkService {
    private vendorRepo: VendorRepository;
    private customerRepo: CustomerRepository;
    private agencyRepo: DeliveryAgencyRepository;
    private agentRepo: DeliveryAgentRepository;
    private userRepo: UserRepository;

    constructor() {
        this.vendorRepo = new VendorRepository();
        this.customerRepo = new CustomerRepository();
        this.agencyRepo = new DeliveryAgencyRepository();
        this.agentRepo = new DeliveryAgentRepository();
        this.userRepo = new UserRepository();
    }

    /**
     * Verify code and link WhatsApp account.
     * Called by the webhook command handler when the user sends /link:CODE.
     *
     * Throws an AppError on any failure — callers do not need to inspect
     * a return value; a clean return means success.
     *
     * @param code   - Verification code supplied by the user
     * @param waData - Sender data from the webhook (wa_phone_id + display name)
     */
    async verifyCode(code: string, waData: { wa_phone_id: string; name: string }): Promise<void> {
        const redis = await getRedisClient(WA_VERIFY_DB);
        const key = `wa_verify:${code}`;
        const value = await redis.get(key);

        if (!value) {
            console.log(`[WhatsAppLink] Invalid or expired code: ${code}`);
            throw createAppError(ERROR_CODES.AUTH_VERIFY_TOKEN_INVALID, 400);
        }

        const data = JSON.parse(value);
        const { user_id, role, update_other_roles } = data;

        // Delete token immediately — single-use regardless of what follows
        await redis.del(key);

        switch (role) {
            case 'vendor':
                await this.vendorRepo.updateWaVerified(user_id, waData);
                break;
            case 'customer':
                await this.customerRepo.updateWaVerified(user_id, waData);
                break;
            case 'agency':
                await this.agencyRepo.updateWaVerified(user_id, waData);
                break;
            case 'agent':
                await this.agentRepo.updateWaVerified(user_id, waData);
                break;
            default:
                throw createAppError(ERROR_CODES.WHATSAPP_ROLE_NOT_SUPPORTED, 400, undefined, { role });
        }

        console.log(`[WhatsAppLink] Account linked for user ${user_id} (${role})`);

        if (update_other_roles) {
            await this.crossRoleVerification(user_id, role, waData);
        }
    }


    /**
     * Cross-role verification: Verify WhatsApp on other roles if not already verified.
     *
     * Fetches the user document once to determine which roles they actually have,
     * then only queries the relevant role entity collections — avoiding blind lookups
     * across all 4 collections when the user may only have 1 or 2 roles.
     *
     * @param userId - User ID
     * @param primaryRole - The role that initiated verification (already updated)
     * @param waData - WhatsApp data to verify
     */
    private async crossRoleVerification(
        userId: string,
        primaryRole: string,
        waData: { wa_phone_id: string; name: string }
    ): Promise<void> {
        // Fetch the user once to know which roles they actually hold
        const user = await this.userRepo.findById(userId);
        if (!user || !user.roles?.length) return;

        // Only process roles the user actually has, excluding the primary (already updated)
        const rolesToSync = user.roles.filter(
            (r) => r !== primaryRole && r !== 'admin'
        );
        if (!rolesToSync.length) return;

        for (const role of rolesToSync) {
            try {
                let entity: any = null;
                let repo: any = null;

                switch (role) {
                    case 'vendor':
                        entity = await this.vendorRepo.findByUserId(userId);
                        repo = this.vendorRepo;
                        break;
                    case 'customer':
                        entity = await this.customerRepo.findByUserId(userId);
                        repo = this.customerRepo;
                        break;
                    case 'agency':
                        entity = await this.agencyRepo.findByUserId(userId);
                        repo = this.agencyRepo;
                        break;
                    case 'agent':
                        entity = await this.agentRepo.findByUserId(userId);
                        repo = this.agentRepo;
                        break;
                    default:
                        continue; // skip any unsupported roles
                }

                // Only update if entity exists AND WhatsApp is NOT already verified
                if (entity && !entity.wa?.verified && (!entity.wa?.wa_phone_id || entity.wa?.wa_phone_id === waData.wa_phone_id)) {
                    await repo.updateWaVerified(userId, waData);
                    console.log(`[WhatsAppLink] Cross-verified WhatsApp for ${role} role`);
                }
            } catch (error) {
                // Log but don't fail — cross-role verification is best-effort
                console.error(`[WhatsAppLink] Failed to cross-verify ${role}:`, error);
            }
        }
    }

    /**
     * Get WhatsApp link status for a user
     * 
     * @param userId - User ID
     * @param role - User role
     * @returns Link status
     */
    async getStatus(userId: string, role: string): Promise<LinkStatus> {
        let entity: any;

        switch (role) {
            case 'vendor':
                entity = await this.vendorRepo.findByUserId(userId);
                break;
            case 'customer':
                entity = await this.customerRepo.findByUserId(userId);
                break;
            case 'agency':
                entity = await this.agencyRepo.findByUserId(userId);
                break;
            case 'agent':
                entity = await this.agentRepo.findByUserId(userId);
                break;
            default:
                return { linked: false };
        }

        if (!entity || !entity.wa?.verified) {
            return { linked: false };
        }

        return {
            linked: true,
            wa_phone_id: entity.wa.wa_phone_id,
            name: entity.wa.name,
            bound_at: entity.wa.bound_at
        };
    }

    /**
     * Unlink WhatsApp account for a user (single role only, not cross-role)
     * 
     * @param userId - User ID
     * @param role - User role
     */
    async unlinkAccount(userId: string, role: string): Promise<void> {
        let entity: any;

        switch (role) {
            case 'vendor':
                entity = await this.vendorRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw createAppError(ERROR_CODES.WHATSAPP_NOT_LINKED, 404);
                }
                await this.vendorRepo.unlinkWhatsApp(userId);
                break;
            case 'customer':
                entity = await this.customerRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw createAppError(ERROR_CODES.WHATSAPP_NOT_LINKED, 404);
                }
                await this.customerRepo.unlinkWhatsApp(userId);
                break;
            case 'agency':
                entity = await this.agencyRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw createAppError(ERROR_CODES.WHATSAPP_NOT_LINKED, 404);
                }
                await this.agencyRepo.unlinkWhatsApp(userId);
                break;
            case 'agent':
                entity = await this.agentRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw createAppError(ERROR_CODES.WHATSAPP_NOT_LINKED, 404);
                }
                await this.agentRepo.unlinkWhatsApp(userId);
                break;
            default:
                throw createAppError(ERROR_CODES.WHATSAPP_ROLE_NOT_SUPPORTED, 400, undefined, { role });
        }

        console.log(`[WhatsAppLink] Account unlinked for user ${userId} (${role})`);
    }
}
