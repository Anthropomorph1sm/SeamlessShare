using Microsoft.EntityFrameworkCore;

namespace SeamlessShare;

public sealed class ShareDb(DbContextOptions<ShareDb> options) : DbContext(options)
{
    public DbSet<Device> Devices => Set<Device>();
    public DbSet<ShareItem> Items => Set<ShareItem>();
    public DbSet<ItemRecipient> Recipients => Set<ItemRecipient>();
    public DbSet<ItemPosition> Positions => Set<ItemPosition>();
    public DbSet<AdminAccount> Admins => Set<AdminAccount>();
    public DbSet<AdminSession> AdminSessions => Set<AdminSession>();
    public DbSet<AuditEvent> Audit => Set<AuditEvent>();
    public DbSet<ServerSetting> Settings => Set<ServerSetting>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.Entity<Device>().HasIndex(x => x.CredentialHash).IsUnique();
        model.Entity<ShareItem>().HasIndex(x => x.ExpiresAt);
        model.Entity<ItemRecipient>().HasKey(x => new { x.ItemId, x.DeviceId });
        model.Entity<ShareItem>().HasMany(x => x.Recipients).WithOne().HasForeignKey(x => x.ItemId).OnDelete(DeleteBehavior.Cascade);
        model.Entity<ItemPosition>().HasKey(x => new { x.ItemId, x.DeviceId });
        model.Entity<AdminSession>().HasIndex(x => x.TokenHash).IsUnique();
    }
}

public sealed class Device
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Code { get; set; } = "";
    public string Status { get; set; } = "pending";
    public string CredentialHash { get; set; } = "";
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastSeenAt { get; set; }
}

public sealed class ShareItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string SenderId { get; set; } = "";
    public string Audience { get; set; } = "public";
    public string Kind { get; set; } = "text";
    public string Title { get; set; } = "";
    public string? Text { get; set; }
    public string? StorageName { get; set; }
    public string? FileName { get; set; }
    public string? ContentType { get; set; }
    public long Size { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double Width { get; set; } = 310;
    public double Height { get; set; } = 220;
    public long Revision { get; set; } = 1;
    public bool Pinned { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? ExpiresAt { get; set; } = DateTime.UtcNow.AddDays(7);
    public DateTime? DeletedAt { get; set; }
    public List<ItemRecipient> Recipients { get; set; } = [];
}

public sealed class ItemRecipient
{
    public string ItemId { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public DateTime? AvailableAt { get; set; }
    public DateTime? OpenedAt { get; set; }
}

public sealed class ItemPosition
{
    public string ItemId { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public double X { get; set; }
    public double Y { get; set; }
    public double Width { get; set; }
    public double Height { get; set; }
}

public sealed class AdminAccount
{
    public int Id { get; set; } = 1;
    public string PasswordHash { get; set; } = "";
    public string Salt { get; set; } = "";
}

public sealed class AdminSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string TokenHash { get; set; } = "";
    public DateTime ExpiresAt { get; set; }
}

public sealed class AuditEvent
{
    public long Id { get; set; }
    public DateTime At { get; set; } = DateTime.UtcNow;
    public string Action { get; set; } = "";
    public string Detail { get; set; } = "";
}

public sealed class ServerSetting
{
    public int Id { get; set; } = 1;
    public long MaxFileBytes { get; set; } = 1_000_000_000;
    public long MaxTotalBytes { get; set; } = 20_000_000_000;
    public int RetentionDays { get; set; } = 7;
}

public sealed record EnrollmentRequest(string Name);
public sealed record SetupRequest(string Token, string Password);
public sealed record LoginRequest(string Password);
public sealed record DecisionRequest(string Status);
public sealed record RenameRequest(string Name);
public sealed record TextRequest(string Text, string? Title, string Audience, string[]? Recipients);
public sealed record EditTextRequest(string Text, string? Title, long Revision);
public sealed record PositionRequest(double X, double Y, double Width, double Height);
public sealed record PositionUpdate(string Id, double X, double Y, double Width, double Height);
public sealed record PositionBatchRequest(PositionUpdate[] Items);
public sealed record PinRequest(bool Pinned);
public sealed record SettingsRequest(long MaxFileBytes, long MaxTotalBytes, int RetentionDays);
