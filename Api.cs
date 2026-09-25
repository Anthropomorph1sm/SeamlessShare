using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace SeamlessShare;

public static class Api
{
    // A per-IP limiter bounds one source, not the queue: many sources can still pile requests into the
    // dashboard. Cap the queue itself and drop requests nobody acted on after a week.
    private const int MaxPendingDevices = 50;
    private const int PendingLifetimeDays = 7;

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api/v1");
        api.MapGet("/session", Session);
        api.MapPost("/enroll", Enroll).RequireRateLimiting("enrollment");
        api.MapGet("/admin/session", AdminSessionStatus);
        api.MapPost("/admin/setup", Setup).RequireRateLimiting("admin-login");
        api.MapPost("/admin/login", Login).RequireRateLimiting("admin-login");

        var devices = api.MapGroup("/devices").AddEndpointFilter(Security.DeviceFilter);
        devices.MapGet("/", ListDevices);

        var items = api.MapGroup("/items").AddEndpointFilter(Security.DeviceFilter);
        items.MapGet("/", ListItems);
        items.MapPost("/text", CreateText);
        items.MapPost("/upload", Upload);
        items.MapGet("/{id}/content", Content);
        items.MapPatch("/{id}/text", EditText);
        items.MapPut("/{id}/position", Position);
        items.MapPut("/positions", Positions);
        items.MapPut("/{id}/pin", Pin);
        items.MapPost("/{id}/ack", Acknowledge);
        items.MapDelete("/{id}", Delete);

        var admin = api.MapGroup("/admin").AddEndpointFilter(Security.AdminFilter);
        admin.MapPost("/logout", Logout);
        admin.MapGet("/devices", AdminDevices);
        admin.MapPost("/devices/{id}/decision", Decide);
        admin.MapPatch("/devices/{id}", Rename);
        admin.MapGet("/storage", Storage);
        admin.MapPut("/storage", SetStorage);
        admin.MapGet("/audit", Audit);
        admin.MapGet("/items", AdminItems);
        admin.MapDelete("/items/{id}", AdminDelete);
    }

    private static async Task<object> Session(HttpContext http, ShareDb db)
    {
        var device = await Security.CurrentDevice(http, db);
        return new { device = device is null ? null : new { device.Id, device.Name, device.Status, code = device.Status == "pending" ? device.Code : null } };
    }

    private static async Task<IResult> Enroll(HttpContext http, ShareDb db, EnrollmentRequest request)
    {
        if (!Security.CanIssueSessionCookie(http)) return Bad("Open the app over HTTPS before registering this device.");
        var existing = await Security.CurrentDevice(http, db);
        if (existing is not null && existing.Status is "pending" or "approved") return Results.Conflict(new { error = "This browser already has a registration." });
        var name = request.Name.Trim();
        if (name.Length is < 2 or > 60) return Bad("Device name must be 2–60 characters.");
        var staleBefore = DateTime.UtcNow.AddDays(-PendingLifetimeDays);
        var stale = await db.Devices.Where(x => x.Status == "pending" && x.CreatedAt < staleBefore).ExecuteDeleteAsync();
        if (stale > 0) db.Audit.Add(new AuditEvent { Action = "device_requests_expired", Detail = $"{stale} unanswered request(s)" });
        if (await db.Devices.CountAsync(x => x.Status == "pending") >= MaxPendingDevices)
        {
            await db.SaveChangesAsync();
            return Results.Problem("Too many device requests are already waiting for approval. Try again later, or ask the administrator to clear the queue.", statusCode: 429);
        }
        var token = Security.RandomToken();
        var device = new Device { Name = name, Code = Security.RandomToken(4).ToUpperInvariant(), CredentialHash = Security.Hash(token) };
        db.Devices.Add(device);
        db.Audit.Add(new AuditEvent { Action = "device_requested", Detail = $"{device.Name} ({device.Id})" });
        await db.SaveChangesAsync();
        http.Response.Cookies.Append(Security.DeviceCookie, token, Security.Cookie(http, TimeSpan.FromDays(365)));
        return Results.Ok(new { device.Id, device.Name, device.Status, device.Code });
    }

    private static async Task<object> AdminSessionStatus(HttpContext http, ShareDb db) =>
        new { setupRequired = !await db.Admins.AnyAsync(), authenticated = await Security.IsAdmin(http, db) };

    private static async Task<IResult> Setup(HttpContext http, ShareDb db, Bootstrap boot, SetupRequest request)
    {
        if (!Security.CanIssueSessionCookie(http)) return Bad("Open the app over HTTPS through Caddy before setting up the administrator.");
        if (await db.Admins.AnyAsync()) return Results.Conflict(new { error = "Admin setup is complete." });
        if (!boot.CheckSetupToken(request.Token)) return Results.Unauthorized();
        if (request.Password.Length < 12) return Bad("Use an admin password of at least 12 characters.");
        var salt = RandomNumberGenerator.GetBytes(16);
        db.Admins.Add(new AdminAccount { Salt = Convert.ToBase64String(salt), PasswordHash = Security.PasswordHash(request.Password, salt) });
        db.Audit.Add(new AuditEvent { Action = "admin_setup", Detail = "Initial administrator configured" });
        await db.SaveChangesAsync();
        File.Delete(boot.TokenPath);
        await CreateAdminSession(http, db);
        return Results.Ok(new { authenticated = true });
    }

    private static async Task<IResult> Login(HttpContext http, ShareDb db, LoginRequest request)
    {
        if (!Security.CanIssueSessionCookie(http)) return Bad("Open the app over HTTPS through Caddy before signing in as administrator.");
        var admin = await db.Admins.FindAsync(1);
        if (admin is null) return Results.Conflict(new { error = "Admin setup required." });
        if (request.Password.Length is < 1 or > 1024 || !Security.EqualsSecret(admin.PasswordHash, Security.PasswordHash(request.Password, Convert.FromBase64String(admin.Salt))))
            return Results.Unauthorized();
        await CreateAdminSession(http, db);
        db.Audit.Add(new AuditEvent { Action = "admin_login", Detail = "Administrator logged in" });
        await db.SaveChangesAsync();
        return Results.Ok(new { authenticated = true });
    }

    private static async Task CreateAdminSession(HttpContext http, ShareDb db)
    {
        var token = Security.RandomToken();
        db.AdminSessions.Add(new AdminSession { TokenHash = Security.Hash(token), ExpiresAt = DateTime.UtcNow.AddHours(12) });
        await db.SaveChangesAsync();
        http.Response.Cookies.Append(Security.AdminCookie, token, Security.Cookie(http, TimeSpan.FromHours(12)));
    }

    private static async Task<IResult> Logout(HttpContext http, ShareDb db)
    {
        if (http.Request.Cookies.TryGetValue(Security.AdminCookie, out var token))
        {
            var hash = Security.Hash(token);
            await db.AdminSessions.Where(x => x.TokenHash == hash).ExecuteDeleteAsync();
        }
        http.Response.Cookies.Delete(Security.AdminCookie);
        return Results.Ok();
    }

    private static async Task<object> ListDevices(ShareDb db, UpdatesHub.Registry registry)
    {
        var devices = await db.Devices.Where(x => x.Status == "approved")
            .OrderBy(x => x.Name).Select(x => new { x.Id, x.Name }).ToListAsync();
        return devices.Select(x => new { x.Id, x.Name, connected = registry.IsConnected(x.Id) }).ToArray();
    }

    private static async Task<IResult> ListItems(HttpContext http, ShareDb db, string? scope, string? q, DateTime? before)
    {
        var me = Security.Device(http);
        scope ??= "public";
        if (scope is not ("public" or "inbox" or "sent")) return Bad("Unknown view.");
        var now = DateTime.UtcNow;
        var query = db.Items.AsNoTracking().Include(x => x.Recipients)
            .Where(x => x.DeletedAt == null && (x.ExpiresAt == null || x.ExpiresAt > now));
        query = scope switch
        {
            "public" => query.Where(x => x.Audience == "public"),
            "inbox" => query.Where(x => x.Audience == "private" && x.Recipients.Any(r => r.DeviceId == me.Id)),
            _ => query.Where(x => x.SenderId == me.Id)
        };
        if (before.HasValue) query = query.Where(x => x.CreatedAt < before.Value);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var term = q.Trim();
            if (term.Length > 100) return Bad("Search is too long.");
            var lowerTerm = term.ToLowerInvariant();
            query = query.Where(x => x.Title.ToLower().Contains(lowerTerm) ||
                (x.Text != null && x.Text.ToLower().Contains(lowerTerm)) ||
                (x.FileName != null && x.FileName.ToLower().Contains(lowerTerm)));
        }
        var result = await query.OrderByDescending(x => x.CreatedAt).Take(200).ToListAsync();
        var ids = result.Select(x => x.SenderId).Distinct().ToArray();
        var names = await db.Devices.Where(x => ids.Contains(x.Id)).ToDictionaryAsync(x => x.Id, x => x.Name);
        var itemIds = result.Select(x => x.Id).ToArray();
        var positions = await db.Positions.Where(x => x.DeviceId == me.Id && itemIds.Contains(x.ItemId)).ToDictionaryAsync(x => x.ItemId);
        return Results.Ok(result.Select(x => ItemView(x, names.GetValueOrDefault(x.SenderId, "Unknown device"), positions.GetValueOrDefault(x.Id))).ToArray());
    }

    private static object ItemView(ShareItem x, string senderName, ItemPosition? position = null) => new
    {
        x.Id, x.SenderId, senderName, x.Audience, x.Kind, x.Title, x.Text, x.FileName, x.ContentType, x.Size,
        x.CreatedAt, x.ExpiresAt, x.Pinned, x.Revision,
        x = position?.X ?? x.X, y = position?.Y ?? x.Y,
        width = position?.Width ?? x.Width, height = position?.Height ?? x.Height,
        recipients = x.Recipients.Select(r => new { r.DeviceId, r.AvailableAt, r.OpenedAt }).ToArray()
    };

    private static async Task<IResult?> ValidateAudience(ShareDb db, string audience, IEnumerable<string>? recipients)
    {
        if (audience is not ("public" or "private")) return Bad("Choose a public or private destination.");
        var targetIds = recipients?.Distinct().ToArray() ?? [];
        if (audience == "public" && targetIds.Length > 0) return Bad("Public items cannot have private recipients.");
        if (audience == "private" && (targetIds.Length is 0 or > 20 || await db.Devices.CountAsync(x => targetIds.Contains(x.Id) && x.Status == "approved") != targetIds.Length))
            return Bad("Choose 1–20 approved recipient devices.");
        return null;
    }

    private static void AddRecipients(ShareItem item, IEnumerable<string>? ids)
    {
        foreach (var id in ids?.Distinct() ?? []) item.Recipients.Add(new ItemRecipient { ItemId = item.Id, DeviceId = id });
    }

    private static async Task<IResult> CreateText(HttpContext http, ShareDb db, IHubContext<UpdatesHub> hub, TextRequest request)
    {
        var text = request.Text?.Trim() ?? "";
        if (text.Length is < 1 or > 100_000) return Bad("Text must be 1–100,000 characters.");
        if (await ValidateAudience(db, request.Audience, request.Recipients) is { } invalid) return invalid;
        var me = Security.Device(http);
        var title = (request.Title ?? "").Trim();
        if (title.Length > 120) return Bad("Title is too long.");
        var count = await db.Items.CountAsync(x => x.SenderId == me.Id);
        var item = NewItem(me, request.Audience, "text", title.Length > 0 ? title : "TEXT NOTE", count, (await db.Settings.SingleAsync()).RetentionDays);
        item.Text = text;
        item.Size = Encoding.UTF8.GetByteCount(text);
        AddRecipients(item, request.Recipients);
        var boot = http.RequestServices.GetRequiredService<Bootstrap>();
        if (!await boot.Reserve(item.Size, db)) return Results.Problem("Storage capacity is full.", statusCode: 507);
        try { db.Items.Add(item); await db.SaveChangesAsync(); }
        finally { boot.Release(item.Size); }
        await Notify(hub, item);
        return Results.Ok(ItemView(item, me.Name));
    }

    private static ShareItem NewItem(Device sender, string audience, string kind, string title, int count, int retentionDays) => new()
    {
        SenderId = sender.Id, Audience = audience, Kind = kind, Title = title,
        X = 100 + count % 8 * 38, Y = 100 + count % 8 * 34,
        ExpiresAt = DateTime.UtcNow.AddDays(retentionDays)
    };

    private static async Task<IResult> Upload(HttpContext http, ShareDb db, Bootstrap boot, IHubContext<UpdatesHub> hub,
        [FromQuery] string audience, [FromQuery] string[]? recipient)
    {
        if (await ValidateAudience(db, audience, recipient) is { } invalid) return invalid;
        if (!http.Request.Headers.TryGetValue("X-File-Name", out var rawName)) return Bad("Filename is required.");
        string fileName;
        try { fileName = Uri.UnescapeDataString(rawName.ToString()); }
        catch { return Bad("Invalid filename."); }
        fileName = Path.GetFileName(fileName.Replace('\\', '/')).Trim();
        if (fileName.Length is < 1 or > 220) return Bad("Filename must be 1–220 characters.");
        var size = http.Request.ContentLength;
        if (size is null) return Results.StatusCode(411);
        if (size.Value < 1 || size.Value > (await db.Settings.SingleAsync()).MaxFileBytes) return Results.Problem("File exceeds the configured file limit.", statusCode: 413);
        if (!await boot.Reserve(size.Value, db)) return Results.Problem("Storage capacity is full.", statusCode: 507);
        var name = Security.RandomToken(24);
        var partial = Path.Combine(boot.FilesRoot, name + ".part");
        var final = Path.Combine(boot.FilesRoot, name);
        try
        {
            await using (var output = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 128, FileOptions.Asynchronous))
                await http.Request.Body.CopyToAsync(output, http.RequestAborted);
            if (new FileInfo(partial).Length != size.Value) return Bad("Upload size changed during transfer.");
            db.ChangeTracker.Clear();
            var me = await Security.CurrentDevice(http, db);
            if (me?.Status != "approved") return Results.Problem("Device approval was revoked during upload.", statusCode: 403);
            if (await ValidateAudience(db, audience, recipient) is { } after) return after;
            var count = await db.Items.CountAsync(x => x.SenderId == me.Id);
            var contentType = DetectImage(partial);
            var item = NewItem(me, audience, contentType is null ? "file" : "image", fileName, count, (await db.Settings.SingleAsync()).RetentionDays);
            item.FileName = fileName;
            item.ContentType = contentType ?? "application/octet-stream";
            item.StorageName = name;
            item.Size = size.Value;
            AddRecipients(item, recipient);
            File.Move(partial, final);
            db.Items.Add(item);
            try { await db.SaveChangesAsync(); }
            catch { File.Delete(final); throw; }
            await Notify(hub, item);
            return Results.Ok(ItemView(item, me.Name));
        }
        catch (OperationCanceledException) { return Results.Problem("Upload cancelled.", statusCode: 499); }
        finally { if (File.Exists(partial)) File.Delete(partial); boot.Release(size.Value); }
    }

    private static string? DetectImage(string path)
    {
        Span<byte> header = stackalloc byte[12];
        using var file = File.OpenRead(path);
        var n = file.Read(header);
        if (n >= 8 && header[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 })) return "image/png";
        if (n >= 3 && header[..3].SequenceEqual(new byte[] { 255, 216, 255 })) return "image/jpeg";
        if (n >= 6 && Encoding.ASCII.GetString(header[..6]) is "GIF87a" or "GIF89a") return "image/gif";
        if (n >= 12 && Encoding.ASCII.GetString(header[..4]) == "RIFF" && Encoding.ASCII.GetString(header[8..12]) == "WEBP") return "image/webp";
        return null;
    }

    private static async Task<ShareItem?> Visible(ShareDb db, string id, string viewerId)
    {
        var now = DateTime.UtcNow;
        return await db.Items.Include(x => x.Recipients).SingleOrDefaultAsync(x => x.Id == id && x.DeletedAt == null &&
            (x.ExpiresAt == null || x.ExpiresAt > now) &&
            (x.Audience == "public" || x.SenderId == viewerId || x.Recipients.Any(r => r.DeviceId == viewerId)));
    }

    private static async Task<IResult> Content(HttpContext http, ShareDb db, Bootstrap boot, string id, bool? download)
    {
        var item = await Visible(db, id, Security.Device(http).Id);
        if (item?.StorageName is null) return Results.NotFound();
        var path = Path.Combine(boot.FilesRoot, item.StorageName);
        if (!File.Exists(path)) return Results.NotFound();
        http.Response.Headers.XContentTypeOptions = "nosniff";
        http.Response.Headers.CacheControl = "no-store";
        var inline = item.Kind == "image" && download != true;
        http.Response.Headers.ContentDisposition = inline ? "inline" : $"attachment; filename*=UTF-8''{Uri.EscapeDataString(item.FileName ?? "download")}";
        return Results.File(path, inline ? item.ContentType : "application/octet-stream", enableRangeProcessing: true);
    }

    private static async Task<IResult> EditText(HttpContext http, ShareDb db, IHubContext<UpdatesHub> hub, string id, EditTextRequest request)
    {
        var item = await Visible(db, id, Security.Device(http).Id);
        if (item is null) return Results.NotFound();
        if (item.SenderId != Security.Device(http).Id || item.Kind != "text") return Results.Problem("Only the sender can edit this item.", statusCode: 403);
        if (request.Revision != item.Revision) return Results.Conflict(new { error = "This note changed. Reload before editing." });
        var text = request.Text?.Trim() ?? "";
        if (text.Length is < 1 or > 100_000 || (request.Title?.Length ?? 0) > 120) return Bad("Invalid note length.");
        item.Text = text; item.Title = string.IsNullOrWhiteSpace(request.Title) ? "TEXT NOTE" : request.Title.Trim();
        item.Size = Encoding.UTF8.GetByteCount(text); item.Revision++;
        await db.SaveChangesAsync();
        await Notify(hub, item);
        return Results.Ok(ItemView(item, Security.Device(http).Name));
    }

    private static async Task<IResult> Position(HttpContext http, ShareDb db, IHubContext<UpdatesHub> hub, string id, PositionRequest request)
    {
        var me = Security.Device(http);
        var item = await Visible(db, id, me.Id);
        if (item is null) return Results.NotFound();
        if (!Finite(request.X, -20000, 20000) || !Finite(request.Y, -20000, 20000) || !Finite(request.Width, 210, 800) || !Finite(request.Height, 150, 800))
            return Bad("Position is out of range.");
        if (item.Audience == "public")
        {
            item.X = request.X; item.Y = request.Y; item.Width = request.Width; item.Height = request.Height;
        }
        else
        {
            var position = await db.Positions.FindAsync(id, me.Id);
            if (position is null) { position = new ItemPosition { ItemId = id, DeviceId = me.Id }; db.Positions.Add(position); }
            position.X = request.X; position.Y = request.Y; position.Width = request.Width; position.Height = request.Height;
        }
        await db.SaveChangesAsync();
        if (item.Audience == "public") await Notify(hub, item);
        return Results.Ok();
    }

    private static async Task<IResult> Positions(HttpContext http, ShareDb db, IHubContext<UpdatesHub> hub, PositionBatchRequest request)
    {
        var updates = request.Items;
        if (updates is null || updates.Length is < 1 or > 200 || updates.Any(x => x is null || string.IsNullOrWhiteSpace(x.Id)) ||
            updates.Select(x => x.Id).Distinct().Count() != updates.Length)
            return Bad("Select 1–200 distinct items to move.");
        if (updates.Any(x => !Finite(x.X, -20000, 20000) || !Finite(x.Y, -20000, 20000) ||
            !Finite(x.Width, 210, 800) || !Finite(x.Height, 150, 800)))
            return Bad("Position is out of range.");

        var me = Security.Device(http);
        var ids = updates.Select(x => x.Id).ToArray();
        var now = DateTime.UtcNow;
        var items = await db.Items.Include(x => x.Recipients).Where(x => ids.Contains(x.Id) && x.DeletedAt == null &&
            (x.ExpiresAt == null || x.ExpiresAt > now) &&
            (x.Audience == "public" || x.SenderId == me.Id || x.Recipients.Any(r => r.DeviceId == me.Id)))
            .ToDictionaryAsync(x => x.Id);
        if (items.Count != updates.Length) return Results.NotFound();

        var privateIds = items.Values.Where(x => x.Audience == "private").Select(x => x.Id).ToArray();
        var privatePositions = await db.Positions.Where(x => x.DeviceId == me.Id && privateIds.Contains(x.ItemId))
            .ToDictionaryAsync(x => x.ItemId);
        foreach (var update in updates)
        {
            var item = items[update.Id];
            if (item.Audience == "public")
            {
                item.X = update.X; item.Y = update.Y; item.Width = update.Width; item.Height = update.Height;
            }
            else
            {
                if (!privatePositions.TryGetValue(item.Id, out var position))
                {
                    position = new ItemPosition { ItemId = item.Id, DeviceId = me.Id };
                    db.Positions.Add(position);
                }
                position.X = update.X; position.Y = update.Y; position.Width = update.Width; position.Height = update.Height;
            }
        }
        await db.SaveChangesAsync();
        if (items.Values.Any(x => x.Audience == "public")) await hub.Clients.Group("approved").SendAsync("changed");
        return Results.Ok();
    }

    private static bool Finite(double value, double min, double max) => double.IsFinite(value) && value >= min && value <= max;

    private static async Task<IResult> Pin(HttpContext http, ShareDb db, IHubContext<UpdatesHub> hub, string id, PinRequest request)
    {
        var item = await Visible(db, id, Security.Device(http).Id);
        if (item is null) return Results.NotFound();
        if (item.SenderId != Security.Device(http).Id) return Results.Problem("Only the sender can pin this item.", statusCode: 403);
        item.Pinned = request.Pinned;
        item.ExpiresAt = request.Pinned ? null : DateTime.UtcNow.AddDays((await db.Settings.SingleAsync()).RetentionDays);
        await db.SaveChangesAsync();
        await Notify(hub, item);
        return Results.Ok();
    }

    private static async Task<IResult> Acknowledge(HttpContext http, ShareDb db, IHubContext<UpdatesHub> hub, string id, string state)
    {
        var me = Security.Device(http);
        var item = await Visible(db, id, me.Id);
        if (item is null || item.Audience != "private") return Results.NotFound();
        var recipient = item.Recipients.SingleOrDefault(x => x.DeviceId == me.Id);
        if (recipient is null) return Results.Problem("Only a recipient can acknowledge delivery.", statusCode: 403);
        if (state == "available") recipient.AvailableAt ??= DateTime.UtcNow;
        else if (state == "opened") { recipient.AvailableAt ??= DateTime.UtcNow; recipient.OpenedAt ??= DateTime.UtcNow; }
        else return Bad("Unknown acknowledgement state.");
        await db.SaveChangesAsync();
        await hub.Clients.Group(UpdatesHub.Group(item.SenderId)).SendAsync("changed");
        return Results.Ok();
    }

    private static async Task<IResult> Delete(HttpContext http, ShareDb db, Bootstrap boot, IHubContext<UpdatesHub> hub, string id)
    {
        var item = await Visible(db, id, Security.Device(http).Id);
        if (item is null) return Results.NotFound();
        if (item.SenderId != Security.Device(http).Id) return Results.Problem("Only the sender can delete this item.", statusCode: 403);
        item.DeletedAt = DateTime.UtcNow;
        await db.SaveChangesAsync();
        if (item.StorageName is not null) File.Delete(Path.Combine(boot.FilesRoot, item.StorageName));
        await Notify(hub, item);
        return Results.Ok();
    }

    private static async Task Notify(IHubContext<UpdatesHub> hub, ShareItem item)
    {
        if (item.Audience == "public") await hub.Clients.Group("approved").SendAsync("changed");
        else
        {
            foreach (var id in item.Recipients.Select(x => x.DeviceId).Append(item.SenderId).Distinct())
                await hub.Clients.Group(UpdatesHub.Group(id)).SendAsync("changed");
        }
    }

    private static async Task<object> AdminDevices(ShareDb db) => await db.Devices.OrderBy(x => x.Status).ThenByDescending(x => x.CreatedAt)
        .Select(x => new { x.Id, x.Name, x.Code, x.Status, x.CreatedAt, x.LastSeenAt }).ToListAsync();

    private static async Task<IResult> Decide(ShareDb db, IHubContext<UpdatesHub> hub, UpdatesHub.Registry registry, string id, DecisionRequest request)
    {
        if (request.Status is not ("approved" or "rejected" or "revoked")) return Bad("Invalid decision.");
        var device = await db.Devices.FindAsync(id);
        if (device is null) return Results.NotFound();
        device.Status = request.Status;
        db.Audit.Add(new AuditEvent { Action = $"device_{request.Status}", Detail = $"{device.Name} ({device.Id})" });
        await db.SaveChangesAsync();
        if (request.Status != "approved") registry.Abort(id);
        await hub.Clients.Group(UpdatesHub.Group(id)).SendAsync("statusChanged");
        return Results.Ok();
    }

    private static async Task<IResult> Rename(ShareDb db, string id, RenameRequest request)
    {
        var device = await db.Devices.FindAsync(id);
        if (device is null) return Results.NotFound();
        var name = request.Name.Trim();
        if (name.Length is < 2 or > 60) return Bad("Device name must be 2–60 characters.");
        device.Name = name;
        db.Audit.Add(new AuditEvent { Action = "device_renamed", Detail = $"{name} ({id})" });
        await db.SaveChangesAsync();
        return Results.Ok();
    }

    private static async Task<object> Storage(ShareDb db)
    {
        var now = DateTime.UtcNow;
        var used = await db.Items.Where(x => x.DeletedAt == null && (x.ExpiresAt == null || x.ExpiresAt > now)).SumAsync(x => x.Size);
        var settings = await db.Settings.SingleAsync();
        return new { usedBytes = used, settings.MaxFileBytes, settings.MaxTotalBytes, settings.RetentionDays };
    }

    private static async Task<IResult> SetStorage(ShareDb db, SettingsRequest request)
    {
        if (request.MaxFileBytes is < 10_000_000 or > 1_000_000_000 ||
            request.MaxTotalBytes is < 1_000_000_000 or > 1_000_000_000_000 ||
            request.MaxTotalBytes < request.MaxFileBytes || request.RetentionDays is < 1 or > 365)
            return Bad("File limit must be 10 MB–1 GB; storage 1 GB–1 TB; retention 1–365 days.");
        var settings = await db.Settings.SingleAsync();
        settings.MaxFileBytes = request.MaxFileBytes;
        settings.MaxTotalBytes = request.MaxTotalBytes;
        settings.RetentionDays = request.RetentionDays;
        db.Audit.Add(new AuditEvent { Action = "storage_settings_changed", Detail = $"{request.MaxFileBytes}/{request.MaxTotalBytes}/{request.RetentionDays}" });
        await db.SaveChangesAsync();
        return Results.Ok(settings);
    }

    private static async Task<object> Audit(ShareDb db) => await db.Audit.OrderByDescending(x => x.Id).Take(100).ToListAsync();

    private static async Task<object> AdminItems(ShareDb db) => await db.Items.AsNoTracking()
        .Where(x => x.DeletedAt == null && (x.ExpiresAt == null || x.ExpiresAt > DateTime.UtcNow))
        .OrderByDescending(x => x.CreatedAt).Take(100)
        .Select(x => new { x.Id, x.Kind, x.Title, x.Audience, x.SenderId, x.Size, x.CreatedAt, x.ExpiresAt, x.Pinned }).ToListAsync();

    private static async Task<IResult> AdminDelete(ShareDb db, Bootstrap boot, IHubContext<UpdatesHub> hub, string id)
    {
        var item = await db.Items.Include(x => x.Recipients).SingleOrDefaultAsync(x => x.Id == id);
        if (item is null) return Results.NotFound();
        item.DeletedAt = DateTime.UtcNow;
        db.Audit.Add(new AuditEvent { Action = "item_removed", Detail = id });
        await db.SaveChangesAsync();
        if (item.StorageName is not null) File.Delete(Path.Combine(boot.FilesRoot, item.StorageName));
        await Notify(hub, item);
        return Results.Ok();
    }

    private static IResult Bad(string message) => Results.BadRequest(new { error = message });
}
