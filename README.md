# SeamlessShare

A self-hosted canvas for moving notes, images, and files between approved devices on a local network. Each browser requests approval once. The administrator uses a password; ordinary devices remain paired with a secure cookie.

The backend is ASP.NET Core 10 with SQLite and SignalR. The browser UI is dependency-free JavaScript and CSS, served from the same origin. The application stores files on disk and metadata in SQLite. Nothing is sent to a cloud service.

The current REST API contract is available at `/openapi/v1.json` on a running server. Client device permissions still apply to API calls.

## Run on a home server

Requirements: a server with Docker Compose, a stable LAN IP address or local DNS name, and port 443 available. Docker downloads the .NET and Caddy images during the first build.

1. Copy `.env.example` to `.env`, then set `SHARE_HOST` to the server's fixed LAN IP or a local DNS name reachable from your devices.
2. Run `docker compose up -d --build` in this directory.
3. Read the first-run setup token with `docker compose logs app` or from `data/setup-token` on the server. Open `https://<SHARE_HOST>` and select **Admin dashboard** to set an administrator password of at least 12 characters. The token is removed after setup.
4. Open the same address on another device, name that browser, and request access. In the admin dashboard, compare its displayed verification code with the code on the requesting device before approving it.

The application container is reachable only inside the Compose network; Caddy is the LAN entry point. Do not expose port 443 to the internet unless you have reviewed the network and authentication setup for that use.

### Trust the local HTTPS certificate

Caddy creates a local certificate authority for this installation. Export its root certificate after the first start:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./data/seamless-root.crt
```

Install and trust `data/seamless-root.crt` as a **trusted root certificate** on each device that will open the app. On iOS, install the profile and enable full trust in **Settings → General → About → Certificate Trust Settings**. On Android, Windows, macOS, and Linux, use that device's trusted CA installation flow; some browsers also maintain a separate trust store. Use a stable server address: if its IP or hostname changes, update `.env` and reconnect using the new address. Never bypass a browser certificate warning as a substitute for trusting the root certificate.

HTTPS is needed for reliable clipboard access, PWA installation, and phone share integration. Text copy works on a click where the browser permits it. Images can be copied where supported. Files are downloaded; browsers do not offer consistent arbitrary-file clipboard writes. The PWA can appear as a phone share target where the operating system and browser support that feature. If it does not, open the app and paste or select files normally.

## Use

- **Public board:** every approved device can read all public items and move/resize their cards. Only the sender can edit text, pin, or delete; the administrator can delete any item.
- **Private delivery:** select one or more approved recipient devices. Only the sender and those recipients can retrieve the content through the app. Queued items remain on the server while a target device is offline. The sender sees queued, available, and opened states.
- **Expiry:** items expire after seven days by default. The sender can pin an item indefinitely or unpin it to start a fresh retention period. The dashboard can change retention, per-file limit, and total storage capacity. Defaults are 1 GB per file and 20 GB total.
- **Canvas:** drag a card by its header and resize it from the lower-right corner. The newest card starts on top; selecting a card brings it forward. Drag empty canvas space to select all cards in a rectangle, or Ctrl/Command-click cards to add to a selection. Delete (Backspace on some keyboards) removes selected shares sent from this device after confirmation. The wheel scrolls vertically; Shift + wheel scrolls horizontally. Use Space + drag or the middle mouse button to pan; middle-click paste is disabled in the app. Touch drag pans on touch devices. Right-click empty canvas space to add a share at that position. Pasting text or files on the public board shares them immediately without opening the composer. Mobile defaults to the list view. The search box filters the current view without case sensitivity. Text and image card bodies copy on click; file cards download on click, and image cards have a separate download button. The approved-device indicator is green while a device is connected and grey when offline.

Each browser profile is a separate device. Clearing browser data means requesting approval again. Administrators can revoke a device at any time. The home server is trusted with readable files and text; private delivery controls app access but is not end-to-end encryption.

## Data, recovery, and upgrades

The `data/` directory holds the SQLite database, uploaded files, and initial setup token. Caddy's `caddy_data` volume holds its local certificate authority. Back up **both**, preferably while stopped:

```sh
docker compose down4. Open the same address on another device, name that browser, and request access. In the admin dashboard, compare its displayed verification code with the code on the requesting device before approving it.

tar -czf seamless-data.tar.gz data/
docker run --rm -v seamlessshare_caddy_data:/source:ro -v "$PWD":/backup alpine tar -czf /backup/seamless-caddy-data.tar.gz -C /source .
docker compose up -d
```

The Docker volume name may differ if your Compose project name differs; check `docker volume ls`. Restore the database/files and Caddy volume together to preserve pairing and certificate trust. Also retain your administrator password. On first release, SQLite tables are created automatically. Before upgrading a deployed version, back up the data directory and check the release notes for any schema migration.

To reset an administrator password from the server, run `docker compose exec app dotnet SeamlessShare.dll --reset-admin-password`. Enter and confirm the new password at the prompt. Existing administrator sessions are signed out. This command does not change paired devices or shared items.

## Local development and verification

With .NET 10 installed:

```sh
ASPNETCORE_ENVIRONMENT=Development dotnet run --urls http://127.0.0.1:5188
```

Development mode allows non-Secure cookies for localhost testing. Keep that mode bound to localhost. Production uses Secure cookies behind Caddy. The integration test exercises initial setup, multiple browsers, approval and revocation, private isolation, acknowledgement, and file upload/download against a **fresh disposable** data directory:

```sh
ASPNETCORE_ENVIRONMENT=Development SHARE_DATA_DIR=/tmp/seamless-test dotnet run --urls http://127.0.0.1:5188
# In another terminal, after startup:
python3 tests/integration.py http://127.0.0.1:5188 /tmp/seamless-test/setup-token
```

The test creates its own administrator password and test devices. Never point it at an existing installation.
