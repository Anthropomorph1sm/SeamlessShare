using Microsoft.EntityFrameworkCore;

namespace SeamlessShare;

public sealed class CleanupWorker(IServiceScopeFactory scopes, Bootstrap boot, ILogger<CleanupWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Sweep(stoppingToken); }
            catch (Exception error) { logger.LogError(error, "Cleanup failed"); }
            await Task.Delay(TimeSpan.FromMinutes(15), stoppingToken);
        }
    }

    private async Task Sweep(CancellationToken token)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ShareDb>();
        var now = DateTime.UtcNow;
        var expired = await db.Items.Where(x => x.DeletedAt != null || (x.ExpiresAt != null && x.ExpiresAt <= now)).ToListAsync(token);
        foreach (var item in expired)
        {
            if (item.StorageName is not null)
            {
                var path = Path.Combine(boot.FilesRoot, item.StorageName);
                if (File.Exists(path)) File.Delete(path);
            }
            await db.Recipients.Where(x => x.ItemId == item.Id).ExecuteDeleteAsync(token);
            await db.Positions.Where(x => x.ItemId == item.Id).ExecuteDeleteAsync(token);
            db.Items.Remove(item);
        }
        await db.SaveChangesAsync(token);
        await db.AdminSessions.Where(x => x.ExpiresAt <= now).ExecuteDeleteAsync(token);
        foreach (var path in Directory.EnumerateFiles(boot.FilesRoot, "*.part"))
            if (File.GetLastWriteTimeUtc(path) < now.AddHours(-1)) File.Delete(path);
    }
}
