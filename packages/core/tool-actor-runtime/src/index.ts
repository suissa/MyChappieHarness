/**
 * Tool Actor Runtime - Universal execution model based on Actors and Events
 * 
 * This runtime transforms tool execution from direct function calls into an
 * actor-based event-driven model where:
 * 
 * - Agents only reference capabilities and emit events
 * - Tools execute as actors with identity, mailbox, and lifecycle
 * - Events are typed and transport-agnostic
 * - Execution state is reconstructible from event logs
 * - Mode determines execution strategy automatically
 * 
 * @module @deepseek-ai/dsh-tool-actor-runtime
 */

export * from './types.ts'
export * from './events.ts'
export * from './actor.ts'
export * from './runtime.ts'
export * from './mode-registry.ts'
export * from './capability.ts'
export * from './execution-state.ts'
