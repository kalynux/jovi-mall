import { Request, Response } from 'express';
import { WhatsappService } from './whatsapp.service';
import { WhatsAppLinkService } from './services/whatsapp-link.service';
import { CommandBus } from '../command-bus/command-bus';

interface WhatsappWebhookPayload {
  reply_to: string; // The WA ID
  wa_phone_id?: string; // Sometimes distinct
  user_id?: string;
  is_command: boolean;
  command?: string;
  payload?: any;
}

export class WhatsappController {
  private waService: WhatsappService;
  private linkService: WhatsAppLinkService;
  private commandBus: CommandBus;

  constructor(commandBus: CommandBus) {
    this.waService = new WhatsappService();
    this.linkService = new WhatsAppLinkService();
    this.commandBus = commandBus;
  }

  handleWebhook = async (req: Request, res: Response) => {
    try {
      const body: WhatsappWebhookPayload = req.body;
      const { reply_to, is_command, command, payload, user_id } = body;

      // 1. Record Inbound (Open Chat Window)
      await this.waService.recordInbound(reply_to, user_id);

      // 2. Handle Command
      let result = { message: 'Inbound recorded' };
      if (is_command && command) {
        // Construct context
        const context = {
          source: 'whatsapp',
          wa_phone_id: reply_to,
          user_id
        };

        // Execute via Bus (including link command)
        console.log(`[WA-Webhook] Dispatching command: ${command}`);
        const cmdResult = await this.commandBus.execute(command, payload, context);
        result = { ...result, ...cmdResult };
      }

      res.status(200).json(result);
    } catch (error: any) {
      console.error('[WA-Webhook] Error:', error.message);
      res.status(400).json({ error: error.message });
    }
  };

  /**
   * Get WhatsApp link status for authenticated user
   */
  getStatus = async (req: Request, res: Response) => {
    try {
      const userId = req.auth?.user?.id;
      const role = req.auth?.role;

      if (!userId || !role) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const status = await this.linkService.getStatus(userId, role);
      res.status(200).json(status);
    } catch (error: any) {
      console.error('[WhatsApp] Error getting status:', error.message);
      res.status(500).json({ error: 'Failed to get status' });
    }
  };

  /**
   * Unlink WhatsApp account for authenticated user
   */
  unlinkAccount = async (req: Request, res: Response) => {
    try {
      const userId = req.auth?.user?.id;
      const role = req.auth?.role;

      if (!userId || !role) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      await this.linkService.unlinkAccount(userId, role);
      res.status(200).json({ success: true, message: 'WhatsApp account unlinked' });
    } catch (error: any) {
      console.error('[WhatsApp] Error unlinking account:', error.message);

      if (error.message.includes('No WhatsApp account')) {
        res.status(404).json({ error: 'No WhatsApp account linked' });
        return;
      }

      res.status(500).json({ error: 'Failed to unlink account' });
    }
  };
}
