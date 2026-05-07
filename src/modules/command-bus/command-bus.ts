import { ZodType } from 'zod';
import { createAppError } from '../../core/errors';
import { ERROR_CODES } from '../../core/error-codes';

export type CommandHandler<T = any, R = any> = (payload: T, context: any) => Promise<R>;

interface CommandDefinition<T = any, R = any> {
  schema: ZodType<T, any, any>;
  handler: CommandHandler<T, R>;
}

export class CommandBus {
  private registry: Map<string, CommandDefinition> = new Map();

  /**
   * Register a new command handler with validation schema
   * @param name Unique name of the command
   * @param schema Zod schema to validate payload
   * @param handler Async function to execute
   */
  register<T, R>(name: string, schema: ZodType<T, any, any>, handler: CommandHandler<T, R>): void {
    if (this.registry.has(name)) {
      throw createAppError(ERROR_CODES.COMMAND_ALREADY_REGISTERED, 500, `Command "${name}" is already registered`);
    }
    this.registry.set(name, { schema, handler });
  }

  /**
   * Execute a command by name
   * @param name Name of the command to execute
   * @param payload Data to pass to the handler
   * @param context Context object (user, role, etc) to pass to the handler
   */
  async execute<R = any>(name: string, payload: unknown, context: any = {}): Promise<R> {
    const definition = this.registry.get(name);

    if (!definition) {
      throw createAppError(ERROR_CODES.COMMAND_NOT_FOUND, 404, `Command "${name}" not found`);
    }

    const validatedPayload = definition.schema.parse(payload);
    return await definition.handler(validatedPayload, context);
    // try {
    //   const validatedPayload = definition.schema.parse(payload);
    //   return await definition.handler(validatedPayload, context);
    // } catch (error) {
    //   throw error;
    // }
  }
}
