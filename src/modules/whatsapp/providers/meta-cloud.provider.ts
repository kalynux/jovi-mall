import axios, { AxiosInstance } from 'axios';
import { WhatsAppProvider } from './provider.interface';
import { SendResult } from '../types/whatsapp-message.types';
import { ProviderPayload } from '../handlers/handler.interface';
import { ProviderRejectedMessageError } from '../types/whatsapp-error.types';

/**
 * Meta WhatsApp Cloud Provider
 * 
 * THE ONLY provider implementation.
 * This is provider-isolated, not provider-agnostic.
 * 
 * Environment Variables Required:
 * - WHATSAPP_API_URL (e.g., https://graph.facebook.com/v18.0)
 * - WHATSAPP_PHONE_NUMBER_ID
 * - WHATSAPP_ACCESS_TOKEN
 */
export class MetaWhatsAppCloudProvider implements WhatsAppProvider {
    private client: AxiosInstance;
    private phoneNumberId: string;

    constructor() {
        const apiUrl = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v18.0';
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

        if (!accessToken) {
            throw new Error('WHATSAPP_ACCESS_TOKEN environment variable is required');
        }

        if (!this.phoneNumberId) {
            throw new Error('WHATSAPP_PHONE_NUMBER_ID environment variable is required');
        }

        // Configure HTTP client
        this.client = axios.create({
            baseURL: apiUrl,
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            timeout: 30000, // 30 second timeout
        });
    }

    async send(payload: ProviderPayload): Promise<SendResult> {
        try {
            const endpoint = `/${this.phoneNumberId}/messages`;

            console.log(`[MetaWhatsAppCloudProvider] Sending ${payload.type} message to ${payload.to}`);

            const response = await this.client.post(endpoint, payload);

            // WhatsApp Cloud API response format:
            // {
            //   messaging_product: 'whatsapp',
            //   contacts: [{ input: '...', wa_id: '...' }],
            //   messages: [{ id: 'wamid.xxx' }]
            // }

            const messageId = response.data.messages?.[0]?.id;

            return {
                success: true,
                messageId,
                meta: {
                    timestamp: new Date(),
                },
            };
        } catch (error: any) {
            console.error('[MetaWhatsAppCloudProvider] Send failed:', error);

            // Handle WhatsApp API errors
            if (error.response) {
                const whatsappError = error.response.data?.error;

                if (whatsappError) {
                    throw new ProviderRejectedMessageError(
                        whatsappError.code || error.response.status,
                        whatsappError.message || 'Unknown WhatsApp error',
                        {
                            errorData: whatsappError.error_data,
                            type: whatsappError.type,
                            fbtrace_id: whatsappError.fbtrace_id,
                        }
                    );
                }
            }

            // Network or other errors
            return {
                success: false,
                error: {
                    code: 'PROVIDER_ERROR',
                    message: error.message || 'Failed to send message',
                    details: {
                        name: error.name,
                        stack: error.stack,
                    },
                },
                meta: {
                    timestamp: new Date(),
                },
            };
        }
    }

    getName(): string {
        return 'Meta WhatsApp Cloud API';
    }
}
