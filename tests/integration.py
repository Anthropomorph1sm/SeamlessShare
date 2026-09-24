"""Exercise the running app with three independent browser cookie jars.

Usage: python3 tests/integration.py http://127.0.0.1:5188 /path/to/data/setup-token
Run against a fresh test data directory: this performs first-run admin setup.
"""
import http.cookiejar
import base64
from datetime import datetime
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request


BASE = sys.argv[1].rstrip("/")
TOKEN = pathlib.Path(sys.argv[2]).read_text().strip()


class Browser:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def request(self, path, method="GET", body=None, headers=None, expect=200):
        headers = dict(headers or {})
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if method != "GET":
            headers["X-Share-Request"] = "1"
        request = urllib.request.Request(BASE + "/api/v1" + path, data=body, method=method, headers=headers)
        try:
            response = self.client.open(request)
        except urllib.error.HTTPError as error:
            response = error
        data = response.read()
        assert response.status == expect, (path, response.status, data.decode(errors="replace"))
        try:
            return json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return data


admin, phone, laptop, stranger = Browser(), Browser(), Browser(), Browser()
assert stranger.request("/session")["device"] is None
admin.request("/admin/setup", "POST", {"token": TOKEN, "password": "a strong local password"})
phone_id = phone.request("/enroll", "POST", {"name": "Test phone"})["id"]
laptop_id = laptop.request("/enroll", "POST", {"name": "Test laptop"})["id"]
stranger_id = stranger.request("/enroll", "POST", {"name": "Unapproved browser"})["id"]
phone.request("/items/", expect=403)
stranger.request("/devices/", expect=403)
for device_id in (phone_id, laptop_id):
    admin.request(f"/admin/devices/{device_id}/decision", "POST", {"status": "approved"})
assert phone.request("/session")["device"]["status"] == "approved"
assert all(device["connected"] is False for device in phone.request("/devices/"))

public = phone.request("/items/text", "POST", {"text": "Copy this note", "title": "Welcome", "audience": "public", "recipients": []})
assert any(x["id"] == public["id"] for x in laptop.request("/items/?scope=public"))
assert any(x["id"] == public["id"] for x in laptop.request("/items/?scope=public&q=wElCoMe"))
assert any(x["id"] == public["id"] for x in laptop.request("/items/?scope=public&q=cOpY"))
edited = phone.request(f"/items/{public['id']}/text", "PATCH", {"text": "Updated note", "title":"Welcome", "revision":1})
assert edited["revision"] == 2
phone.request(f"/items/{public['id']}/text", "PATCH", {"text": "Stale edit", "revision":1}, expect=409)
private = phone.request("/items/text", "POST", {"text": "Phone to laptop only", "audience": "private", "recipients": [laptop_id]})
assert any(x["id"] == private["id"] for x in laptop.request("/items/?scope=inbox"))
assert all(x["id"] != private["id"] for x in laptop.request("/items/?scope=public"))
assert any(x["id"] == private["id"] for x in phone.request("/items/?scope=sent"))
stranger.request("/items/?scope=inbox", expect=403)
admin.request(f"/admin/devices/{stranger_id}/decision", "POST", {"status": "approved"})
assert all(x["id"] != private["id"] for x in stranger.request("/items/?scope=inbox"))
laptop.request(f"/items/{public['id']}/position", "PUT", {"x": 311, "y": 244, "width": 330, "height": 230})
assert next(x for x in phone.request("/items/?scope=public") if x["id"] == public["id"])["x"] == 311
laptop.request(f"/items/{public['id']}/text", "PATCH", {"text":"should fail","revision":1}, expect=403)
laptop.request(f"/items/{public['id']}/pin", "PUT", {"pinned":True}, expect=403)
laptop.request(f"/items/{private['id']}/ack?state=opened", "POST")
sent = phone.request("/items/?scope=sent")
assert next(x for x in sent if x["id"] == private["id"])["recipients"][0]["openedAt"] is not None

payload = b"file payload from the phone\n"
file_item = phone.request("/items/upload?" + urllib.parse.urlencode({"audience": "private", "recipient": laptop_id}), "POST", payload,
    {"X-File-Name": urllib.parse.quote("transfer.txt"), "Content-Type": "application/octet-stream"})
assert laptop.request(f"/items/{file_item['id']}/content") == payload
stranger.request(f"/items/{file_item['id']}/content", expect=404)
png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=")
image = laptop.request("/items/upload?audience=public", "POST", png,
    {"X-File-Name": "pixel.png", "Content-Type": "application/octet-stream"})
assert image["kind"] == "image" and image["contentType"] == "image/png"
assert any(x["id"] == image["id"] for x in stranger.request("/items/?scope=public&q=PiXeL.PnG"))
assert stranger.request(f"/items/{image['id']}/content") == png
admin.request("/admin/storage", "PUT", {"maxFileBytes": 10_000_000, "maxTotalBytes": 2_000_000_000, "retentionDays": 3})
assert admin.request("/admin/storage")["retentionDays"] == 3
new_note = laptop.request("/items/text", "POST", {"text":"Expires in three days","audience":"public"})
created = datetime.fromisoformat(new_note["createdAt"].replace("Z", "+00:00"))
expires = datetime.fromisoformat(new_note["expiresAt"].replace("Z", "+00:00"))
assert 2.9 < (expires - created).total_seconds() / 86400 < 3.1
admin.request(f"/admin/devices/{phone_id}/decision", "POST", {"status": "revoked"})
phone.request("/items/?scope=sent", expect=403)
phone.request("/items/text", "POST", {"text": "must fail", "audience": "public"}, expect=403)
assert laptop.request(f"/items/{file_item['id']}/content") == payload
assert admin.request("/admin/storage")["usedBytes"] > 0
print("PASS: setup, device access/presence, case-insensitive search, public/private isolation, ownership, layout, edit conflicts, delivery, files/images, limits, expiry, revocation")
