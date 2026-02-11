import { IStorageProvider } from '../../../../../core/storage';
import { IFileRepository } from '../../../repositories/interfaces/file.repository.interface';

export interface GarbageCollectOptions {
  gracePeriodHours?: number;  // default: 24 hours
  batchSize?: number;         // default: 100
}

/**
 * OrphanFileGarbageCollectorService
 * 
 * Periodically cleans up orphaned files that have exceeded the grace period.
 * 
 * Grace period prevents accidental deletion of files that were just uploaded
 * but not yet attached to an entity.
 * 
 * This service is typically run as a cron job or scheduled task.
 */
export class OrphanFileGarbageCollectorService {
  private readonly DEFAULT_GRACE_PERIOD_HOURS = 24;
  private readonly DEFAULT_BATCH_SIZE = 100;

  constructor(
    private readonly storageProvider: IStorageProvider,
    private readonly fileRepository: IFileRepository
  ) {}

  /**
   * Run garbage collection on orphaned files
   * @param options - GC options (grace period, batch size)
   * @returns Number of files deleted
   */
  async execute(options: GarbageCollectOptions = {}): Promise<number> {
    const gracePeriodHours = options.gracePeriodHours ?? this.DEFAULT_GRACE_PERIOD_HOURS;
    const batchSize = options.batchSize ?? this.DEFAULT_BATCH_SIZE;

    // Calculate cutoff date
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - gracePeriodHours);

    // Find orphaned files older than cutoff
    const orphans = await this.fileRepository.findOrphans(cutoffDate);
    
    // Limit to batch size
    const filesToDelete = orphans.slice(0, batchSize);

    let deletedCount = 0;

    for (const file of filesToDelete) {
      try {
        // Delete physical file
        await this.storageProvider.delete(file.key);
        
        // Delete database record
        await this.fileRepository.hardDelete(file.id);
        
        deletedCount++;
      } catch (error) {
        // Log error but continue with other files
        console.error(`Failed to delete orphan file ${file.id}:`, error);
      }
    }

    return deletedCount;
  }
}
