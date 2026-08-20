/**
 * Capability Registry - Manages tool capability definitions
 * 
 * The capability registry provides:
 * - Registration of capability definitions
 * - Resolution of capabilities by ID
 * - Binding of capabilities to executor implementations
 * - Zero-knowledge abstraction between agents and tool implementations
 */

import type {
  CapabilityId,
  CapabilityDefinition,
  ExecutionId,
  JsonValue,
  ExecutionContext,
} from './types.ts'
import type { ToolExecutor } from './actor.ts'

/**
 * Registered capability with its executor
 */
export interface RegisteredCapability {
  /** Capability definition (semantic contract) */
  readonly definition: CapabilityDefinition
  /** Executor function that implements the capability */
  readonly executor: ToolExecutor
  /** Whether this capability is currently enabled */
  enabled: boolean
}

/**
 * Capability registry interface
 */
export interface CapabilityRegistry {
  /** Register a capability with its implementation */
  register(definition: CapabilityDefinition, executor: ToolExecutor): void
  
  /** Unregister a capability */
  unregister(capabilityId: CapabilityId): boolean
  
  /** Get a capability by ID */
  get(capabilityId: CapabilityId): RegisteredCapability | undefined
  
  /** Check if a capability exists */
  has(capabilityId: CapabilityId): boolean
  
  /** Enable or disable a capability */
  setEnabled(capabilityId: CapabilityId, enabled: boolean): void
  
  /** List all registered capability IDs */
  listCapabilities(): CapabilityId[]
  
  /** List only enabled capabilities */
  listEnabledCapabilities(): CapabilityId[]
  
  /** Resolve capability for execution */
  resolveForExecution(
    capabilityId: CapabilityId,
    target?: string,
  ): ResolvedCapability | undefined
}

/**
 * Resolved capability ready for execution
 */
export interface ResolvedCapability {
  readonly id: CapabilityId
  readonly target?: string
  readonly definition: CapabilityDefinition
  readonly executor: ToolExecutor
}

/**
 * Default capability registry implementation
 */
export class DefaultCapabilityRegistry implements CapabilityRegistry {
  private capabilities = new Map<CapabilityId, RegisteredCapability>()

  register(definition: CapabilityDefinition, executor: ToolExecutor): void {
    if (this.capabilities.has(definition.id)) {
      throw new Error(`Capability already registered: ${definition.id}`)
    }
    
    this.capabilities.set(definition.id, {
      definition,
      executor,
      enabled: true,
    })
  }

  unregister(capabilityId: CapabilityId): boolean {
    return this.capabilities.delete(capabilityId)
  }

  get(capabilityId: CapabilityId): RegisteredCapability | undefined {
    return this.capabilities.get(capabilityId)
  }

  has(capabilityId: CapabilityId): boolean {
    return this.capabilities.has(capabilityId)
  }

  setEnabled(capabilityId: CapabilityId, enabled: boolean): void {
    const capability = this.capabilities.get(capabilityId)
    if (!capability) {
      throw new Error(`Capability not found: ${capabilityId}`)
    }
    capability.enabled = enabled
  }

  listCapabilities(): CapabilityId[] {
    return Array.from(this.capabilities.keys())
  }

  listEnabledCapabilities(): CapabilityId[] {
    return Array.from(this.capabilities.entries())
      .filter(([, cap]) => cap.enabled)
      .map(([id]) => id)
  }

  resolveForExecution(
    capabilityId: CapabilityId,
    target?: string,
  ): ResolvedCapability | undefined {
    const registered = this.capabilities.get(capabilityId)
    if (!registered || !registered.enabled) {
      return undefined
    }
    
    // Validate target if capability expects one
    // For generic capabilities like "search", target specifies what to search
    
    return {
      id: capabilityId,
      target,
      definition: registered.definition,
      executor: registered.executor,
    }
  }
}

/**
 * Builder for creating capability definitions with fluent API
 */
export class CapabilityBuilder {
  private id: CapabilityId
  private description: string = ''
  private inputSchema: JsonValue = { type: 'object', properties: {}, additionalProperties: false }
  private outputSchema: JsonValue = { type: 'object' }
  private permissions: string[] = []
  private effects: string[] = []
  private mode: CapabilityDefinition['mode'] = { mode: 'in-memory' }
  private executionPolicy: CapabilityDefinition['executionPolicy'] = {}

  constructor(id: CapabilityId) {
    this.id = id
  }

  setDescription(description: string): this {
    this.description = description
    return this
  }

  setInputSchema(schema: JsonValue): this {
    this.inputSchema = schema
    return this
  }

  setOutputSchema(schema: JsonValue): this {
    this.outputSchema = schema
    return this
  }

  addPermission(permission: string): this {
    this.permissions.push(permission)
    return this
  }

  addEffect(effect: string): this {
    this.effects.push(effect)
    return this
  }

  setMode(mode: CapabilityDefinition['mode']): this {
    this.mode = mode
    return this
  }

  setExecutionPolicy(policy: CapabilityDefinition['executionPolicy']): this {
    this.executionPolicy = policy
    return this
  }

  build(): CapabilityDefinition {
    return {
      id: this.id,
      description: this.description,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      permissions: this.permissions.length > 0 ? this.permissions : undefined,
      effects: this.effects.length > 0 ? this.effects : undefined,
      executionPolicy: Object.keys(this.executionPolicy).length > 0 
        ? this.executionPolicy 
        : undefined,
      mode: this.mode,
    }
  }
}

/**
 * Create a capability builder
 */
export function defineCapability(id: CapabilityId): CapabilityBuilder {
  return new CapabilityBuilder(id)
}
