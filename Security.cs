using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;

namespace SeamlessShare;

public static class Security
{
    public const string DeviceCookie = "ss_device";
    public const string AdminCookie = "ss_admin";

    public static string RandomToken(int bytes = 32) => Convert.ToHexString(RandomNumberGenerator.GetBytes(bytes)).ToLowerInvariant();
    public static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public static bool EqualsSecret(string a, string b)
    {
        var left = Encoding.UTF8.GetBytes(a);
        var right = Encoding.UTF8.GetBytes(b);
        return left.Length == right.Length && CryptographicOperations.FixedTimeEquals(left, right);
    }

    public static string PasswordHash(string password, byte[] salt) =>
        Convert.ToBase64String(Rfc2898DeriveBytes.Pbkdf2(password, salt, 310_000, HashAlgorithmName.SHA256, 32));

    public static CookieOptions Cookie(HttpContext http, TimeSpan lifetime) => new()
    {
        HttpOnly = true,
        Secure = !http.RequestServices.GetRequiredService<IHostEnvironment>().IsDevelopment(),
        SameSite = SameSiteMode.Strict,
        Path = "/",
        MaxAge = lifetime
    };

    public static bool CanIssueSessionCookie(HttpContext http) =>
        http.Request.IsHttps || http.RequestServices.GetRequiredService<IHostEnvironment>().IsDevelopment();

    public static async Task<Device?> CurrentDevice(HttpContext http, ShareDb db)
    {
        if (!http.Request.Cookies.TryGetValue(DeviceCookie, out var value) || string.IsNullOrWhiteSpace(value)) return null;
        var hash = Hash(value);
        return await db.Devices.SingleOrDefaultAsync(x => x.CredentialHash == hash);
    }

    public static async Task<bool> IsAdmin(HttpContext http, ShareDb db)
    {
        if (!http.Request.Cookies.TryGetValue(AdminCookie, out var value) || string.IsNullOrWhiteSpace(value)) return false;
        var hash = Hash(value);
        return await db.AdminSessions.AnyAsync(x => x.TokenHash == hash && x.ExpiresAt > DateTime.UtcNow);
    }

    public static async ValueTask<object?> DeviceFilter(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var db = http.RequestServices.GetRequiredService<ShareDb>();
        var device = await CurrentDevice(http, db);
        if (device?.Status != "approved") return Results.Problem("This device is not approved.", statusCode: 403);
        http.Items["device"] = device;
        if (!device.LastSeenAt.HasValue || device.LastSeenAt < DateTime.UtcNow.AddMinutes(-1))
        {
            device.LastSeenAt = DateTime.UtcNow;
            await db.SaveChangesAsync();
        }
        return await next(context);
    }

    public static async ValueTask<object?> AdminFilter(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var db = context.HttpContext.RequestServices.GetRequiredService<ShareDb>();
        if (!await IsAdmin(context.HttpContext, db)) return Results.Problem("Admin login required.", statusCode: 401);
        return await next(context);
    }

    public static Device Device(HttpContext http) => (Device)http.Items["device"]!;
}
