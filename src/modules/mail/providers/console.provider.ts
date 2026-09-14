import { IMailProvider, ProviderSendOptions } from '../mail.interface';

export class ConsoleMailProvider implements IMailProvider {
  readonly name = 'console' as const;

  /**
   * Always reachable — there is no backend to fail.
   *
   * Reporting "ok" here is honest rather than flattering: the console provider genuinely can
   * deliver everything it promises to deliver. Whether that is what the deployment WANTS is a
   * different column, and `/system/integrations` answers it separately via `configured`.
   */
  async verify(): Promise<void> {
    // Nothing to check.
  }

  /**
   * ⚠ **Never put this in a chain with a real provider.** It cannot fail, so it would swallow
   * every message that reached it and report success — the chain would look healthy while
   * delivering nothing, which is the single failure mode this whole module exists to end.
   * `mail.factory.ts` appends it only when the chain would otherwise be EMPTY, and says so
   * loudly when it does.
   */
  async sendEmail(options: ProviderSendOptions): Promise<void> {
    console.log('--- [Mail] Sending Email ---');
    console.log(`To:      ${options.to}`);
    console.log(`From:    ${options.from}`);
    console.log(`Subject: ${options.subject}`);
    console.log(`HTML:    ${options.html.substring(0, 50)}...`);
    console.log('----------------------------');
  }
}
