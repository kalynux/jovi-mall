import { z } from 'zod';
import { CommandHandler } from '../command-bus/command-bus';
import { WhatsAppLinkService } from '../whatsapp/services/whatsapp-link.service';

export const command_name = 'link';

export const schema = z.object({
    code: z.string().min(1),
    from: z.string(),       // The phone number from WA
    wa_phone_id: z.string() // The strictly unique WA ID
});

export const handler: CommandHandler<z.infer<typeof schema>, any> = async (payload, context) => {
    console.log(`[LinkWA] Processing code: ${payload.code}`);

    // Use WhatsAppLinkService for verification (single source of truth)
    const linkService = new WhatsAppLinkService();
    const result = await linkService.verifyCode(payload.code, payload.wa_phone_id);

    if (!result.success) {
        throw new Error(result.message);
    }

    return result;
};
