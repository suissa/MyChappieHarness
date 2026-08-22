/**
 * Typed event interface and transport abstraction
 * 
 * Events are the fundamental unit of communication in the actor runtime.
 * This module provides:
 * - Event typing and validation
 * - Transport-agnostic event envelope
 * - Event serialization/deserialization
 */

import type { JsonValue } from '@deepseek-ai/dsh-session'
import type {
  ToolEvent,
  ToolRequest,
  ToolResult,
  ToolLifecycleEvent,
  EventEnvelope,
  ExecutionId,
  CapabilityId,
} from './types.ts'

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Create an event envelope with metadata
 */
export function createEnvelope<T extends ToolEvent>(payload: T): EventEnvelope<T> {
  return {
    type: payload.type,
    eventId: generateEventId(),
    timestamp: Date.now(),
    payload,
    version: 1,
  }
}

/**
 * Validate that an event has the required structure
 */
export function isValidToolEvent(event: unknown): event is ToolEvent {
  if (!event || typeof event !== 'object') return false
  const obj = event as Record<string, unknown>
  return typeof obj.type === 'string' && obj.type.startsWith('tool.')
}

/**
 * Serialize an event envelope to JSON string
 */
export function serializeEvent<T extends ToolEvent>(envelope: EventEnvelope<T>): string {
  return JSON.stringify(envelope)
}

/**
 * Deserialize an event envelope from JSON string
 */
export function deserializeEvent<T extends ToolEvent = ToolEvent>(json: string): EventEnvelope<T> {
  const parsed = JSON.parse(json) as EventEnvelope<T>
  if (!isValidToolEvent(parsed.payload)) {
    throw new Error(`Invalid tool event payload: expected type starting with "tool."`)
  }
  return parsed
}

/**
 * Create a tool request event
 */
export function createToolRequest(
  capability: CapabilityId,
  executionId: ExecutionId,
  arguments_: JsonValue,
  target?: string,
  context?: ToolRequest['context'],
): ToolRequest {
  return {
    type: 'tool.request',
    capability,
    target,
    executionId,
    arguments: arguments_,
    context,
  }
}

/**
 * Create a tool result event
 */
export function createToolResult(
  capability: CapabilityId,
  executionId: ExecutionId,
  result: JsonValue,
  isError: boolean,
  target?: string,
): ToolResult {
  return {
    type: 'tool.result',
    capability,
    target,
    executionId,
    result,
    isError,
  }
}

/**
 * Create a lifecycle event
 */
export function createLifecycleEvent<K extends ToolLifecycleEvent['type']>(
  type: K,
  capability: CapabilityId,
  executionId: ExecutionId,
  actorId: string,
  target?: string,
  additional?: Omit<Extract<ToolLifecycleEvent, { type: K }>, 'type' | 'capability' | 'executionId' | 'actorId' | 'timestamp'>,
): Extract<ToolLifecycleEvent, { type: K }> {
  const base = {
    type,
    capability,
    target,
    executionId,
    actorId,
    timestamp: Date.now(),
  }
  return { ...base, ...additional } as Extract<ToolLifecycleEvent, { type: K }>
}

/**
 * Event handler interface for processing events
 */
export interface EventHandler<T extends ToolEvent = ToolEvent> {
  (event: EventEnvelope<T>): void | Promise<void>
}

/**
 * Event subscriber interface for transport implementations
 */
export interface EventSubscriber {
  /** Subscribe to events of a specific type */
  subscribe<T extends ToolEvent>(type: T['type'], handler: EventHandler<T>): () => void
  /** Publish an event to all subscribers */
  publish<T extends ToolEvent>(event: EventEnvelope<T>): void | Promise<void>
  /** Close the subscription channel */
  close(): void | Promise<void>
}

/**
 * In-memory event bus implementation
 * Used for 'in-memory' mode execution
 */
export class InMemoryEventBus implements EventSubscriber {
  private handlers = new Map<string, Set<EventHandler>>()

  subscribe<T extends ToolEvent>(type: T['type'], handler: EventHandler<T>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler as EventHandler)
    
    return () => {
      set?.delete(handler as EventHandler)
    }
  }

  publish<T extends ToolEvent>(event: EventEnvelope<T>): void {
    const set = this.handlers.get(event.type)
    if (!set) return
    
    for (const handler of set) {
      try {
        handler(event)
      } catch (error) {
        // Log error but don't propagate to other handlers
        console.error(`Event handler error for ${event.type}:`, error)
      }
    }
  }

  close(): void {
    this.handlers.clear()
  }
}

/**
 * Type guard for tool request events
 */
export function isToolRequest(event: ToolEvent): event is ToolRequest {
  return event.type === 'tool.request'
}

/**
 * Type guard for tool result events
 */
export function isToolResult(event: ToolEvent): event is ToolResult {
  return event.type === 'tool.result'
}

/**
 * Type guard for lifecycle events
 */
export function isLifecycleEvent(event: ToolEvent): event is ToolLifecycleEvent {
  return event.type.startsWith('tool.') && event.type !== 'tool.request' && event.type !== 'tool.result'
}
