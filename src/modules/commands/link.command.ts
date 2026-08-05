import { z } from 'zod';
import { CommandHandler } from '../command-bus/command-bus';
import { WhatsAppLinkService } from '../whatsapp/services/whatsapp-link.service';

export const command_name = 'link';

/**
 * `from` and `wa_phone_id` are DELIBERATELY exempt from the platform's E.164
 * rule (core/validation/phone), and this is the one place that exemption is
 * worth stating: they are not contact fields a user typed, they are the
 * WhatsApp-assigned identifiers Meta puts on an inbound webhook — digits with
 * no leading `+`. Holding them to E.164 would reject every real webhook. They
 * are stored as `wa.wa_phone_id`, never as anyone's `phone`.
 */
export const schema = z.object({
    code: z.string().min(1),
    from: z.string(), // The WA-assigned sender id (NOT an E.164 phone number)
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
