const std = @import("std");

pub fn build(b: *std.Build) void {
    // Target and optimization
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Tool Actor Runtime library
    const runtime_lib = b.addStaticLibrary(.{
        .name = "tool-actor-runtime",
        .root_source_file = b.path("native/tool-actor-runtime-zig/src/types.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Add all source files to the library
    runtime_lib.addAnonymousSourceModule("types", b.path("native/tool-actor-runtime-zig/src/types.zig"));
    runtime_lib.addAnonymousSourceModule("actor", b.path("native/tool-actor-runtime-zig/src/actor.zig"));

    b.installArtifact(runtime_lib);

    // Agent executable
    const agent_exe = b.addExecutable(.{
        .name = "agent",
        .root_source_file = b.path("examples/agent-zig/agent.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Add module imports
    const types_mod = b.addModule("types", .{
        .root_source_file = b.path("native/tool-actor-runtime-zig/src/types.zig"),
    });

    const actor_mod = b.addModule("actor", .{
        .root_source_file = b.path("native/tool-actor-runtime-zig/src/actor.zig"),
        .imports = &.{
            .{ .name = "types", .module = types_mod },
        },
    });

    agent_exe.root_module.addImport("types", types_mod);
    agent_exe.root_module.addImport("actor", actor_mod);

    b.installArtifact(agent_exe);

    // Run command
    const run_cmd = b.addRunArtifact(agent_exe);
    run_cmd.step.dependOn(b.getInstallStep());

    if (b.args) |args| {
        run_cmd.addArgs(args);
    }

    const run_step = b.step("run", "Run the agent");
    run_step.dependOn(&run_cmd.step);

    // Tests
    const unit_tests = b.addTest(.{
        .root_source_file = b.path("examples/agent-zig/agent.zig"),
        .target = target,
        .optimize = optimize,
    });

    unit_tests.root_module.addImport("types", types_mod);
    unit_tests.root_module.addImport("actor", actor_mod);

    const run_unit_tests = b.addRunArtifact(unit_tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_unit_tests.step);

    // Actor tests
    const actor_tests = b.addTest(.{
        .root_source_file = b.path("native/tool-actor-runtime-zig/src/actor.zig"),
        .target = target,
        .optimize = optimize,
    });

    actor_tests.root_module.addImport("types", types_mod);

    const run_actor_tests = b.addRunArtifact(actor_tests);
    test_step.dependOn(&run_actor_tests.step);
}
