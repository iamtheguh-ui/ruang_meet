"""HTTP static server + endpoint WebSocket untuk RuangTemu."""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import socket
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from signaling import (
    IDLE_CLOSE_SECONDS,
    IDLE_PING_SECONDS,
    WS_GUID,
    Client,
    Hub,
    ProtocolError,
    WSConnection,
)

PUBLIC_DIR = (Path(__file__).resolve().parent / "public").resolve()
JOIN_TIMEOUT_SECONDS = 30.0
MAX_STATIC_BYTES = 8 * 1024 * 1024

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "base-uri 'none'; "
        "object-src 'none'; "
        "frame-ancestors 'none'; "
        "form-action 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "font-src 'self' data:; "
        "connect-src 'self' ws: wss:; "
        "worker-src 'self'; "
        "manifest-src 'self'"
    ),
}

MIME_OVERRIDES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/png",
    ".txt": "text/plain; charset=utf-8",
}


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        handler: type[BaseHTTPRequestHandler],
        *,
        hub: Hub,
        ice_servers: list[dict[str, Any]],
        version: str,
        logger: Any = print,
    ) -> None:
        self.hub = hub
        self.ice_servers = ice_servers
        self.app_version = version
        self.started_at = time.time()
        self.logger = logger
        super().__init__(address, handler)

    def handle_error(self, request: Any, client_address: Any) -> None:
        exc = __import__("sys").exc_info()[1]
        if isinstance(
            exc,
            (
                ConnectionError,
                BrokenPipeError,
                ConnectionResetError,
                TimeoutError,
                socket.timeout,
                ssl.SSLError,
                ProtocolError,
            ),
        ):
            return
        super().handle_error(request, client_address)


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "RuangTemu"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------------ HTTP
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/ws":
            self._handle_websocket()
            return
        if path == "/api/config":
            server: AppServer = self.server  # type: ignore[assignment]
            self._send_json(
                {
                    "app": "RuangTemu",
                    "version": server.app_version,
                    "iceServers": server.ice_servers,
                    "maxPeers": server.hub.max_peers,
                    "serverTime": int(time.time() * 1000),
                }
            )
            return
        if path in ("/healthz", "/api/health"):
            server = self.server  # type: ignore[assignment]
            stats = server.hub.stats()
            self._send_json(
                {
                    "ok": True,
                    "app": "RuangTemu",
                    "version": server.app_version,
                    "uptimeSeconds": int(time.time() - server.started_at),
                    **stats,
                }
            )
            return

        self._serve_static(path, head=False)

    def do_HEAD(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/") or path == "/healthz" or path == "/ws":
            self._send_text(405, "Metode tidak didukung.")
            return
        self._serve_static(path, head=True)

    # -------------------------------------------------------------- statis
    def _serve_static(self, path: str, head: bool = False) -> None:
        if path in ("", "/"):
            relative = "index.html"
        elif path == "/favicon.ico":
            relative = "icons/icon-192.png"
        elif path == "/apple-touch-icon.png":
            relative = "icons/icon-192.png"
        else:
            relative = path.lstrip("/")

        if ".." in Path(relative).parts or any(part.startswith(".") for part in Path(relative).parts):
            self._send_text(404, "Halaman tidak ditemukan.")
            return

        candidate = (PUBLIC_DIR / relative).resolve()
        if not candidate.is_relative_to(PUBLIC_DIR) or not candidate.is_file():
            self._send_text(404, "Halaman tidak ditemukan.")
            return
        if candidate.stat().st_size > MAX_STATIC_BYTES:
            self._send_text(413, "Berkas terlalu besar.")
            return

        content_type = MIME_OVERRIDES.get(candidate.suffix.lower())
        if content_type is None:
            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"

        data = candidate.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Service-Worker-Allowed", "/")
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        if not head:
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _send_text(self, status: int, message: str) -> None:
        data = (message + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # --------------------------------------------------------------- websocket
    def _handle_websocket(self) -> None:
        if self.headers.get("Upgrade", "").lower() != "websocket":
            self._send_text(400, "Endpoint ini hanya untuk WebSocket.")
            return
        key = self.headers.get("Sec-WebSocket-Key", "").strip()
        version = self.headers.get("Sec-WebSocket-Version", "").strip()
        if not key or version != "13":
            self._send_text(400, "Permintaan WebSocket tidak valid.")
            return

        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        self.close_connection = True
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "Cache-Control: no-store\r\n"
            "\r\n"
        ).encode("ascii")
        try:
            self.wfile.write(response)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return

        server: AppServer = self.server  # type: ignore[assignment]
        ws = WSConnection(self.connection, self.rfile, self.wfile)
        client = Client(ws, self.client_address)
        join_deadline = time.monotonic() + JOIN_TIMEOUT_SECONDS

        try:
            while True:
                try:
                    raw = ws.read_message()
                except socket.timeout:
                    now = time.monotonic()
                    if now - ws.last_activity > IDLE_CLOSE_SECONDS:
                        break
                    if now - ws.last_activity > IDLE_PING_SECONDS:
                        ws.ping()
                    if not client.joined and now > join_deadline:
                        break
                    continue
                except ProtocolError as exc:
                    ws.close(exc.code, str(exc)[:100])
                    break
                except (ConnectionError, OSError, ValueError):
                    break

                if raw is None:
                    break
                if not server.hub.handle_message(client, raw):
                    break
        except Exception as exc:  # noqa: BLE001 - jangan sampai thread diam-diam mati
            server.logger(f"[ws] error tak terduga: {exc!r}")
        finally:
            server.hub.leave(client)
            ws.close(1000, "bye")
            self.close_connection = True

    # ---------------------------------------------------------------- logging
    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        try:
            numeric = int(code)
        except (TypeError, ValueError):
            numeric = 0
        if numeric >= 400:
            self.log_message("HTTP %s %s", code, self.path)

    def log_message(self, fmt: str, *args: Any) -> None:
        timestamp = time.strftime("%H:%M:%S")
        print(f"[{timestamp}] {fmt % args}", flush=True)


def serve_ssl_context(cert_file: Path, key_file: Path) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(str(cert_file), str(key_file))
    return context
