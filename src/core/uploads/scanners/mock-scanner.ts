import { IVirusScanner } from '../upload-policy.types';

/**
 * Mock Virus Scanner
 * 
 * For development and testing.
 * Always returns clean: true unless simulate mode is enabled.
 */
export class MockScanner implements IVirusScanner {
  constructor(private readonly simulateVirus: boolean = false) {}

  async scan(buffer: Buffer, filename?: string): Promise<{
    clean: boolean;
    reason?: string;
    virus?: string;
  }> {
    // Simulate scan delay
    await new Promise(resolve => setTimeout(resolve, 10));

    if (this.simulateVirus) {
      return {
        clean: false,
        virus: 'EICAR-Test-File',
        reason: 'Test virus detected',
      };
    }

    return {
      clean: true,
    };
  }
}
