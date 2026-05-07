import { Request, Response, NextFunction } from 'express';
import { WhatsappService } from './whatsapp.service';
import { WhatsAppLinkService } from './services/whatsapp-link.service';
import { CommandBus } from '../command-bus/command-bus';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

interface WhatsappWebhookPayload {
  reply_to: string;
  wa_phone_id?: string;
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

  getStatus = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user?.id;
    const role = req.auth?.role;

    if (!userId || !role) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }

    const status = await this.linkService.getStatus(userId, role);
    res.status(200).json(status);
  });

  unlinkAccount = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.auth?.user?.id;
    const role = req.auth?.role;

    if (!userId || !role) {
      return next(createAppError(ERROR_CODES.AUTH_MISSING_TOKEN, 401));
    }

    await this.linkService.unlinkAccount(userId, role);
    res.status(200).json({ success: true, message: 'WhatsApp account unlinked' });
  });
}
