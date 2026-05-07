import { z } from 'zod';
import { CommandHandler } from '../command-bus/command-bus';
import { WhatsAppLinkService } from '../whatsapp/services/whatsapp-link.service';

export const command_name = 'link';

export const schema = z.object({
    code: z.string().min(1),
    from: z.string(), // The phone number from WA
    wa_data: z.object({
        wa_phone_id: z.string(), // The strictly unique WA ID
        name: z.string()
    })
});

export const handler: CommandHandler<z.infer<typeof schema>, any> = async (payload, context) => {
    console.log(`[LinkWA] Processing code: ${payload.code}`);
    console.log(`[LinkWA] Processing wa_data: ${JSON.stringify(payload.wa_data)}`);

    const linkService = new WhatsAppLinkService();
    await linkService.verifyCode(payload.code, payload.wa_data);

    return { success: true, message: 'WhatsApp account linked successfully!' };
};
