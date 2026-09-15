const util = @import("util.zig");
pub const Reexported = @import("util.zig").Util;

pub const Client = struct {
    const Self = @This();
    n: u32 = 0,

    pub fn init() Self {
        return .{};
    }

    pub fn connect(self: *Self) *Self {
        self.reset();
        Self.log();
        return self;
    }

    fn reset(self: *Self) void {
        self.n = 0;
    }

    fn log() void {
        util.trace();
    }

    pub fn send(self: *Self) void {
        _ = self;
    }
};

pub fn ping() void {
    var c = Client.init();
    _ = c.connect();
    @import("util.zig").trace();
}
