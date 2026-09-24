using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace SeamlessShare;

public sealed class UpdatesHub(ShareDb db, UpdatesHub.Registry registry) : Hub
{
    public sealed class Registry
    {
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, HubCallerContext>> byDevice = new();
        public void Add(string deviceId, HubCallerContext context) =>
            byDevice.GetOrAdd(deviceId, _ => new()).TryAdd(context.ConnectionId, context);
        public void Remove(string deviceId, string connectionId)
        {
            if (byDevice.TryGetValue(deviceId, out var connections)) connections.TryRemove(connectionId, out _);
        }
        public bool IsConnected(string deviceId) =>
            byDevice.TryGetValue(deviceId, out var connections) && !connections.IsEmpty;
        public void Abort(string deviceId)
        {
            if (byDevice.TryGetValue(deviceId, out var connections))
                foreach (var connection in connections.Values) connection.Abort();
        }
    }

    public static string Group(string deviceId) => "device:" + deviceId;

    public override async Task OnConnectedAsync()
    {
        var http = Context.GetHttpContext();
        if (http is null) { Context.Abort(); return; }
        var device = await Security.CurrentDevice(http, db);
        if (device?.Status != "approved") { Context.Abort(); return; }
        Context.Items["deviceId"] = device.Id;
        registry.Add(device.Id, Context);
        await Groups.AddToGroupAsync(Context.ConnectionId, "approved");
        await Groups.AddToGroupAsync(Context.ConnectionId, Group(device.Id));
        await Clients.Group("approved").SendAsync("presenceChanged");
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue("deviceId", out var id) && id is string deviceId)
        {
            registry.Remove(deviceId, Context.ConnectionId);
            await Clients.Group("approved").SendAsync("presenceChanged");
        }
        await base.OnDisconnectedAsync(exception);
    }
}
