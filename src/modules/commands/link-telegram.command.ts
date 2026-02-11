import { z } from 'zod';
import { CommandHandler } from '../command-bus/command-bus';
import { TelegramLinkService } from '../telegram/services/telegram-link.service';

export const command_name = 'link_telegram';

export const schema = z.object({
    token: z.string().min(1),
    chat_id: z.string(),
    telegram_user_id: z.number(),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
});

export const handler: CommandHandler<z.infer<typeof schema>, any> = async (payload, context) => {
    console.log(`[LinkTelegramCommand] Processing for chat ${payload.chat_id}`);

    const linkService = new TelegramLinkService();

    const result = await linkService.handleStartCommand(payload.token, {
        chatId: payload.chat_id,
        telegramUserId: payload.telegram_user_id,
        firstName: payload.first_name,
        lastName: payload.last_name,
        username: payload.username,
    });

    return result;
};
