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
 */

const std = @import("std");
const Allocator = std.mem.Allocator;

// Core type definitions
pub const CapabilityId = []const u8;
pub const ActorId = []const u8;
pub const ExecutionId = []const u8;

/// Execution lifecycle states
pub const ExecutionState = enum {
    requested,
    accepted,
    started,
    progress,
    completed,
    failed,
    cancelled,
    expired,
};

/// Supported execution modes
pub const ExecutionMode = enum {
    @"in-memory",
    ipc,
    tcp,
    quic,
    nats,
    wasm,
    process,
};

/// Mode configuration
pub const ModeConfig = struct {
    mode: ExecutionMode,
    options: ?std.json.Value = null,
};

/// JSON value wrapper for arguments and results
pub const JsonValue = std.json.Value;

/// Execution context passed through the pipeline
pub const ExecutionContext = struct {
    agent_id: ?[]const u8 = null,
    session_id: ?[]const u8 = null,
    correlation_id: ?[]const u8 = null,
};

/// Error information
pub const ErrorInfo = struct {
    code: []const u8,
    message: []const u8,
    data: ?JsonValue = null,
};

/// Tool request event
pub const ToolRequest = struct {
    type: []const u8,
    capability: CapabilityId,
    target: ?[]const u8,
    execution_id: ExecutionId,
    arguments: JsonValue,
    context: ?ExecutionContext,
};

/// Tool result event
pub const ToolResult = struct {
    type: []const u8,
    capability: CapabilityId,
    target: ?[]const u8,
    execution_id: ExecutionId,
    result: JsonValue,
    is_error: bool,
};

/// Lifecycle event types
pub const LifecycleEventType = enum {
    @"tool.requested",
    @"tool.accepted",
    @"tool.started",
    @"tool.progress",
    @"tool.completed",
    @"tool.failed",
    @"tool.cancelled",
    @"tool.expired",
};

/// Generic lifecycle event
pub const LifecycleEvent = struct {
    type: []const u8,
    capability: CapabilityId,
    target: ?[]const u8,
    execution_id: ExecutionId,
    actor_id: ActorId,
    timestamp: u64,
    // Optional fields depending on event type
    arguments: ?JsonValue = null,
    context: ?ExecutionContext = null,
    progress: ?u8 = null,
    message: ?[]const u8 = null,
    result: ?JsonValue = null,
    error: ?ErrorInfo = null,
    reason: ?[]const u8 = null,
};

/// Any tool event
pub const ToolEvent = union(enum) {
    request: ToolRequest,
    result: ToolResult,
    lifecycle: LifecycleEvent,
};

/// Event envelope with metadata
pub const EventEnvelope = struct {
    event_type: []const u8,
    event_id: []const u8,
    timestamp: u64,
    payload: ToolEvent,
    version: u32 = 1,
};

/// Capability definition - semantic contract known to agents
pub const CapabilityDefinition = struct {
    id: CapabilityId,
    description: []const u8,
    input_schema: JsonValue,
    output_schema: JsonValue,
    permissions: ?[][]const u8 = null,
    effects: ?[][]const u8 = null,
    execution_policy: ?ExecutionPolicy = null,
    mode: ModeConfig,
};

/// Execution policy hints
pub const ExecutionPolicy = struct {
    max_concurrency: ?u32 = null,
    timeout_ms: ?u64 = null,
    cancellable: ?bool = null,
    idempotent: ?bool = null,
};

/// Executor function signature
pub const ToolExecutorFn = *const fn (
    allocator: Allocator,
    args: JsonValue,
    context: ExecutionContext,
    cancel_signal: *volatile bool,
) anyerror!JsonValue;

/// Registered capability with its executor
pub const RegisteredCapability = struct {
    definition: CapabilityDefinition,
    executor: ToolExecutorFn,
    enabled: bool = true,
};

/// Resolved capability ready for execution
pub const ResolvedCapability = struct {
    id: CapabilityId,
    target: ?[]const u8,
    definition: CapabilityDefinition,
    executor: ToolExecutorFn,
};
