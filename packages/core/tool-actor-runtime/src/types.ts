/**
 * Core type definitions for the Tool Actor Runtime
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { CallId } from '@deepseek-ai/dsh-llm'

/**
 * Unique identifier for a capability (tool definition)
 */
export type CapabilityId = string

/**
 * Unique identifier for an actor instance
 */
export type ActorId = string

/**
 * Unique identifier for an execution instance
 */
export type ExecutionId = string

/**
 * Execution lifecycle states
 */
export const enum ExecutionState {
  /** Execution requested, awaiting acceptance */
  Requested = 'requested',
  /** Execution accepted by actor */
  Accepted = 'accepted',
  /** Execution started */
  Started = 'started',
  /** Execution in progress with optional progress updates */
  Progress = 'progress',
  /** Execution completed successfully */
  Completed = 'completed',
  /** Execution failed with error */
  Failed = 'failed',
  /** Execution cancelled before completion */
  Cancelled = 'cancelled',
  /** Execution expired due to timeout */
  Expired = 'expired',
}

/**
 * Supported execution modes that determine transport and lifecycle strategy
 */
export type ExecutionMode =
  | 'in-memory'      // In-process execution with in-memory transport
  | 'ipc'            // Inter-process communication via stdio/sockets
  | 'tcp'            // TCP socket transport
  | 'quic'           // QUIC protocol transport
  | 'nats'           // NATS message bus
  | 'wasm'           // WebAssembly sandbox execution
  | 'process'        // External process execution

/**
 * Mode configuration - minimal declarative config
 * The mode determines transport, lifecycle, and execution strategy automatically
 */
export interface ModeConfig {
  /** Primary mode determining execution strategy */
  mode: ExecutionMode
  /** Optional mode-specific overrides (derived defaults when omitted) */
  options?: Record<string, unknown>
}

/**
 * Capability definition - the semantic contract known to agents
 */
export interface CapabilityDefinition {
  /** Unique capability identifier */
  readonly id: CapabilityId
  /** Human-readable description */
  readonly description: string
  /** Input JSON Schema */
  readonly inputSchema: JsonValue
  /** Output JSON Schema */
  readonly outputSchema: JsonValue
  /** Required permissions */
  readonly permissions?: readonly string[]
  /** Declared side effects */
  readonly effects?: readonly string[]
  /** Execution policy hints */
  readonly executionPolicy?: ExecutionPolicy
  /** Mode configuration determining how this capability executes */
  readonly mode: ModeConfig
}

/**
 * Execution policy hints for capability scheduling
 */
export interface ExecutionPolicy {
  /** Maximum concurrent executions (default: unlimited) */
  maxConcurrency?: number
  /** Timeout in milliseconds (default: none) */
  timeoutMs?: number
  /** Whether executions can be cancelled mid-flight */
  cancellable?: boolean
  /** Whether executions are idempotent */
  idempotent?: boolean
  /** Retry policy on failure */
  retry?: RetryPolicy
}

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  /** Maximum retry attempts */
  maxAttempts: number
  /** Initial delay in milliseconds */
  initialDelayMs: number
  /** Backoff multiplier */
  backoffMultiplier: number
}

/**
 * Tool request event - emitted by agent to invoke a capability
 */
export interface ToolRequest {
  readonly type: 'tool.request'
  readonly capability: CapabilityId
  readonly target?: string  // Optional target for generic capabilities like "search"
  readonly executionId: ExecutionId
  readonly arguments: JsonValue
  readonly context?: ExecutionContext
}

/**
 * Execution context passed through the execution pipeline
 */
export interface ExecutionContext {
  /** Calling agent identifier */
  readonly agentId?: string
  /** Session identifier */
  readonly sessionId?: string
  /** Correlation identifier for tracing */
  readonly correlationId?: string
  /** Additional context entries */
  readonly [key: string]: unknown
}

/**
 * Tool result event - emitted when execution completes
 */
export interface ToolResult {
  readonly type: 'tool.result'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly result: JsonValue
  readonly isError: boolean
}

/**
 * Tool execution lifecycle events
 */
export type ToolLifecycleEvent =
  | ToolRequestedEvent
  | ToolAcceptedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolCancelledEvent
  | ToolExpiredEvent

/** Execution requested */
export interface ToolRequestedEvent {
  readonly type: 'tool.requested'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly timestamp: number
  readonly arguments: JsonValue
  readonly context?: ExecutionContext
}

/** Execution accepted by actor */
export interface ToolAcceptedEvent {
  readonly type: 'tool.accepted'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly actorId: ActorId
  readonly timestamp: number
}

/** Execution started */
export interface ToolStartedEvent {
  readonly type: 'tool.started'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly actorId: ActorId
  readonly timestamp: number
}

/** Execution progress update */
export interface ToolProgressEvent {
  readonly type: 'tool.progress'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly actorId: ActorId
  readonly timestamp: number
  readonly progress: number  // 0-100
  readonly message?: string
  readonly data?: JsonValue
}

/** Execution completed successfully */
export interface ToolCompletedEvent {
  readonly type: 'tool.completed'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly actorId: ActorId
  readonly timestamp: number
  readonly result: JsonValue
}

/** Execution failed with error */
export interface ToolFailedEvent {
  readonly type: 'tool.failed'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly actorId: ActorId
  readonly timestamp: number
  readonly error: ErrorInfo
}

/** Execution cancelled */
export interface ToolCancelledEvent {
  readonly type: 'tool.cancelled'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly actorId: ActorId
  readonly timestamp: number
  readonly reason?: string
}

/** Execution expired due to timeout */
export interface ToolExpiredEvent {
  readonly type: 'tool.expired'
  readonly capability: CapabilityId
  readonly target?: string
  readonly executionId: ExecutionId
  readonly actorId: ActorId
  readonly timestamp: number
}

/**
 * Structured error information
 */
export interface ErrorInfo {
  /** Error code for programmatic handling */
  readonly code: string
  /** Human-readable message */
  readonly message: string
  /** Additional error data */
  readonly data?: JsonValue
}

/**
 * Any tool-related event (request, result, or lifecycle)
 */
export type ToolEvent =
  | ToolRequest
  | ToolResult
  | ToolLifecycleEvent

/**
 * Event envelope with metadata for transport
 */
export interface EventEnvelope<T extends ToolEvent = ToolEvent> {
  /** Event type discriminator */
  readonly type: T['type']
  /** Unique event identifier */
  readonly eventId: string
  /** Timestamp of event creation (milliseconds since epoch) */
  readonly timestamp: number
  /** The actual event payload */
  readonly payload: T
  /** Version for schema evolution */
  readonly version: number
}
