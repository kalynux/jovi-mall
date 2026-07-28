import { ClientSession, startSession } from 'mongoose';

export class TransactionManager {
  /**
   * Executes a function within a MongoDB transaction.
   * Handles commit and rollback automatically.
   *
   * NOTE: this variant does NOT retry. It aborts and rethrows on any error,
   * including a transient write-conflict (`TransientTransactionError`). For a
   * contended path where two writers legitimately race for the same document —
   * e.g. concurrent accepts of the same shipment — prefer
   * `runInTransactionWithRetry`, which re-runs the whole callback on a transient
   * conflict instead of surfacing a spurious failure to the caller.
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

  /**
   * Executes a function within a transaction that AUTOMATICALLY RETRIES on a
   * transient error, via the driver's `session.withTransaction`.
   *
   * MongoDB may abort a transaction with a `TransientTransactionError` (a write
   * conflict, a primary step-down, etc.) that is safe to retry: the driver
   * re-invokes the callback with the same session until it commits or a
   * non-transient error is thrown. This is the correct primitive for the
   * high-contention money/assignment paths — without it, two agents accepting
   * the same shipment at the same instant would surface a write-conflict as an
   * error to one of them rather than cleanly re-evaluating (and getting the
   * honest "already assigned" answer).
   *
   * The callback MUST be idempotent across retries: it may run more than once,
   * so it must not rely on side effects from a prior aborted attempt. All the
   * guarded compare-and-set writes it wraps satisfy this — a retry simply
   * re-reads the now-committed state and takes the correct branch.
   */
  async runInTransactionWithRetry<T>(
    fn: (session: ClientSession) => Promise<T>
  ): Promise<T> {
    const session = await startSession();
    try {
      // `withTransaction` returns the callback's resolved value (driver v4+),
      // retrying the whole block on a transient error. Cast because Mongoose's
      // type for the return is `unknown`.
      const result = await session.withTransaction(async () => fn(session));
      return result as T;
    } finally {
      await session.endSession();
    }
  }
}

export const transactionManager = new TransactionManager();
