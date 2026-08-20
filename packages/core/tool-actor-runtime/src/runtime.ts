/**
 * Actor Runtime - Core execution engine
 * 
 * The runtime manages:
 * - Actor creation and lifecycle
 * - Event dispatch between agents and actors
 * - Automatic scaling based on load
 * - Transport abstraction
 */

import type {
  CapabilityId,
  ExecutionId,
  ToolRequest,
  ToolResult,
  CapabilityDefinition,
} from './types.ts'
import type { EventEnvelope, EventSubscriber, EventHandler } from './events.ts'
import { createEnvelope, createToolResult, isToolRequest } from './events.ts'
import type { Actor, ToolExecutor } from './actor.ts'
import { createActor } from './actor.ts'
import type { CapabilityRegistry, ResolvedCapability } from './capability.ts'
import { DefaultCapabilityRegistry } from './capability.ts'
import type { ExecutionStateStore, RetentionPolicy } from './execution-state.ts'
import { InMemoryExecutionStateStore, DEFAULT_RETENTION_POLICY, generateExecutionId } from './execution-state.ts'

/**
 * Actor pool interface for managing actor instances
 */
export interface ActorPool {
  /** Get or create an actor for a capability */
  getActor(capability: CapabilityId, target?: string): Promise<Actor>
  
  /** Return an actor to the pool after use */
  returnActor(actor: Actor): void
  
  /** Remove idle actors from the pool */
  cleanupIdleActors(): number
  
  /** Get current pool size */
  readonly size: number
  
  /** Dispose the pool */
  dispose(): void | Promise<void>
}

/**
 * Simple in-memory actor pool implementation
 */
export class SimpleActorPool implements ActorPool {
  private actors = new Map<string, Actor[]>()
  private maxIdleActors: number
  private idleCheckIntervalMs: number
  private idleCheckTimer?: NodeJS.Timeout

  constructor(config?: Record<string, unknown>) {
    this.maxIdleActors = (config?.maxIdleActors as number) ?? 10
    this.idleCheckIntervalMs = (config?.idleCheckIntervalMs as number) ?? 5000
    
    // Start periodic cleanup
    this.startIdleCheck()
  }

  private startIdleCheck(): void {
    this.idleCheckTimer = setInterval(() => {
      this.cleanupIdleActors()
    }, this.idleCheckIntervalMs)
  }

  async getActor(capability: CapabilityId, target?: string): Promise<Actor> {
    const key = this.getActorKey(capability, target)
    let available = this.actors.get(key)
    
    if (!available || available.length === 0) {
      // No available actors, create a new one
      // Note: In a real implementation, we'd need the executor from the capability registry
      throw new Error(`No actor available for capability: ${capability}`)
    }
    
    return available.pop()!
  }

  returnActor(actor: Actor): void {
    if (actor.isIdleAndEligibleForDestruction()) {
      actor.destroy()
      return
    }
    
    const key = this.getActorKey(actor.capability, actor.target)
    let available = this.actors.get(key)
    
    if (!available) {
      available = []
      this.actors.set(key, available)
    }
    
    if (available.length < this.maxIdleActors) {
      available.push(actor)
    } else {
      actor.destroy()
    }
  }

  cleanupIdleActors(): number {
    let destroyed = 0
    
    for (const [key, available] of this.actors.entries()) {
      const stillActive: Actor[] = []
      
      for (const actor of available) {
        if (actor.isIdleAndEligibleForDestruction()) {
          actor.destroy()
          destroyed++
        } else {
          stillActive.push(actor)
        }
      }
      
      if (stillActive.length === 0) {
        this.actors.delete(key)
      } else {
        this.actors.set(key, stillActive)
      }
    }
    
    return destroyed
  }

  get size(): number {
    let total = 0
    for (const actors of this.actors.values()) {
      total += actors.length
    }
    return total
  }

  dispose(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer)
      this.idleCheckTimer = undefined
    }
    
    for (const actors of this.actors.values()) {
      for (const actor of actors) {
        actor.destroy()
      }
    }
    this.actors.clear()
  }

  private getActorKey(capability: CapabilityId, target?: string): string {
    return target ? `${capability}:${target}` : capability
  }
}

/**
 * Runtime configuration
 */
export interface RuntimeConfig {
  /** Retention policy for execution state */
  retentionPolicy?: RetentionPolicy
  /** Maximum concurrent executions per capability */
  maxConcurrencyPerCapability?: number
  /** Enable automatic actor scaling */
  autoScale?: boolean
}

/**
 * Tool Actor Runtime
 * 
 * Main entry point for executing tools through the actor model.
 * Agents interact with the runtime by emitting tool request events,
 * and the runtime handles actor management, event routing, and execution.
 */
export class ToolActorRuntime {
  private capabilityRegistry: CapabilityRegistry
  private executionStateStore: ExecutionStateStore
  private eventBus: EventSubscriber
  private config: Required<RuntimeConfig>
  private pendingRequests = new Map<ExecutionId, {
    resolve: (result: ToolResult) => void
    reject: (error: Error) => void
    timeoutHandle?: NodeJS.Timeout
  }>()

  constructor(
    config: RuntimeConfig = {},
    capabilityRegistry?: CapabilityRegistry,
    eventBus?: EventSubscriber,
    executionStateStore?: ExecutionStateStore,
  ) {
    this.capabilityRegistry = capabilityRegistry ?? new DefaultCapabilityRegistry()
    this.executionStateStore = executionStateStore ?? new InMemoryExecutionStateStore()
    this.eventBus = eventBus ?? new (require('./events.ts').InMemoryEventBus)()
    
    this.config = {
      retentionPolicy: config.retentionPolicy ?? DEFAULT_RETENTION_POLICY,
      maxConcurrencyPerCapability: config.maxConcurrencyPerCapability ?? 100,
      autoScale: config.autoScale ?? true,
    }
    
    // Subscribe to tool requests
    this.eventBus.subscribe('tool.request', this.handleToolRequest.bind(this))
  }

  /**
   * Register a capability with its implementation
   */
  registerCapability(definition: CapabilityDefinition, executor: ToolExecutor): void {
    this.capabilityRegistry.register(definition, executor)
  }

  /**
   * Execute a tool by capability ID
   * This is the main entry point for agents to invoke tools
   */
  async execute(
    capabilityId: CapabilityId,
    args: unknown,
    target?: string,
    context?: ToolRequest['context'],
  ): Promise<ToolResult> {
    const resolved = this.capabilityRegistry.resolveForExecution(capabilityId, target)
    
    if (!resolved) {
      throw new Error(`Capability not found or disabled: ${capabilityId}`)
    }

    const executionId = generateExecutionId()
    
    // Create request event
    const request: ToolRequest = {
      type: 'tool.request',
      capability: capabilityId,
      target,
      executionId,
      arguments: args as any,
      context,
    }
    
    const envelope = createEnvelope(request)
    
    // Log the request
    await this.executionStateStore.append(executionId, envelope)
    
    // Execute through actor
    return this.executeWithActor(resolved, executionId, args, context)
  }

  private async executeWithActor(
    resolved: ResolvedCapability,
    executionId: ExecutionId,
    args: unknown,
    context?: ExecutionContext,
  ): Promise<ToolResult> {
    const abortController = new AbortController()
    
    return new Promise<ToolResult>((resolve, reject) => {
      // Set up timeout if specified in execution policy
      const timeoutMs = resolved.definition.executionPolicy?.timeoutMs
      let timeoutHandle: NodeJS.Timeout | undefined
      
      if (timeoutMs) {
        timeoutHandle = setTimeout(() => {
          abortController.abort('Execution timeout')
          const result = createToolResult(
            resolved.id,
            executionId,
            { error: { code: 'TIMEOUT', message: `Execution exceeded ${timeoutMs}ms timeout` } },
            true,
            resolved.target,
          )
          resolve(result)
        }, timeoutMs)
      }
      
      this.pendingRequests.set(executionId, { resolve, reject, timeoutHandle })
      
      // Create actor and execute
      const actor = createActor({
        capability: resolved.id,
        target: resolved.target,
        executor: resolved.executor,
        idleTimeoutMs: 30000,
        maxConcurrency: resolved.definition.executionPolicy?.maxConcurrency ?? 1,
      }, () => {
        // onIdle callback - actor can be returned to pool or destroyed
      })
      
      // Create request envelope for actor
      const requestEvent = createEnvelope({
        type: 'tool.request',
        capability: resolved.id,
        target: resolved.target,
        executionId,
        arguments: args as any,
        context,
      })
      
      // Send to actor mailbox
      actor.send(requestEvent as EventEnvelope<ToolRequest>)
        .then(result => {
          clearTimeout(timeoutHandle)
          this.pendingRequests.delete(executionId)
          resolve(result)
        })
        .catch(error => {
          clearTimeout(timeoutHandle)
          this.pendingRequests.delete(executionId)
          reject(error)
        })
    })
  }

  private async handleToolRequest(envelope: EventEnvelope<ToolRequest>): Promise<void> {
    const request = envelope.payload
    
    // Log the requested event
    const requestedEvent = createEnvelope({
      type: 'tool.requested',
      capability: request.capability,
      target: request.target,
      executionId: request.executionId,
      timestamp: Date.now(),
      arguments: request.arguments,
      context: request.context,
    })
    
    await this.executionStateStore.append(request.executionId, requestedEvent)
    
    // Resolve capability
    const resolved = this.capabilityRegistry.resolveForExecution(request.capability, request.target)
    
    if (!resolved) {
      // Capability not found - emit failed event
      const failedEvent = createEnvelope({
        type: 'tool.failed',
        capability: request.capability,
        target: request.target,
        executionId: request.executionId,
        actorId: 'unknown',
        timestamp: Date.now(),
        error: { code: 'CAPABILITY_NOT_FOUND', message: `Capability ${request.capability} not found` },
      })
      await this.executionStateStore.append(request.executionId, failedEvent)
      
      const pending = this.pendingRequests.get(request.executionId)
      if (pending) {
        pending.reject(new Error(`Capability not found: ${request.capability}`))
      }
      return
    }
    
    // Continue with execution...
    // (This would continue with actor creation and execution)
  }

  /**
   * Get execution state snapshot
   */
  async getExecutionState(executionId: ExecutionId): Promise<any> {
    return this.executionStateStore.getSnapshot(executionId)
  }

  /**
   * Get execution event log
   */
  async getExecutionLog(executionId: ExecutionId): Promise<any[]> {
    return this.executionStateStore.getEvents(executionId)
  }

  /**
   * Apply retention policy to clean up old execution state
   */
  async applyRetentionPolicy(): Promise<number> {
    return this.executionStateStore.applyRetentionPolicy(this.config.retentionPolicy)
  }

  /**
   * Dispose the runtime and release resources
   */
  async dispose(): Promise<void> {
    this.eventBus.close()
    // Clean up any pending requests
    for (const [executionId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeoutHandle)
      pending.reject(new Error('Runtime disposed'))
    }
    this.pendingRequests.clear()
  }
}

/**
 * Create a new tool actor runtime instance
 */
export function createToolActorRuntime(config?: RuntimeConfig): ToolActorRuntime {
  return new ToolActorRuntime(config)
}
