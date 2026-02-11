/**
 * Audit Log Entry Interface
 * 
 * Captures critical actions for compliance, security, and debugging.
 */
export interface AuditLogEntry {
  /** Who performed the action */
  actor: {
    userId: string;
    role: string;
    /** Optional: IP address, user agent, etc. */
    metadata?: Record<string, any>;
  };
  /** What action was performed (e.g., 'VENDOR_PROFILE_UPDATED', 'PASSWORD_CHANGED') */
  action: string;
  /** What resource was affected */
  resource: {
    type: string; // e.g., 'Vendor', 'User', 'Order'
    id: string;
  };
  /** Optional: What changed (before/after diff) */
  changes?: Record<string, any>;
  /** Optional: Additional context */
  metadata?: Record<string, any>;
  /** When the action occurred */
  timestamp: Date;
}

/**
 * Audit Logger Abstraction
 * 
 * Logs critical actions for compliance and security auditing.
 * 
 * DESIGN NOTE:
 * - This is a stub implementation for Day 1
 * - Logs to console for development
 * - Ready to be upgraded to database persistence
 * 
 * COMPLIANCE REQUIREMENTS:
 * - Should be tamper-proof (append-only)
 * - Should be queryable by actor, action, resource, time range
 * - Should have retention policies
 * - Should support export for compliance reporting
 * 
 * FUTURE ENHANCEMENTS:
 * - Persist to dedicated audit_logs collection
 * - Add indexing on actor.userId, resource.id, timestamp
 * - Add query methods: findByActor, findByResource, findByTimeRange
 * - Add export to CSV/JSON for compliance reports
 * - Add integration with SIEM systems
 * - Add encryption for sensitive data in changes field
 */
export class AuditLogger {
  /**
   * Log an audit entry
   * 
   * @param entry - Audit log entry with actor, action, resource, and optional changes
   */
  async log(entry: AuditLogEntry): Promise<void> {
    // Stub implementation - log to console
    const logMessage = {
      timestamp: entry.timestamp.toISOString(),
      actor: `${entry.actor.role}:${entry.actor.userId}`,
      action: entry.action,
      resource: `${entry.resource.type}:${entry.resource.id}`,
      ...(entry.changes && { changes: entry.changes }),
      ...(entry.metadata && { metadata: entry.metadata }),
    };
    
    console.log('[Audit]', JSON.stringify(logMessage, null, 2));
    
    // TODO: Future implementation
    // - Persist to database (append-only)
    // - Add encryption for sensitive fields
    // - Trigger alerts for high-risk actions
    // - Send to SIEM system
  }
  
  /**
   * Query audit logs (stub)
   * 
   * This method is a placeholder for future implementation.
   * In production, this would query the audit_logs collection.
   */
  async query(filters: {
    actorId?: string;
    resourceType?: string;
    resourceId?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
  }): Promise<AuditLogEntry[]> {
    // TODO: Implement query logic when persistence is added
    console.log('[Audit] Query not yet implemented:', filters);
    return [];
  }
}

// Singleton instance
export const auditLogger = new AuditLogger();
