import { IVirusScanner } from '../upload-policy.types';

/**
 * ClamAV Scanner
 * 
 * Stub implementation for future ClamAV integration.
 * Requires `clamscan` npm package and running ClamAV daemon.
 * 
 * TODO: Implement when ClamAV is ready
 */
export class ClamAVScanner implements IVirusScanner {
  constructor() {
    console.warn('ClamAVScanner is not yet implemented. Falling back to clean response.');
  }

  async scan(buffer: Buffer, filename?: string): Promise<{
    clean: boolean;
    reason?: string;
    virus?: string;
  }> {
    // TODO: Implement ClamAV scanning
    // 1. npm install clamscan
    // 2. Initialize ClamAV client
    // 3. Scan buffer
    // 4. Return results
    
    console.warn(`ClamAV scan not implemented for file: ${filename}`);
    
    return {
      clean: true,
      reason: 'ClamAV not configured - defaulting to clean',
    };
  }
}
