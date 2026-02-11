import { CommandBus } from '../command-bus/command-bus';
import * as VerifyWaCommand from './link.command';
import * as LinkTelegramCommand from './link-telegram.command';

export function register_all_commands(bus: CommandBus) {
  bus.register(VerifyWaCommand.command_name, VerifyWaCommand.schema, VerifyWaCommand.handler);
  console.log('✅ Registered Command:', VerifyWaCommand.command_name);

  bus.register(LinkTelegramCommand.command_name, LinkTelegramCommand.schema, LinkTelegramCommand.handler);
  console.log('✅ Registered Command:', LinkTelegramCommand.command_name);
}
