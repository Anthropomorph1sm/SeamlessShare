# SeamlessShare

A self-hosted canvas for moving notes, images and files between approved devices on a local network. Each browser asks for approval once; the administrator signs in with a password and every other device stays paired with a secure cookie.

The server is ASP.NET Core 10 with SQLite and SignalR. The browser UI is dependency-free JavaScript and CSS served from the same origin. Files are stored on disk and metadata in SQLite. Nothing is sent to a cloud service.

The live REST API contract is served at `/openapi/v1.json` on a running server. Device permissions apply to API calls exactly as they do to the UI.

## Screenshots

![Public board with example shares](docs/screenshots/public-board.jpg)

![Two cards selected on the canvas](docs/screenshots/multi-select.jpg)

![New share composer](docs/screenshots/new-share.jpg)

![Admin dashboard with a pending device request](docs/screenshots/admin-dashboard.jpg)

## What it does

- **Public board** — every approved device can read public items and arrange them. Only the sender can edit, pin or delete; the administrator can delete anything.
- **Private delivery** — send to specific approved devices. Queued items wait on the server while a target device is offline, and the sender sees queued, available and opened states.
- **Canvas and list views** — cards can be moved, resized, selected and searched. Phones default to the list view.
- **Expiry** — items expire after seven days unless pinned. The dashboard controls retention, per-file size and total storage capacity.
- **Device approval** — each browser profile is a separate device. The administrator approves, renames and revokes them, and revocation takes effect immediately.

## Running it

### With Docker Compose

```sh
cp .env.example .env    # set SHARE_HOST to your server's fixed LAN address
docker compose up -d --build
```

This runs the app behind a Caddy reverse proxy that terminates HTTPS for `SHARE_HOST`. Publish only Caddy's ports and leave the app container on the internal network — the app relies on the proxy both for TLS and for the real client address.

To use the published image instead of building from source, point `compose.hub.yaml` at `anthropomorphism/seamless-share` and run `docker compose -f compose.hub.yaml up -d`. Its volume paths are examples; set them to wherever you keep app data.

### First run

On startup the server writes a one-time setup token to `setup-token` in the data directory and logs it. Open the HTTPS address, choose **Admin dashboard** and set an administrator password of at least 12 characters. The token is deleted once setup completes.

A second device opens the same address, names itself and requests access. Compare its verification code against the one in the dashboard before approving it.

### Trusting the certificate

Caddy issues a local certificate authority for this installation. Copy its root certificate out and trust it on each device that will open the app:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./seamless-root.crt
```

Never dismiss a browser certificate warning as a substitute for trusting the root certificate. If the server address is a bare LAN IP, Caddy's `default_sni` setting — already present in the bundled config — is what lets it select the right certificate. Keep the server address stable; if it changes, update the config and reconnect devices with the new address.

## Data, backups and upgrades

The SQLite database, uploads and Caddy's certificate authority all live in the data volume. Stop the app and back up that whole directory before upgrading or moving to another machine; pairing and certificate trust are both stored there.

To reset an administrator password without losing paired devices:

```sh
docker compose exec app dotnet SeamlessShare.dll --reset-admin-password
```

Existing administrator sessions are signed out. Tables are created automatically on first release; check the release notes before upgrading a deployed version in case a schema migration is needed.

## Development

With .NET 10 installed:

```sh
ASPNETCORE_ENVIRONMENT=Development dotnet run --urls http://127.0.0.1:5188
```

Development mode allows non-Secure cookies for localhost testing, so keep it bound to localhost. The integration test covers setup, multiple devices, approval and revocation, private isolation, delivery, upload/download and expiry, against a **fresh disposable** data directory:

```sh
ASPNETCORE_ENVIRONMENT=Development SHARE_DATA_DIR=/tmp/seamless-test dotnet run --urls http://127.0.0.1:5188
# in another terminal, once the server is up:
python3 tests/integration.py http://127.0.0.1:5188 /tmp/seamless-test/setup-token
```

The test creates its own administrator password and test devices. Never point it at an existing installation.

## Notes

- Clearing browser data on a device means requesting approval again.
- Private delivery controls who can retrieve an item through the app; it is not end-to-end encryption. The server can read what passes through it.
- HTTPS is needed for reliable clipboard access, PWA installation and phone share integration.
