/**
 * Actor - The fundamental unit of tool execution
 * 
 * An actor represents a single tool execution instance with:
 * - Unique identity
 * - Mailbox for receiving events
 * - Execution state management
 * - Lifecycle control (creation, activation, idle, destruction)
 */

import type {
  ActorId,
  CapabilityId,
  ExecutionId,
  ExecutionState,
  ToolEvent,
  ToolRequest,
  ToolResult,
  ExecutionContext,
  JsonValue,
} from './types.ts'
import { createEnvelope, createLifecycleEvent, createToolResult } from './events.ts'
import type { EventEnvelope, EventHandler } from './events.ts'

/**
 * Actor mailbox message
 */
interface MailboxMessage {
  event: EventEnvelope<ToolEvent>
  resolve: (result: ToolResult) => void
  reject: (error: Error) => void
}

/**
 * Actor configuration
 */
export interface ActorConfig {
  /** Capability this actor executes */
  capability: CapabilityId
  /** Optional target for generic capabilities */
  target?: string
  /** Execution handler function */
  executor: ToolExecutor
  /** Idle timeout in milliseconds before actor can be destroyed */
  idleTimeoutMs?: number
  /** Maximum concurrent executions this actor can handle */
  maxConcurrency?: number
}

/**
 * Tool executor function signature
 * Receives arguments and context, returns result
 */
export type ToolExecutor = (
  args: JsonValue,
  context: ExecutionContext,
  signal: AbortSignal,
) => Promise<JsonValue>

/**
 * Actor state
 */
interface ActorState {
  status: 'idle' | 'active' | 'destroyed'
  currentExecutions: Set<ExecutionId>
  lastActivityTime: number
  totalExecutions: number
}

/**
 * Actor class - manages tool execution lifecycle
 * 
 * Actors are created on demand and can be destroyed when idle.
 * Each actor processes one request at a time by default, but can
 * be configured for limited concurrency.
 */
export class Actor {
  readonly id: ActorId
  readonly capability: CapabilityId
  readonly target?: string
  
  private state: ActorState
  private mailbox: MailboxMessage[]
  private processing: boolean
  private executor: ToolExecutor
  private idleTimeoutMs: number
  private maxConcurrency: number
  private abortControllers: Map<ExecutionId, AbortController>
  private onIdle?: () => void

  constructor(
    id: ActorId,
    config: ActorConfig,
    onIdle?: () => void,
  ) {
    this.id = id
    this.capability = config.capability
    this.target = config.target
    this.executor = config.executor
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30000 // 30 seconds default
    this.maxConcurrency = config.maxConcurrency ?? 1
    this.onIdle = onIdle
    
    this.state = {
      status: 'idle',
      currentExecutions: new Set(),
      lastActivityTime: Date.now(),
      totalExecutions: 0,
    }
    
    this.mailbox = []
    this.processing = false
    this.abortControllers = new Map()
  }

  /**
   * Check if actor is available for new work
   */
  isAvailable(): boolean {
    return this.state.status === 'idle' || 
           (this.state.status === 'active' && 
            this.state.currentExecutions.size < this.maxConcurrency)
  }

  /**
   * Check if actor is idle and eligible for destruction
   */
  isIdleAndEligibleForDestruction(): boolean {
    if (this.state.status !== 'idle') return false
    const idleTime = Date.now() - this.state.lastActivityTime
    return idleTime >= this.idleTimeoutMs
  }

  /**
   * Get current execution count
   */
  get currentExecutionCount(): number {
    return this.state.currentExecutions.size
  }

  /**
   * Get total executions processed
   */
  get totalExecutionsProcessed(): number {
    return this.state.totalExecutions
  }

  /**
   * Send a request to the actor's mailbox
   */
  send(event: EventEnvelope<ToolRequest>): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
      this.mailbox.push({ event, resolve, reject })
      this.state.lastActivityTime = Date.now()
      this.processMailbox()
    })
  }

  /**
   * Process messages in the mailbox
   */
  private async processMailbox(): Promise<void> {
    if (this.processing || this.state.status === 'destroyed') return
    if (this.mailbox.length === 0) {
      this.checkIdle()
      return
    }
    if (this.state.currentExecutions.size >= this.maxConcurrency) return

    this.processing = true
    this.state.status = 'active'

    while (
      this.mailbox.length > 0 &&
      this.state.currentExecutions.size < this.maxConcurrency &&
      this.state.status !== 'destroyed'
    ) {
      const message = this.mailbox.shift()!
      this.executeMessage(message).catch(error => {
        message.reject(error)
      })
    }

    this.processing = false
    this.checkIdle()
  }

  /**
   * Execute a single mailbox message
   */
  private async executeMessage(message: MailboxMessage): Promise<void> {
    const request = message.event.payload
    const executionId = request.executionId
    
    // Create abort controller for cancellation
    const abortController = new AbortController()
    this.abortControllers.set(executionId, abortController)
    this.state.currentExecutions.add(executionId)

    try {
      // Emit started event
      const startedEvent = createEnvelope(
        createLifecycleEvent(
          'tool.started',
          this.capability,
          executionId,
          this.id,
          this.target,
        ),
      )
      // Note: event publishing handled by runtime

      // Execute the tool
      const result = await this.executor(
        request.arguments,
        request.context ?? {},
        abortController.signal,
      )

      // Create success result
      const toolResult = createToolResult(
        this.capability,
        executionId,
        result,
        false,
        this.target,
      )

      message.resolve(toolResult)
    } catch (error) {
      // Create error result
      const errorInfo = error instanceof Error
        ? { code: 'EXECUTION_ERROR', message: error.message }
        : { code: 'UNKNOWN_ERROR', message: String(error) }

      const toolResult = createToolResult(
        this.capability,
        executionId,
        { error: errorInfo },
        true,
        this.target,
      )

      message.reject(error as Error)
    } finally {
      // Cleanup
      this.abortControllers.delete(executionId)
      this.state.currentExecutions.delete(executionId)
      this.state.lastActivityTime = Date.now()
      
      if (this.state.currentExecutions.size === 0) {
        this.state.status = 'idle'
      }
    }
  }

  /**
   * Check if actor should transition to idle state
   */
  private checkIdle(): void {
    if (this.state.currentExecutions.size === 0 && this.state.status === 'active') {
      this.state.status = 'idle'
      this.onIdle?.()
    }
  }

  /**
   * Cancel an in-flight execution
   */
  cancel(executionId: ExecutionId, reason?: string): void {
    const controller = this.abortControllers.get(executionId)
    if (controller) {
      controller.abort(reason)
    }
  }

  /**
   * Destroy the actor, releasing all resources
   * Pending executions will be cancelled
   */
  destroy(): void {
    this.state.status = 'destroyed'
    
    // Cancel all pending messages
    for (const message of this.mailbox) {
      message.reject(new Error('Actor destroyed'))
    }
    this.mailbox = []

    // Cancel all in-flight executions
    for (const [executionId, controller] of this.abortControllers) {
      controller.abort('Actor destroyed')
    }
    this.abortControllers.clear()
    this.state.currentExecutions.clear()
  }
}

/**
 * Factory function to create actors with unique IDs
 */
let actorCounter = 0

export function createActor(
  config: ActorConfig,
  onIdle?: () => void,
): Actor {
  const id = `actor-${Date.now().toString(36)}-${(++actorCounter).toString(36)}`
  return new Actor(id, config, onIdle)
}
