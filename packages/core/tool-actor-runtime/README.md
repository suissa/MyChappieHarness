# Tool Actor Runtime

Universal execution model for DeepSeek Harness tools based on Actors and Events.

## Architecture Overview

This runtime transforms tool execution from direct function calls into an actor-based event-driven model:

```
Capability → Tool Definition → Actor → Event Interface → Execution
```

### Key Principles

1. **Zero Knowledge**: Agents never import tool implementations directly. They only reference capabilities and emit events.

2. **Actor as Unit of Execution**: Every tool executes as an Actor with:
   - Unique identity
   - Mailbox for receiving events
   - Execution state management
   - Automatic lifecycle (creation, activation, idle, destruction)

3. **Event-Driven**: All communication happens through typed events that are transport-agnostic.

4. **Mode-Based Configuration**: A single `mode` field determines execution strategy:
   ```yaml
   tools:
     search:
       mode: in-memory
     filesystem:
       mode: process
     remote-search:
       mode: nats
   ```

5. **Execution State as Event Log**: State is reconstructible from events, enabling audit trails and configurable retention.

## Core Components

### Types (`types.ts`)

Core type definitions including:
- `CapabilityDefinition` - Semantic contract known to agents
- `ExecutionMode` - Supported modes (in-memory, ipc, tcp, quic, nats, wasm, process)
- `ToolEvent` - Typed events for requests, results, and lifecycle
- `ExecutionState` - Lifecycle states (requested, accepted, started, progress, completed, failed, cancelled, expired)

### Events (`events.ts`)

Typed event interface and transport abstraction:
- `EventEnvelope<T>` - Metadata wrapper for events
- `InMemoryEventBus` - Default in-memory transport
- Event creation helpers and type guards

### Actor (`actor.ts`)

The fundamental execution unit:
- `Actor` class with mailbox processing
- Automatic idle detection and destruction
- Concurrency control per actor
- Cancellation support via AbortSignal

### Capability (`capability.ts`)

Capability registry and builder:
- `DefaultCapabilityRegistry` - Manages capability definitions
- `CapabilityBuilder` - Fluent API for defining capabilities
- Zero-knowledge abstraction between agents and implementations

### Execution State (`execution-state.ts`)

Event-sourced execution tracking:
- `ExecutionStateStore` - Interface for persisting execution logs
- `InMemoryExecutionStateStore` - Default implementation
- Configurable retention policies

### Mode Registry (`mode-registry.ts`)

Extensible mode provider system:
- `ModeProvider` interface for adding new execution modes
- `ModeRegistry` for managing providers
- Default options for each built-in mode

### Runtime (`runtime.ts`)

Main execution engine:
- `ToolActorRuntime` - Central runtime class
- `ActorPool` interface for managing actor instances
- `SimpleActorPool` - Default pool implementation
- Automatic scaling based on load

## Usage Example

```typescript
import { 
  createToolActorRuntime,
  defineCapability,
} from '@deepseek-ai/dsh-tool-actor-runtime'

// Create runtime
const runtime = createToolActorRuntime({
  retentionPolicy: {
    executionStateMs: 24 * 60 * 60 * 1000,  // 24h
    resultsMs: 10 * 60 * 1000,               // 10m
    auditEventsMs: 90 * 24 * 60 * 60 * 1000, // 90d
  },
})

// Define a capability
const searchCapability = defineCapability('search')
  .setDescription('Search for items by criteria')
  .setInputSchema({
    type: 'object',
    properties: {
      target: { type: 'string' },
      query: { type: 'string' },
    },
    required: ['target', 'query'],
  })
  .setOutputSchema({
    type: 'array',
    items: { type: 'object' },
  })
  .setMode({ mode: 'in-memory' })
  .build()

// Register capability with implementation
runtime.registerCapability(searchCapability, async (args, context, signal) => {
  // Implementation can be in any language
  // This is just the executor binding
  const { target, query } = args as { target: string; query: string }
  
  // Perform search...
  const results = await performSearch(target, query, signal)
  
  return results
})

// Execute through the runtime
const result = await runtime.execute(
  'search',
  { target: 'product', query: 'notebook' },
  'product',  // Optional target for generic capabilities
  { sessionId: 'session-123' }
)

console.log(result)
```

## Event Flow

```
Agent
  ↓ (emit)
ToolRequest { type: 'tool.request', capability: 'search', ... }
  ↓
Event Bus
  ↓
Actor Runtime
  ↓ (create actor if needed)
Actor
  ↓ (process mailbox)
Executor Function
  ↓
ToolResult { type: 'tool.result', result: {...}, isError: false }
  ↓
Event Bus
  ↓
Agent receives result
```

## Lifecycle Events

The runtime emits lifecycle events for observability:

- `tool.requested` - Execution requested
- `tool.accepted` - Accepted by an actor
- `tool.started` - Execution started
- `tool.progress` - Progress update (optional)
- `tool.completed` - Successful completion
- `tool.failed` - Failed with error
- `tool.cancelled` - Cancelled before completion
- `tool.expired` - Timed out

## Retention Policy

Configure how long to keep execution data:

```typescript
{
  executionStateMs: 24 * 60 * 60 * 1000,      // Full state: 24 hours
  resultsMs: 10 * 60 * 1000,                   // Results: 10 minutes
  auditEventsMs: 90 * 24 * 60 * 60 * 1000,    // Audit log: 90 days
}
```

## Adding New Modes

To add a new execution mode:

```typescript
import { ModeProvider, globalModeRegistry } from '@deepseek-ai/dsh-tool-actor-runtime'

class CustomModeProvider implements ModeProvider {
  readonly mode = 'custom' as const
  
  createTransport(config?: Record<string, unknown>) {
    // Create custom transport
  }
  
  createActorPool(config?: Record<string, unknown>) {
    // Create custom actor pool
  }
}

globalModeRegistry.register(new CustomModeProvider())
```

Then use in capability definition:

```typescript
.setMode({ mode: 'custom' })
```

## Integration with Existing Tools

The runtime is designed to integrate with the existing `ctx.tools` seam in DeepSeek Harness. See the adapter layer for bridging legacy tool definitions to the actor model.

## License

MIT
