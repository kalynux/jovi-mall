import { Request, Response } from 'express';
import { WhatsappService } from './whatsapp.service';
import { CommandBus } from '../command-bus/command-bus';
import { asyncHandler } from '../../api/middlewares/async-handler';

interface WhatsappWebhookPayload {
  reply_to: string;
  wa_phone_id?: string;
  user_id?: string;
  is_command: boolean;
  command?: string;
  payload?: any;
}

/**
 * WhatsApp bot ingress.
 *
 * Account linking is NOT here any more. `GET /link/status` and `DELETE /link`
 * moved to `/api/me/connections`: they were role-scoped (answering a different
 * question depending on which dashboard held the token) and, being routed under
 * `/api/webhooks`, unthrottled. This controller keeps the webhook alone.
 */
export class WhatsappController {
  private waService: WhatsappService;
  private commandBus: CommandBus;

  constructor(commandBus: CommandBus) {
    this.waService = new WhatsappService();
    this.commandBus = commandBus;
  }

  /**
   * Inbound messages, relayed by the automation layer.
   *
   * Phase 4 registers `connect` on the bus; the context carries `wa_phone_id`,
   * which IS the messaging identity the code will be minted against.
   */
  handleWebhook = asyncHandler(async (req: Request, res: Response) => {
    const body: WhatsappWebhookPayload = req.body;
    const { reply_to, is_command, command, payload, user_id } = body;

    await this.waService.recordInbound(reply_to, user_id);

    let result = { message: 'Inbound recorded' };
    if (is_command && command) {
      const context = { source: 'whatsapp', wa_phone_id: reply_to, user_id };
      const cmdResult = await this.commandBus.execute(command, payload, context);
      result = { ...result, ...cmdResult };
    }

    res.status(200).json(result);
  });
}
