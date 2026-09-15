const std = @import("std");
const net = @import("net.zig");
const Conn = @import("net.zig").Client;

pub fn main() !void {
    var client = Conn.init();
    const c = net.Client.connect(&client);
    c.send();
    std.debug.print("{d}\n", .{helper()});
    net.ping();
    net.Reexported.send();
}

fn helper() u32 {
    return 1;
}
