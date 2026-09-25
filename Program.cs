using System.Threading.RateLimiting;
using System.Security.Cryptography;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using SeamlessShare;

var builder = WebApplication.CreateBuilder(args);
var dataRoot = Path.GetFullPath(Environment.GetEnvironmentVariable("SHARE_DATA_DIR") ?? Path.Combine(builder.Environment.ContentRootPath, "data"));
Directory.CreateDirectory(dataRoot);
builder.Services.AddDbContext<ShareDb>(options => options.UseSqlite($"Data Source={Path.Combine(dataRoot, "share.db")}"));
builder.Services.AddSingleton(sp => new Bootstrap(dataRoot, sp.GetRequiredService<ILogger<Bootstrap>>()));
builder.Services.AddSingleton<UpdatesHub.Registry>();
builder.Services.AddSignalR();
builder.Services.AddOpenApi();
builder.Services.AddHostedService<CleanupWorker>();
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = 429;
    options.AddPolicy("enrollment", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions
        { PermitLimit = 6, Window = TimeSpan.FromHours(1), QueueLimit = 0 }));
    options.AddPolicy("admin-login", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown", _ => new FixedWindowRateLimiterOptions
        { PermitLimit = 20, Window = TimeSpan.FromMinutes(15), QueueLimit = 0 }));
});
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 1_000_001_024);

var app = builder.Build();
if (Environment.GetEnvironmentVariable("SHARE_TRUST_PROXY") == "true")
{
    // Only enable behind a trusted reverse proxy. The Compose deployment does not expose this app directly.
    // The known-proxy lists are cleared because they cannot be pre-seeded for an arbitrary Compose network.
    // That is safe only because ForwardedHeadersOptions.ForwardLimit defaults to 1, so just the rightmost
    // entry is used — which is the value the reverse proxy wrote. Caddy replaces X-Forwarded-For unless
    // trusted_proxies is set, so a client-supplied value never reaches this middleware. Any deployment that
    // publishes the app's port directly loses that protection and must not set SHARE_TRUST_PROXY at all.
    var forwarded = new ForwardedHeadersOptions { ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto };
    forwarded.KnownIPNetworks.Clear();
    forwarded.KnownProxies.Clear();
    app.UseForwardedHeaders(forwarded);
}
app.UseRateLimiter();
app.Use(async (http, next) =>
{
    http.Response.Headers.XContentTypeOptions = "nosniff";
    http.Response.Headers.XFrameOptions = "DENY";
    http.Response.Headers["Referrer-Policy"] = "no-referrer";
    http.Response.Headers.CacheControl = http.Request.Path.StartsWithSegments("/api") ? "no-store" : "no-cache";
    if (http.Request.Path.StartsWithSegments("/api") && http.Request.Method is not ("GET" or "HEAD" or "OPTIONS"))
    {
        if (http.Request.Headers["X-Share-Request"] != "1")
        {
            http.Response.StatusCode = 403;
            await http.Response.WriteAsJsonAsync(new { error = "Request header required." });
            return;
        }
        if (http.Request.Headers.TryGetValue("Origin", out var origin) &&
            !string.Equals(origin.ToString(), $"{http.Request.Scheme}://{http.Request.Host}", StringComparison.OrdinalIgnoreCase))
        {
            http.Response.StatusCode = 403;
            await http.Response.WriteAsJsonAsync(new { error = "Cross-origin request denied." });
            return;
        }
    }
    await next();
});
app.UseDefaultFiles();
app.UseStaticFiles();
Api.Map(app);
app.MapOpenApi("/openapi/{documentName}.json");
app.MapHub<UpdatesHub>("/hubs/updates");
// Unknown API routes must not fall through to the SPA shell: a typo'd or removed endpoint would
// otherwise answer 200 text/html and quietly look like success to any client or script.
app.MapFallback("/api/{**rest}", () => Results.NotFound(new { error = "Unknown API endpoint." }));
app.MapFallbackToFile("index.html");

using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ShareDb>();
    await db.Database.EnsureCreatedAsync();
    if (!await db.Settings.AnyAsync())
    {
        db.Settings.Add(new ServerSetting());
        await db.SaveChangesAsync();
    }
    app.Services.GetRequiredService<Bootstrap>().Initialize(await db.Admins.AnyAsync());
    if (args.Contains("--reset-admin-password"))
    {
        var admin = await db.Admins.FindAsync(1);
        if (admin is null) { Console.Error.WriteLine("Administrator setup has not been completed."); return; }
        Console.Write("New administrator password (12+ characters): ");
        var password = ReadPassword();
        if (password.Length < 12) { Console.Error.WriteLine("Password is too short."); return; }
        if (!Console.IsInputRedirected)
        {
            Console.Write("Confirm password: ");
            if (password != ReadPassword()) { Console.Error.WriteLine("Passwords did not match."); return; }
        }
        var salt = RandomNumberGenerator.GetBytes(16);
        admin.Salt = Convert.ToBase64String(salt);
        admin.PasswordHash = Security.PasswordHash(password, salt);
        await db.AdminSessions.ExecuteDeleteAsync();
        db.Audit.Add(new AuditEvent { Action = "admin_password_reset", Detail = "Server-local password recovery" });
        await db.SaveChangesAsync();
        Console.WriteLine("Administrator password changed. Existing admin sessions have been signed out.");
        return;
    }
}

await app.RunAsync();

static string ReadPassword()
{
    if (Console.IsInputRedirected) return Console.ReadLine() ?? "";
    var chars = new System.Text.StringBuilder();
    while (true)
    {
        var key = Console.ReadKey(intercept: true);
        if (key.Key == ConsoleKey.Enter) { Console.WriteLine(); return chars.ToString(); }
        if (key.Key == ConsoleKey.Backspace) { if (chars.Length > 0) chars.Length--; }
        else if (!char.IsControl(key.KeyChar)) chars.Append(key.KeyChar);
    }
}

public partial class Program { }
