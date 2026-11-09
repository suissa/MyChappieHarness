/**
 * Execution State - Event-sourced execution tracking
 * 
 * Execution state is represented as an event log rather than mutable objects.
 * This enables:
 * - Reconstruction of execution state from events
 * - Audit trails for compliance
 * - Configurable retention policies
 * - Recovery from failures
 */

import type {
  ExecutionId,
  CapabilityId,
  ActorId,
  ExecutionState as ExecutionStatus,
  ToolEvent,
  ToolLifecycleEvent,
  ToolRequest,
  ToolResult,
  JsonValue,
  ExecutionContext,
} from './types.ts'
import type { EventEnvelope } from './events.ts'

/**
 * Event log entry with metadata
 */
export interface ExecutionLogEntry {
  /** Sequence number within the execution */
  readonly sequence: number
  /** Event envelope */
  readonly envelope: EventEnvelope<ToolEvent>
  /** Timestamp when logged */
  readonly loggedAt: number
}

/**
 * Reconstructed execution state from event log
 */
export interface ExecutionSnapshot {
  readonly executionId: ExecutionId
  readonly capability: CapabilityId
  readonly target?: string
  readonly status: ExecutionStatus
  readonly actorId?: ActorId
  readonly arguments?: JsonValue
  readonly context?: ExecutionContext
  readonly result?: JsonValue
  readonly isError?: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly eventCount: number
}

/**
 * Retention policy configuration
 */
export interface RetentionPolicy {
  /** How long to keep full execution state (default: 24h) */
  executionStateMs: number
  /** How long to keep results after completion (default: 10m) */
  resultsMs: number
  /** How long to keep audit events (default: 90d) */
  auditEventsMs: number
}

/**
 * Default retention policy
 */
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  executionStateMs: 24 * 60 * 60 * 1000,      // 24 hours
  resultsMs: 10 * 60 * 1000,                   // 10 minutes
  auditEventsMs: 90 * 24 * 60 * 60 * 1000,    // 90 days
}

/**
 * Execution state store interface
 */
export interface ExecutionStateStore {
  /** Append an event to an execution's log */
  append(executionId: ExecutionId, envelope: EventEnvelope<ToolEvent>): Promise<void>
  
  /** Get all events for an execution */
  getEvents(executionId: ExecutionId): Promise<ExecutionLogEntry[]>
  
  /** Get reconstructed snapshot of an execution */
  getSnapshot(executionId: ExecutionId): Promise<ExecutionSnapshot | undefined>
  
  /** Delete an execution's state */
  delete(executionId: ExecutionId): Promise<void>
  
  /** Apply retention policy, removing old entries */
  applyRetentionPolicy(policy: RetentionPolicy): Promise<number>
}

/**
 * In-memory execution state store implementation
 */
export class InMemoryExecutionStateStore implements ExecutionStateStore {
  private logs = new Map<ExecutionId, ExecutionLogEntry[]>()
  private snapshots = new Map<ExecutionId, ExecutionSnapshot>()

  async append(executionId: ExecutionId, envelope: EventEnvelope<ToolEvent>): Promise<void> {
    let entries = this.logs.get(executionId)
    if (!entries) {
      entries = []
      this.logs.set(executionId, entries)
    }

    const entry: ExecutionLogEntry = {
      sequence: entries.length,
      envelope,
      loggedAt: Date.now(),
    }
    entries.push(entry)

    // Update snapshot
    this.updateSnapshot(executionId, entry)
  }

  private updateSnapshot(executionId: ExecutionId, entry: ExecutionLogEntry): void {
    const event = entry.envelope.payload
    
    let snapshot = this.snapshots.get(executionId)
    
    if (!snapshot) {
      // Create initial snapshot from request event
      if (event.type === 'tool.request') {
        snapshot = {
          executionId,
          capability: event.capability,
          target: event.target,
          status: 'requested',
          arguments: event.arguments,
          context: event.context,
          createdAt: entry.loggedAt,
          updatedAt: entry.loggedAt,
          eventCount: 1,
        }
        this.snapshots.set(executionId, snapshot)
      }
      return
    }

    // Update based on event type
    switch (event.type) {
      case 'tool.accepted':
        snapshot.actorId = event.actorId
        snapshot.status = 'accepted'
        break
      case 'tool.started':
        snapshot.actorId = event.actorId
        snapshot.status = 'started'
        break
      case 'tool.progress':
        snapshot.status = 'progress'
        break
      case 'tool.completed':
        snapshot.status = 'completed'
        snapshot.result = event.result
        snapshot.isError = false
        break
      case 'tool.failed':
        snapshot.status = 'failed'
        snapshot.result = { error: event.error }
        snapshot.isError = true
        break
      case 'tool.cancelled':
        snapshot.status = 'cancelled'
        break
      case 'tool.expired':
        snapshot.status = 'expired'
        break
    }

    snapshot.updatedAt = entry.loggedAt
    snapshot.eventCount = entry.sequence + 1
  }

  async getEvents(executionId: ExecutionId): Promise<ExecutionLogEntry[]> {
    return this.logs.get(executionId) ?? []
  }

  async getSnapshot(executionId: ExecutionId): Promise<ExecutionSnapshot | undefined> {
    return this.snapshots.get(executionId)
  }

  async delete(executionId: ExecutionId): Promise<void> {
    this.logs.delete(executionId)
    this.snapshots.delete(executionId)
  }

  async applyRetentionPolicy(policy: RetentionPolicy): Promise<number> {
    const now = Date.now()
    let deletedCount = 0

    for (const [executionId, snapshot] of this.snapshots.entries()) {
      const age = now - snapshot.updatedAt
      const events = this.logs.get(executionId) ?? []
      
      let shouldDelete = false
      
      if (snapshot.status === 'completed' || snapshot.status === 'failed') {
        // For completed/failed executions, check results retention
        if (age > policy.resultsMs) {
          shouldDelete = true
        }
      } else if (age > policy.executionStateMs) {
        // For in-progress or recent executions, check state retention
        shouldDelete = true
      }

      if (shouldDelete) {
        await this.delete(executionId)
        deletedCount++
      }
    }

    return deletedCount
  }

  /**
   * Reconstruct snapshot from event log (alternative to cached snapshot)
   */
  reconstructSnapshot(executionId: ExecutionId): ExecutionSnapshot | undefined {
    const events = this.logs.get(executionId)
    if (!events || events.length === 0) return undefined

    let snapshot: Partial<ExecutionSnapshot> = {
      executionId,
      createdAt: events[0].loggedAt,
      updatedAt: events[events.length - 1].loggedAt,
      eventCount: events.length,
      status: 'requested',
    }

    for (const entry of events) {
      const event = entry.envelope.payload
      
      switch (event.type) {
        case 'tool.request':
          snapshot.capability = event.capability
          snapshot.target = event.target
          snapshot.arguments = event.arguments
          snapshot.context = event.context
          snapshot.status = 'requested'
          break
        case 'tool.accepted':
          snapshot.actorId = entry.envelope.payload.actorId
          snapshot.status = 'accepted'
          break
        case 'tool.started':
          snapshot.actorId = entry.envelope.payload.actorId
          snapshot.status = 'started'
          break
        case 'tool.progress':
          snapshot.status = 'progress'
          break
        case 'tool.completed':
          snapshot.status = 'completed'
          snapshot.result = event.result
          snapshot.isError = false
          break
        case 'tool.failed':
          snapshot.status = 'failed'
          snapshot.result = { error: event.error }
          snapshot.isError = true
          break
        case 'tool.cancelled':
          snapshot.status = 'cancelled'
          break
        case 'tool.expired':
          snapshot.status = 'expired'
          break
      }
      
      snapshot.updatedAt = entry.loggedAt
    }

    return snapshot as ExecutionSnapshot
  }
}

/**
 * Generate a unique execution ID
 */
export function generateExecutionId(): ExecutionId {
  return `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
