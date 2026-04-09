#!/usr/bin/env python3
"""TAObubbles local server: static hosting + same-origin subnet proxy."""

from __future__ import annotations

import json
import mimetypes
import os
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8080"))
ROOT = Path(__file__).resolve().parent
UPSTREAM_URL = "https://taostats.io/api/dtao/dtaoSubnets?order=market_cap_desc"
CACHE_TTL_SECONDS = 30

cache = {
    "expires_at": 0.0,
    "status": 200,
    "body": b"",
}


class TAOBubblesHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/subnets":
            self.handle_subnet_proxy()
            return
        super().do_GET()

    def do_HEAD(self):
        if self.path == "/api/subnets":
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        super().do_HEAD()

    def translate_path(self, path):
        translated = super().translate_path(path)
        resolved = Path(translated).resolve()
        if ROOT not in resolved.parents and resolved != ROOT:
            return str(ROOT / "__forbidden__")
        return str(resolved)

    def guess_type(self, path):
        mime, _ = mimetypes.guess_type(path)
        return mime or "application/octet-stream"

    def handle_subnet_proxy(self):
        now = time.time()
        if cache["body"] and cache["expires_at"] > now:
            self.send_response(cache["status"])
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(cache["body"])
            return

        req = Request(
            UPSTREAM_URL,
            headers={
                "Accept": "application/json",
                "User-Agent": "TAObubbles/1.0 (+local-proxy)",
            },
            method="GET",
        )

        try:
            with urlopen(req, timeout=12) as resp:
                status = int(getattr(resp, "status", 200))
                body = resp.read()
        except HTTPError as exc:
            status = exc.code
            body = exc.read() if hasattr(exc, "read") else b'{"error":"Upstream error"}'
        except URLError:
            self.send_json(502, {"error": "Upstream fetch failed"})
            return

        cache["expires_at"] = now + CACHE_TTL_SECONDS
        cache["status"] = status
        cache["body"] = body

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), TAOBubblesHandler)
    print(f"TAObubbles server running at http://{HOST}:{PORT}")
    server.serve_forever()
