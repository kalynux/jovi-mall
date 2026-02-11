import { SendResult } from '../types/whatsapp-message.types';
import { ProviderPayload } from '../handlers/handler.interface';

/**
 * WhatsApp Provider Interface
 * 
 * IMPORTANT: This interface exists for TESTING and ISOLATION, NOT multi-provider support.
 * There will be exactly ONE implementation for the foreseeable future: Meta Cloud API.
 * 
 * This is PROVIDER-ISOLATED, not provider-agnostic.
 */
export interface WhatsAppProvider {
    /**
     * Send message via provider
     * 
     * @param payload - WhatsApp-native provider payload
     * @returns Send result with message ID or error
     */
    send(payload: ProviderPayload): Promise<SendResult>;

    /**
     * Get provider name (for logging)
     */
    getName(): string;
}
