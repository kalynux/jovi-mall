import 'dotenv/config';
import axios, { AxiosInstance } from 'axios';
import { WhatsAppProvider } from './provider.interface';
import { SendResult } from '../types/whatsapp-message.types';
import { ProviderPayload } from '../handlers/handler.interface';
import { createAppError } from '../../../core/errors';
import { ERROR_CODES } from '../../../core/error-codes';
import { recordIntegrationCall } from '../../system/domain/integration-observations';

/**
 * Meta WhatsApp Cloud Provider
 * 
 * THE ONLY provider implementation.
 * This is provider-isolated, not provider-agnostic.
 * 
 * Environment Variables Required:
 * - WHATSAPP_API_URL (e.g., https://graph.facebook.com/v26.0)
 * - WHATSAPP_PHONE_NUMBER_ID
 * - WHATSAPP_ACCESS_TOKEN
 */
export class MetaWhatsAppCloudProvider implements WhatsAppProvider {
    private client: AxiosInstance;
    private phoneNumberId: string;

    constructor() {
        // ⚠ This fallback is a VERSION PIN, and an unmaintained one expires silently. v18.0
        // was the default here until 2026-09-07 and had expired on 2026-01-26 — Meta routes a
        // call to an expired version to the oldest usable next one rather than refusing it, so
        // no error is ever raised and the effective version drifts on Meta's schedule instead
        // of ours. Check the changelog when touching this, do not merely preserve it.
        const apiUrl = process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v26.0';
        const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
        this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

        if (!accessToken) {
            throw createAppError(
                ERROR_CODES.CONFIG_MISSING_WA_ACCESS_TOKEN,
                500,
                'WHATSAPP_ACCESS_TOKEN environment variable is required'
            );
        }

        if (!this.phoneNumberId) {
            throw createAppError(
                ERROR_CODES.CONFIG_MISSING_WA_PHONE_ID,
                500,
                'WHATSAPP_PHONE_NUMBER_ID environment variable is required'
            );
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
        // The only reachability signal `/system/integrations` can honestly have for WhatsApp.
        // Probing it means sending a message to a real person and paying for it, so the
        // catalog marks it `never` and this — a send that was happening anyway — is what the
        // operations surface reports instead.
        const observedAt = Date.now();

        try {
            const endpoint = `/${this.phoneNumberId}/messages`;

            console.log(`[MetaWhatsAppCloudProvider] Sending ${payload.type} message to ${payload.to}`);

            const response = await this.client.post(endpoint, payload);
            recordIntegrationCall('whatsapp', observedAt);

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
            recordIntegrationCall('whatsapp', observedAt, error);
            console.error('[MetaWhatsAppCloudProvider] Send failed:', error);

            // Handle WhatsApp API errors
            if (error.response) {
                const whatsappError = error.response.data?.error;

                if (whatsappError) {
                    throw createAppError(
                        ERROR_CODES.WHATSAPP_PROVIDER_REJECTED,
                        502,
                        whatsappError.message || 'Unknown WhatsApp error',
                        {
                            code: whatsappError.code || error.response.status,
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
