using Microsoft.EntityFrameworkCore;

namespace SeamlessShare;

public sealed class Bootstrap(string dataRoot, ILogger<Bootstrap> logger)
{
    public string DataRoot { get; } = dataRoot;
    public string FilesRoot => Path.Combine(DataRoot, "files");
    public string TokenPath => Path.Combine(DataRoot, "setup-token");
    public readonly SemaphoreSlim UploadLock = new(1, 1);
    private long reservedBytes;

    public void Initialize(bool hasAdmin)
    {
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(FilesRoot);
        if (hasAdmin)
        {
            if (File.Exists(TokenPath)) File.Delete(TokenPath);
            return;
        }
        if (!File.Exists(TokenPath))
        {
            var token = Security.RandomToken(24);
            File.WriteAllText(TokenPath, token);
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(TokenPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        logger.LogWarning("First-run setup token: {Token}", File.ReadAllText(TokenPath).Trim());
    }

    public bool CheckSetupToken(string token) => File.Exists(TokenPath) &&
        Security.EqualsSecret(File.ReadAllText(TokenPath).Trim(), token.Trim());

    public async Task<bool> Reserve(long bytes, ShareDb db)
    {
        await UploadLock.WaitAsync();
        try
        {
            long stored = await db.Items.Where(x => x.DeletedAt == null && (x.ExpiresAt == null || x.ExpiresAt > DateTime.UtcNow)).SumAsync(x => x.Size);
            var settings = await db.Settings.SingleAsync();
            if (bytes < 0 || stored + reservedBytes + bytes > settings.MaxTotalBytes) return false;
            reservedBytes += bytes;
            return true;
        }
        finally { UploadLock.Release(); }
    }

    public void Release(long bytes) => Interlocked.Add(ref reservedBytes, -bytes);
}
