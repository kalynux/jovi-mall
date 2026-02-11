import { ClientSession, startSession } from 'mongoose';

export class TransactionManager {
  /**
   * Executes a function within a MongoDB transaction.
   * Handles commit and rollback automatically.
   */
  async runInTransaction<T>(
    fn: (session: ClientSession) => Promise<T>
  ): Promise<T> {
    const session = await startSession();
    session.startTransaction();

    try {
      const result = await fn(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      await session.abortTransaction();
      throw error; // Re-throw to be handled by caller
    } finally {
      await session.endSession();
    }
  }
}

export const transactionManager = new TransactionManager();
