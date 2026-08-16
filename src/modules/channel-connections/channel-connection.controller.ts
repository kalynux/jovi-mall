import { Request, Response } from 'express';
import { asyncHandler } from '../../api/middlewares/async-handler';
import { sendSuccess, sendMessage } from '../../core/responses';
import { connectionService } from './services/channel-connection.service';
import { ConnectionMapper } from './dto/channel-connection.dto';
import { RedeemConnectionCodeSchema, ChannelParamSchema } from './validators/channel-connection.validator';

/**
 * Messaging connections (mounted at /api/me/connections).
 *
 * Role-agnostic: a connection binds to the User, so a person who is both a
 * vendor and a customer connects once and it holds for everything. That is the
 * difference from the WhatsApp linking this replaces, which resolved the target
 * from `req.auth.role` and therefore answered a different question depending on
 * which dashboard was asking.
 */
export class ConnectionController {
  /** Both channels' state, plus how to connect the ones that are not. */
  static list = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user._id.toString();
    const states = await connectionService.getStates(userId);
    sendSuccess(res, { connections: ConnectionMapper.toDtoList(states) });
  });

  /** Redeem a code minted by a bot and bind that identity to this account. */
  static redeem = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user._id.toString();
    const { code } = RedeemConnectionCodeSchema.parse(req.body ?? {});

    const connection = await connectionService.redeemCode(userId, code);

    sendSuccess(res, ConnectionMapper.toConnectedDto(connection), {
      message: 'Connected',
    });
  });

  static disconnect = asyncHandler(async (req: Request, res: Response) => {
    const userId = req.auth!.user._id.toString();
    const { channel } = ChannelParamSchema.parse(req.params);

    await connectionService.disconnect(userId, channel);
    sendMessage(res, 'Disconnected');
  });
}
