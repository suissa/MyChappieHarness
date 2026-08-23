/**
 * Actor - The fundamental unit of tool execution in Zig
 * 
 * An actor represents a single tool execution instance with:
 * - Unique identity
 * - Mailbox for receiving events
 * - Execution state management
 * - Lifecycle control (creation, activation, idle, destruction)
 */

const std = @import("std");
const Allocator = std.mem.Allocator;
const types = @import("types.zig");

const CapabilityId = types.CapabilityId;
const ActorId = types.ActorId;
const ExecutionId = types.ExecutionId;
const JsonValue = types.JsonValue;
const ExecutionContext = types.ExecutionContext;
const ToolRequest = types.ToolRequest;
const ToolResult = types.ToolResult;
const ToolExecutorFn = types.ToolExecutorFn;
const EventEnvelope = types.EventEnvelope;
const ToolEvent = types.ToolEvent;

/// Actor mailbox message
const MailboxMessage = struct {
    request: ToolRequest,
    completion: *Completion,
};

const Completion = struct {
    result: ?ToolResult = null,
    error: ?anyerror = null,
    completed: bool = false,
};

/// Actor state
const ActorStatus = enum {
    idle,
    active,
    destroyed,
};

const ActorState = struct {
    status: ActorStatus = .idle,
    current_executions: std.AutoArrayHashMap(ExecutionId, void),
    last_activity_time: u64,
    total_executions: u64 = 0,
    
    pub fn deinit(self: *ActorState, alloc: Allocator) void {
        self.current_executions.deinit();
    }
};

/// Actor configuration
pub const ActorConfig = struct {
    capability: CapabilityId,
    target: ?[]const u8 = null,
    executor: ToolExecutorFn,
    idle_timeout_ms: u64 = 30000,
    max_concurrency: u32 = 1,
};

/// Actor class - manages tool execution lifecycle
pub const Actor = struct {
    id: ActorId,
    capability: CapabilityId,
    target: ?[]const u8,
    allocator: Allocator,
    
    state: ActorState,
    mailbox: std.ArrayList(MailboxMessage),
    processing: bool = false,
    executor: ToolExecutorFn,
    idle_timeout_ms: u64,
    max_concurrency: u32,
    abort_controllers: std.AutoArrayHashMap(ExecutionId, *volatile bool),
    on_idle_callback: ?*const fn (*Actor) void = null,
    
    const Self = @This();
    
    pub fn init(
        alloc: Allocator,
        config: ActorConfig,
        on_idle: ?*const fn (*Actor) void,
    ) !*Self {
        var id_buf = try alloc.alloc(u8, 64);
        const timestamp = std.time.milliTimestamp();
        const len = try std.fmt.bufPrint(id_buf, "actor-{d}-{x}", .{ timestamp, @as(u64, @intCast(@intFromPtr(alloc))) });
        
        var self = try alloc.create(Self);
        self.* = .{
            .id = id_buf[0..len.len],
            .capability = config.capability,
            .target = config.target,
            .allocator = alloc,
            .state = .{
                .status = .idle,
                .current_executions = std.AutoArrayHashMap(ExecutionId, void).init(alloc),
                .last_activity_time = @as(u64, @intCast(timestamp)),
            },
            .mailbox = std.ArrayList(MailboxMessage).init(alloc),
            .executor = config.executor,
            .idle_timeout_ms = config.idle_timeout_ms,
            .max_concurrency = config.max_concurrency,
            .abort_controllers = std.AutoArrayHashMap(ExecutionId, *volatile bool).init(alloc),
            .on_idle_callback = on_idle,
        };
        
        return self;
    }
    
    pub fn deinit(self: *Self) void {
        self.allocator.free(self.id);
        self.state.deinit(self.allocator);
        self.mailbox.deinit();
        self.abort_controllers.deinit();
        self.allocator.destroy(self);
    }
    
    /// Check if actor is available for new work
    pub fn isAvailable(self: *const Self) bool {
        return self.state.status == .idle or
            (self.state.status == .active and
            self.state.current_executions.count() < self.max_concurrency);
    }
    
    /// Check if actor is idle and eligible for destruction
    pub fn isIdleAndEligibleForDestruction(self: *const Self) bool {
        if (self.state.status != .idle) return false;
        const now = std.time.milliTimestamp();
        const idle_time = now - self.state.last_activity_time;
        return idle_time >= self.idle_timeout_ms;
    }
    
    /// Get current execution count
    pub fn getCurrentExecutionCount(self: *const Self) usize {
        return self.state.current_executions.count();
    }
    
    /// Send a request to the actor's mailbox
    pub fn send(self: *Self, request: ToolRequest) !*Completion {
        var completion = try self.allocator.create(Completion);
        completion.* = .{};
        
        try self.mailbox.append(.{
            .request = request,
            .completion = completion,
        });
        
        self.state.last_activity_time = @as(u64, @intCast(std.time.milliTimestamp()));
        try self.processMailbox();
        
        return completion;
    }
    
    /// Process messages in the mailbox
    fn processMailbox(self: *Self) !void {
        if (self.processing or self.state.status == .destroyed) return;
        if (self.mailbox.items.len == 0) {
            self.checkIdle();
            return;
        }
        if (self.state.current_executions.count() >= self.max_concurrency) return;
        
        self.processing = true;
        self.state.status = .active;
        
        while (
            self.mailbox.items.len > 0 and
            self.state.current_executions.count() < self.max_concurrency and
            self.state.status != .destroyed
        ) {
            const message = self.mailbox.orderedRemove(0);
            self.executeMessage(message) catch |err| {
                message.completion.error = err;
                message.completion.completed = true;
            };
        }
        
        self.processing = false;
        self.checkIdle();
    }
    
    /// Execute a single mailbox message
    fn executeMessage(self: *Self, message: MailboxMessage) !void {
        const request = message.request;
        const execution_id = request.execution_id;
        
        // Create abort signal for cancellation
        var abort_signal: volatile bool = false;
        try self.abort_controllers.put(execution_id, &abort_signal);
        try self.state.current_executions.put(execution_id, {});
        
        defer {
            self.abort_controllers.remove(execution_id);
            self.state.current_executions.remove(execution_id);
            self.state.last_activity_time = @as(u64, @intCast(std.time.milliTimestamp()));
            
            if (self.state.current_executions.count() == 0) {
                self.state.status = .idle;
            }
        }
        
        // Execute the tool
        const result = self.executor(
            self.allocator,
            request.arguments,
            request.context orelse .{},
            &abort_signal,
        ) catch |err| {
            const error_info = types.ErrorInfo{
                .code = "EXECUTION_ERROR",
                .message = @errorName(err),
            };
            
            message.completion.result = ToolResult{
                .type = "tool.result",
                .capability = self.capability,
                .target = self.target,
                .execution_id = execution_id,
                .result = .{ .object = std.StringArrayHashMap(JsonValue).init(self.allocator) },
                .is_error = true,
            };
            message.completion.completed = true;
            return err;
        };
        
        // Create success result
        message.completion.result = ToolResult{
            .type = "tool.result",
            .capability = self.capability,
            .target = self.target,
            .execution_id = execution_id,
            .result = result,
            .is_error = false,
        };
        message.completion.completed = true;
    }
    
    /// Check if actor should transition to idle state
    fn checkIdle(self: *Self) void {
        if (self.state.current_executions.count() == 0 and self.state.status == .active) {
            self.state.status = .idle;
            if (self.on_idle_callback) |callback| {
                callback(self);
            }
        }
    }
    
    /// Cancel an in-flight execution
    pub fn cancel(self: *Self, execution_id: ExecutionId, reason: ?[]const u8) void {
        if (self.abort_controllers.getPtr(execution_id)) |signal| {
            signal.* = true;
        }
    }
    
    /// Destroy the actor, releasing all resources
    pub fn destroy(self: *Self) void {
        self.state.status = .destroyed;
        
        // Cancel all pending messages
        for (self.mailbox.items) |*message| {
            message.completion.error = error.ActorDestroyed;
            message.completion.completed = true;
        }
        self.mailbox.clearRetainingCapacity();
        
        // Cancel all in-flight executions
        var it = self.abort_controllers.iterator();
        while (it.next()) |entry| {
            entry.value_ptr.* = true;
        }
        self.abort_controllers.clearRetainingCapacity();
        self.state.current_executions.clearRetainingCapacity();
    }
};

/// Global actor counter for ID generation
var actor_counter: u64 = 0;

/// Factory function to create actors
pub fn createActor(
    alloc: Allocator,
    config: ActorConfig,
    on_idle: ?*const fn (*Actor) void,
) !*Actor {
    actor_counter += 1;
    return Actor.init(alloc, config, on_idle);
}

test "actor creation" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    
    const alloc = arena.allocator();
    
    // Dummy executor
    const dummy_executor = struct {
        pub fn exec(
            _: Allocator,
            args: JsonValue,
            _: ExecutionContext,
            _: *volatile bool,
        ) anyerror!JsonValue {
            return args;
        }
    }.exec;
    
    const actor = try createActor(alloc, .{
        .capability = "test",
        .executor = dummy_executor,
    }, null);
    defer actor.deinit();
    
    try std.testing.expectEqualStrings("test", actor.capability);
    try std.testing.expect(actor.isAvailable());
}
