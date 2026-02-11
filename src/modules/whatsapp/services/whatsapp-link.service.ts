import { VendorRepository } from '../../vendors/vendor.repository';
import { CustomerRepository } from '../../customers/customer.repository';
import { DeliveryAgencyRepository } from '../../delivery/delivery-agency.repository';
import { DeliveryAgentRepository } from '../../delivery/delivery-agent.repository';
import { getRedisClient, WA_VERIFY_DB } from '../../../infra/redis/redis.factory';

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

    constructor() {
        this.vendorRepo = new VendorRepository();
        this.customerRepo = new CustomerRepository();
        this.agencyRepo = new DeliveryAgencyRepository();
        this.agentRepo = new DeliveryAgentRepository();
    }

    /**
     * Verify code and link WhatsApp account
     * Called by webhook when user sends /link:CODE command
     * 
     * @param code - Verification code from user
     * @param waPhoneId - WhatsApp phone ID from webhook (reply_to)
     * @returns Success status
     */
    async verifyCode(code: string, waPhoneId: string): Promise<{ success: boolean; message: string }> {
        const redis = await getRedisClient(WA_VERIFY_DB);
        const key = `wa_verify:${code}`;
        const value = await redis.get(key);

        if (!value) {
            console.log(`[WhatsAppLink] Invalid or expired code: ${code}`);
            return {
                success: false,
                message: 'Invalid or expired verification code. Please request a new code.'
            };
        }

        const data = JSON.parse(value);
        const { user_id, role, wa_phone_id: expectedWaPhoneId } = data;

        // Validate phone ID matches
        if (expectedWaPhoneId !== waPhoneId) {
            console.log(`[WhatsAppLink] Phone ID mismatch. Expected ${expectedWaPhoneId}, got ${waPhoneId}`);
            return {
                success: false,
                message: 'WhatsApp account mismatch. Please use the correct WhatsApp account.'
            };
        }

        // Delete token (single-use)
        await redis.del(key);

        // Update primary role entity
        try {
            const waData = {
                wa_phone_id: waPhoneId,
                name: data.name
            };

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
                    throw new Error(`Role ${role} does not support WhatsApp linking`);
            }

            console.log(`[WhatsAppLink] Account linked for user ${user_id} (${role})`);

            // Cross-role verification: update other roles that don't have WhatsApp verified
            await this.crossRoleVerification(user_id, role, waPhoneId, data.name);

            return {
                success: true,
                message: 'WhatsApp account linked successfully!'
            };
        } catch (error: any) {
            console.error('[WhatsAppLink] Error linking account:', error);
            return {
                success: false,
                message: 'Failed to link WhatsApp account. Please try again.'
            };
        }
    }

    /**
     * Cross-role verification: Verify WhatsApp on other roles if not already verified
     * 
     * @param userId - User ID
     * @param primaryRole - The role that initiated verification
     * @param waPhoneId - WhatsApp phone ID to verify
     * @param name - Name to store
     */
    private async crossRoleVerification(
        userId: string,
        primaryRole: string,
        waPhoneId: string,
        name?: string
    ): Promise<void> {
        const roles = ['vendor', 'customer', 'agency', 'agent'];
        const otherRoles = roles.filter(r => r !== primaryRole);

        const waData = { wa_phone_id: waPhoneId, name };

        for (const role of otherRoles) {
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
                }

                // Only update if entity exists AND WhatsApp is NOT already verified
                if (entity && !entity.wa?.verified && (!entity.wa?.wa_phone_id || entity.wa?.wa_phone_id === waPhoneId)) {
                    await repo.updateWaVerified(userId, waData);
                    console.log(`[WhatsAppLink] Cross-verified WhatsApp for ${role} role`);
                }
            } catch (error) {
                // Log but don't fail - cross-role verification is best-effort
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
        let entity: any = null;

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
        let entity: any = null;

        switch (role) {
            case 'vendor':
                entity = await this.vendorRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw new Error('No WhatsApp account linked');
                }
                await this.vendorRepo.unlinkWhatsApp(userId);
                break;
            case 'customer':
                entity = await this.customerRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw new Error('No WhatsApp account linked');
                }
                await this.customerRepo.unlinkWhatsApp(userId);
                break;
            case 'agency':
                entity = await this.agencyRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw new Error('No WhatsApp account linked');
                }
                await this.agencyRepo.unlinkWhatsApp(userId);
                break;
            case 'agent':
                entity = await this.agentRepo.findByUserId(userId);
                if (!entity?.wa?.verified) {
                    throw new Error('No WhatsApp account linked');
                }
                await this.agentRepo.unlinkWhatsApp(userId);
                break;
            default:
                throw new Error(`Role ${role} does not support WhatsApp linking`);
        }

        console.log(`[WhatsAppLink] Account unlinked for user ${userId} (${role})`);
    }
}
