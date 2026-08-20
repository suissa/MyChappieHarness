/**
 * Mode Registry - Manages execution mode providers
 * 
 * The mode registry allows registering and resolving mode providers
 * that determine how capabilities are executed based on their mode configuration.
 * 
 * Modes are extensible - new modes can be added without modifying the core runtime.
 */

import type { ExecutionMode, ModeConfig, CapabilityDefinition } from './types.ts'
import type { EventSubscriber } from './events.ts'
import type { ActorPool } from './runtime.ts'

/**
 * Mode provider interface
 * Each mode provides its own transport, actor pool management, and execution strategy
 */
export interface ModeProvider {
  /** Mode identifier */
  readonly mode: ExecutionMode
  
  /** Create transport for this mode */
  createTransport(config?: Record<string, unknown>): EventSubscriber
  
  /** Create actor pool for this mode */
  createActorPool(config?: Record<string, unknown>): ActorPool
  
  /** Validate mode-specific configuration */
  validateConfig?(config?: Record<string, unknown>): void
  
  /** Cleanup resources when mode provider is unregistered */
  dispose?(): void | Promise<void>
}

/**
 * Default options for each built-in mode
 */
const DEFAULT_MODE_OPTIONS: Record<ExecutionMode, Record<string, unknown>> = {
  'in-memory': {
    // In-memory mode uses shared memory, no additional config needed
  },
  'ipc': {
    // IPC mode defaults to stdio
    channel: 'stdio',
  },
  'tcp': {
    // TCP mode defaults
    host: '127.0.0.1',
    port: 0, // 0 means auto-assign
  },
  'quic': {
    // QUIC mode defaults
    host: '127.0.0.1',
    port: 0,
  },
  'nats': {
    // NATS mode defaults
    servers: ['nats://localhost:4222'],
    queueGroup: 'tool-actors',
  },
  'wasm': {
    // WASM mode defaults
    sandboxTimeoutMs: 5000,
  },
  'process': {
    // Process mode defaults
    spawnOptions: {},
  },
}

/**
 * Built-in in-memory mode provider
 */
export class InMemoryModeProvider implements ModeProvider {
  readonly mode: ExecutionMode = 'in-memory'

  createTransport(): EventSubscriber {
    // Dynamic import to avoid circular dependency
    return new (require('./events.ts').InMemoryEventBus)()
  }

  createActorPool(config?: Record<string, unknown>): ActorPool {
    const { SimpleActorPool } = require('./runtime.ts')
    return new SimpleActorPool(config)
  }

  validateConfig(): void {
    // No validation needed for in-memory mode
  }
}

/**
 * Mode registry - manages mode providers
 */
export class ModeRegistry {
  private providers = new Map<ExecutionMode, ModeProvider>()
  private defaultProviders = new Map<ExecutionMode, () => ModeProvider>()

  constructor() {
    // Register default providers lazily
    this.defaultProviders.set('in-memory', () => new InMemoryModeProvider())
  }

  /**
   * Register a mode provider
   */
  register(provider: ModeProvider): void {
    this.providers.set(provider.mode, provider)
  }

  /**
   * Unregister a mode provider
   */
  unregister(mode: ExecutionMode): boolean {
    return this.providers.delete(mode)
  }

  /**
   * Get a mode provider, creating default if needed
   */
  getProvider(mode: ExecutionMode): ModeProvider | undefined {
    let provider = this.providers.get(mode)
    
    if (!provider) {
      const factory = this.defaultProviders.get(mode)
      if (factory) {
        provider = factory()
        this.providers.set(mode, provider)
      }
    }
    
    return provider
  }

  /**
   * Check if a mode is available
   */
  hasMode(mode: ExecutionMode): boolean {
    return this.providers.has(mode) || this.defaultProviders.has(mode)
  }

  /**
   * Get all registered modes
   */
  getRegisteredModes(): ExecutionMode[] {
    const modes = new Set<ExecutionMode>()
    for (const mode of this.providers.keys()) {
      modes.add(mode)
    }
    for (const mode of this.defaultProviders.keys()) {
      modes.add(mode)
    }
    return Array.from(modes)
  }

  /**
   * Resolve mode configuration with defaults
   */
  resolveModeConfig(config: ModeConfig): Required<ModeConfig> {
    const provider = this.getProvider(config.mode)
    if (!provider) {
      throw new Error(`Unknown execution mode: ${config.mode}`)
    }

    const defaults = DEFAULT_MODE_OPTIONS[config.mode]
    return {
      mode: config.mode,
      options: { ...defaults, ...config.options },
    }
  }

  /**
   * Create transport for a capability based on its mode
   */
  createTransportForCapability(capability: CapabilityDefinition): EventSubscriber {
    const resolvedConfig = this.resolveModeConfig(capability.mode)
    const provider = this.getProvider(resolvedConfig.mode)!
    
    if (provider.validateConfig) {
      provider.validateConfig(resolvedConfig.options)
    }
    
    return provider.createTransport(resolvedConfig.options)
  }

  /**
   * Create actor pool for a capability based on its mode
   */
  createActorPoolForCapability(capability: CapabilityDefinition): ActorPool {
    const resolvedConfig = this.resolveModeConfig(capability.mode)
    const provider = this.getProvider(resolvedConfig.mode)!
    
    return provider.createActorPool(resolvedConfig.options)
  }

  /**
   * Dispose all providers
   */
  async dispose(): Promise<void> {
    const disposals: Array<Promise<void> | void> = []
    
    for (const provider of this.providers.values()) {
      if (provider.dispose) {
        disposals.push(Promise.resolve(provider.dispose()))
      }
    }
    
    await Promise.all(disposals)
    this.providers.clear()
  }
}

/**
 * Global mode registry instance
 */
export const globalModeRegistry = new ModeRegistry()
