/**
 * Generic Agent in Zig using Tool Actor Runtime
 * 
 * This agent demonstrates:
 * - Capability-based tool invocation (zero knowledge of implementation)
 * - Event-driven execution flow
 * - Multiple tools composed to deliver a result
 * - Mode-based configuration (in-memory by default)
 */

const std = @import("std");
const Allocator = std.mem.Allocator;

const types = @import("types.zig");
const actor_module = @import("actor.zig");

const CapabilityId = types.CapabilityId;
const ExecutionId = types.ExecutionId;
const JsonValue = types.JsonValue;
const ExecutionContext = types.ExecutionContext;
const ToolRequest = types.ToolRequest;
const ToolResult = types.ToolResult;
const CapabilityDefinition = types.CapabilityDefinition;
const ModeConfig = types.ModeConfig;
const ExecutionPolicy = types.ExecutionPolicy;
const ToolExecutorFn = types.ToolExecutorFn;
const RegisteredCapability = types.RegisteredCapability;

const Actor = actor_module.Actor;
const ActorConfig = actor_module.ActorConfig;
const createActor = actor_module.createActor;

/// Simple capability registry
pub const CapabilityRegistry = struct {
    allocator: Allocator,
    capabilities: std.StringArrayHashMap(RegisteredCapability),
    
    pub fn init(alloc: Allocator) Self {
        return .{
            .allocator = alloc,
            .capabilities = std.StringArrayHashMap(RegisteredCapability).init(alloc),
        };
    }
    
    const Self = @This();
    
    pub fn deinit(self: *Self) void {
        self.capabilities.deinit();
    }
    
    pub fn register(self: *Self, def: CapabilityDefinition, executor: ToolExecutorFn) !void {
        try self.capabilities.put(def.id, .{
            .definition = def,
            .executor = executor,
            .enabled = true,
        });
    }
    
    pub fn get(self: *Self, id: CapabilityId) ?*RegisteredCapability {
        return self.capabilities.getPtr(id);
    }
    
    pub fn resolveForExecution(self: *Self, id: CapabilityId, target: ?[]const u8) ?ResolvedCapability {
        const reg = self.capabilities.getPtr(id) orelse return null;
        if (!reg.enabled) return null;
        
        return .{
            .id = id,
            .target = target,
            .definition = reg.definition,
            .executor = reg.executor,
        };
    }
};

const ResolvedCapability = struct {
    id: CapabilityId,
    target: ?[]const u8,
    definition: CapabilityDefinition,
    executor: ToolExecutorFn,
};

/// Generate unique execution ID
pub fn generateExecutionId(alloc: Allocator) ![]u8 {
    var buf = try alloc.alloc(u8, 32);
    const timestamp = std.time.milliTimestamp();
    const random_val = std.crypto.random.int(u64);
    const len = try std.fmt.bufPrint(buf, "exec-{d}-{x}", .{ timestamp, random_val });
    return buf[0..len.len];
}

/// Generic Agent that uses capabilities
pub const Agent = struct {
    allocator: Allocator,
    registry: CapabilityRegistry,
    active_actors: std.ArrayList(*Actor),
    
    const Self = @This();
    
    pub fn init(alloc: Allocator) Self {
        return .{
            .allocator = alloc,
            .registry = CapabilityRegistry.init(alloc),
            .active_actors = std.ArrayList(*Actor).init(alloc),
        };
    }
    
    pub fn deinit(self: *Self) void {
        // Destroy all active actors
        for (self.active_actors.items) |actor| {
            actor.destroy();
            actor.deinit();
        }
        self.active_actors.deinit();
        self.registry.deinit();
    }
    
    /// Register a tool capability
    pub fn registerTool(
        self: *Self,
        id: []const u8,
        description: []const u8,
        input_schema: JsonValue,
        output_schema: JsonValue,
        executor: ToolExecutorFn,
    ) !void {
        const def = CapabilityDefinition{
            .id = id,
            .description = description,
            .input_schema = input_schema,
            .output_schema = output_schema,
            .mode = .{ .mode = .@"in-memory" },
        };
        
        try self.registry.register(def, executor);
    }
    
    /// Execute a tool by capability ID
    pub fn executeTool(
        self: *Self,
        capability_id: CapabilityId,
        args: JsonValue,
        target: ?[]const u8,
        context: ?ExecutionContext,
    ) !ToolResult {
        const resolved = self.registry.resolveForExecution(capability_id, target) orelse
            return error.CapabilityNotFound;
        
        const exec_id = try generateExecutionId(self.allocator);
        defer self.allocator.free(exec_id);
        
        // Create request event
        const request = ToolRequest{
            .type = "tool.request",
            .capability = capability_id,
            .target = target,
            .execution_id = exec_id,
            .arguments = args,
            .context = context,
        };
        
        // Create actor for this execution
        const actor = try createActor(self.allocator, .{
            .capability = capability_id,
            .target = target,
            .executor = resolved.executor,
            .idle_timeout_ms = 30000,
            .max_concurrency = 1,
        }, null);
        
        try self.active_actors.append(actor);
        
        // Send to actor and wait for completion
        const completion = try actor.send(request);
        
        // Wait for completion (simple spin-wait for demo)
        while (!completion.completed) {
            std.time.sleep(1_000_000); // 1ms
        }
        
        if (completion.error) |err| {
            return err;
        }
        
        return completion.result.?;
    }
    
    /// Run a workflow with multiple tools
    pub fn runWorkflow(self: *Self) !void {
        std.debug.print("\n=== Agent Workflow Demo ===\n\n", .{});
        
        // Step 1: Search for products
        std.debug.print("Step 1: Searching for products...\n", .{});
        const search_args = .{ .object = blk: {
            var map = std.StringArrayHashMap(JsonValue).init(self.allocator);
            try map.put("target", .{ .string = "product" });
            try map.put("query", .{ .string = "notebook" });
            break :map;
        }};
        
        const search_result = try self.executeTool("search", search_args, "product", null);
        
        if (search_result.is_error) {
            std.debug.print("Search failed!\n", .{});
        } else {
            std.debug.print("Search completed successfully\n", .{});
        }
        
        // Step 2: Read file content
        std.debug.print("\nStep 2: Reading file...\n", .{});
        const read_args = .{ .object = blk: {
            var map = std.StringArrayHashMap(JsonValue).init(self.allocator);
            try map.put("path", .{ .string = "/tmp/test.txt" });
            break :map;
        }};
        
        const read_result = try self.executeTool("filesystem_read", read_args, null, null);
        
        if (read_result.is_error) {
            std.debug.print("File read failed (expected if file doesn't exist)\n", .{});
        } else {
            std.debug.print("File read completed\n", .{});
        }
        
        // Step 3: Calculate something
        std.debug.print("\nStep 3: Calculating...\n", .{});
        const calc_args = .{ .object = blk: {
            var map = std.StringArrayHashMap(JsonValue).init(self.allocator);
            try map.put("operation", .{ .string = "sum" });
            try map.put("values", .{ .array = &.{ .{ .number = 10 }, .{ .number = 20 }, .{ .number = 30 } } }) ;
            break :map;
        }};
        
        const calc_result = try self.executeTool("calculate", calc_args, null, null);
        
        if (calc_result.is_error) {
            std.debug.print("Calculation failed!\n", .{});
        } else {
            std.debug.print("Calculation completed successfully\n", .{});
        }
        
        std.debug.print("\n=== Workflow Complete ===\n\n", .{});
    }
};

/// Example tool implementations
pub const ToolImplementations = struct {
    /// Search tool - returns mock results
    pub fn search(
        alloc: Allocator,
        args: JsonValue,
        _: ExecutionContext,
        _: *volatile bool,
    ) anyerror!JsonValue {
        _ = args;
        
        // Return mock search results
        var results = std.ArrayList(JsonValue).init(alloc);
        defer results.deinit();
        
        try results.append(.{ .object = blk: {
            var map = std.StringArrayHashMap(JsonValue).init(alloc);
            try map.put("id", .{ .number = 1 });
            try map.put("name", .{ .string = "Notebook Pro" });
            try map.put("price", .{ .number = 999.99 });
            break :map;
        }});
        
        try results.append(.{ .object = blk: {
            var map = std.StringArrayHashMap(JsonValue).init(alloc);
            try map.put("id", .{ .number = 2 });
            try map.put("name", .{ .string = "Notebook Lite" });
            try map.put("price", .{ .number = 599.99 });
            break :map;
        }});
        
        return .{ .array = try results.toOwnedSlice() };
    }
    
    /// Filesystem read tool - returns file content or error
    pub fn filesystemRead(
        alloc: Allocator,
        args: JsonValue,
        _: ExecutionContext,
        _: *volatile bool,
    ) anyerror!JsonValue {
        const obj = args.object catch return error.InvalidArguments;
        const path_value = obj.get("path") orelse return error.MissingPath;
        const path = path_value.string catch return error.InvalidPath;
        
        // Try to read the file
        const content = std.fs.cwd().readFileAlloc(alloc, path, 1024 * 1024) catch |err| {
            _ = err;
            return .{ .object = blk: {
                var map = std.StringArrayHashMap(JsonValue).init(alloc);
                try map.put("error", .{ .string = "File not found" });
                try map.put("path", .{ .string = path });
                break :map;
            }};
        };
        
        return .{ .object = blk: {
            var map = std.StringArrayHashMap(JsonValue).init(alloc);
            try map.put("content", .{ .string = content });
            try map.put("path", .{ .string = path });
            break :map;
        }};
    }
    
    /// Calculator tool - performs arithmetic operations
    pub fn calculate(
        alloc: Allocator,
        args: JsonValue,
        _: ExecutionContext,
        _: *volatile bool,
    ) anyerror!JsonValue {
        const obj = args.object catch return error.InvalidArguments;
        
        const op_value = obj.get("operation") orelse return error.MissingOperation;
        const operation = op_value.string catch return error.InvalidOperation;
        
        const values_value = obj.get("values") orelse return error.MissingValues;
        const values_array = values_value.array catch return error.InvalidValues;
        
        var sum: f64 = 0;
        for (values_array) |v| {
            const num = v.number catch return error.InvalidNumber;
            sum += num;
        }
        
        const result = if (std.mem.eql(u8, operation, "sum"))
            sum
        else if (std.mem.eql(u8, operation, "count"))
            @as(f64, @floatFromInt(values_array.len))
        else
            return error.UnknownOperation;
        
        return .{ .object = blk: {
            var map = std.StringArrayHashMap(JsonValue).init(alloc);
            try map.put("result", .{ .number = result });
            try map.put("operation", .{ .string = operation });
            break :map;
        }};
    }
};

pub fn main() !void {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    
    const alloc = arena.allocator();
    
    // Create agent
    var agent = Agent.init(alloc);
    defer agent.deinit();
    
    // Register tools (capabilities)
    try agent.registerTool(
        "search",
        "Search for items by criteria",
        .{ .object = std.StringArrayHashMap(JsonValue).init(alloc) },
        .{ .array = &.{} },
        ToolImplementations.search,
    );
    
    try agent.registerTool(
        "filesystem_read",
        "Read file content from filesystem",
        .{ .object = std.StringArrayHashMap(JsonValue).init(alloc) },
        .{ .object = std.StringArrayHashMap(JsonValue).init(alloc) },
        ToolImplementations.filesystemRead,
    );
    
    try agent.registerTool(
        "calculate",
        "Perform arithmetic calculations",
        .{ .object = std.StringArrayHashMap(JsonValue).init(alloc) },
        .{ .object = std.StringArrayHashMap(JsonValue).init(alloc) },
        ToolImplementations.calculate,
    );
    
    // Run the workflow
    try agent.runWorkflow();
    
    std.debug.print("Agent execution completed successfully!\n", .{});
}

test "agent workflow" {
    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();
    
    const alloc = arena.allocator();
    
    var agent = Agent.init(alloc);
    defer agent.deinit();
    
    // Register a simple echo tool
    const echo_executor = struct {
        pub fn exec(
            alloc: Allocator,
            args: JsonValue,
            _: ExecutionContext,
            _: *volatile bool,
        ) anyerror!JsonValue {
            return args;
        }
    }.exec;
    
    try agent.registerTool(
        "echo",
        "Echo back the input",
        .{ .object = std.StringArrayHashMap(JsonValue).init(alloc) },
        .{ .object = std.StringArrayHashMap(JsonValue).init(alloc) },
        echo_executor,
    );
    
    // Execute the echo tool
    const args = .{ .object = blk: {
        var map = std.StringArrayHashMap(JsonValue).init(alloc);
        try map.put("message", .{ .string = "hello" });
        break :map;
    }};
    
    const result = try agent.executeTool("echo", args, null, null);
    
    try std.testing.expect(!result.is_error);
}
