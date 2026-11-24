"""WebSocket server dan hub signaling RuangTemu.

Modul ini sengaja tidak memakai dependensi eksternal: handshake dan frame
WebSocket diimplementasikan langsung di atas socket. Payload yang dipertukarkan
hanya JSON kecil (SDP, ICE candidate, chat, status peserta).
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
import socket
import struct
import threading
import time
from collections import deque
from typing import Any, Callable

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_MESSAGE_BYTES = 256 * 1024
MAX_CHAT_CHARS = 2000
MAX_NAME_CHARS = 40
MAX_ROOM_CHARS = 40
SOCKET_TIMEOUT = 10.0
IDLE_PING_SECONDS = 25.0
IDLE_CLOSE_SECONDS = 70.0

OP_CONTINUATION = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class ProtocolError(Exception):
    """Frame WebSocket tidak valid."""

    def __init__(self, message: str, code: int = 1002) -> None:
        super().__init__(message)
        self.code = code


class WSConnection:
    """Satu koneksi WebSocket (sisi server)."""

    def __init__(self, sock: socket.socket, rfile: Any, wfile: Any) -> None:
        self.sock = sock
        self.rfile = rfile
        self.wfile = wfile
        self.last_activity = time.monotonic()
        self._write_lock = threading.Lock()
        self._closed = False
        try:
            self.sock.settimeout(SOCKET_TIMEOUT)
        except OSError:
            pass

    # ------------------------------------------------------------------ baca
    def _read_exact(self, size: int) -> bytes:
        data = self.rfile.read(size)
        if not data or len(data) != size:
            raise ConnectionError("Koneksi WebSocket ditutup")
        return data

    def _read_frame(self) -> tuple[bool, int, bytes]:
        header = self._read_exact(2)
        fin = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F

        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]

        if length > MAX_MESSAGE_BYTES:
            raise ProtocolError("Pesan terlalu besar", 1009)
        if not masked:
            raise ProtocolError("Frame klien harus di-mask")
        if opcode >= 0x8 and (length > 125 or not fin):
            raise ProtocolError("Frame kontrol tidak valid")

        mask = self._read_exact(4)
        payload = self._read_exact(length) if length else b""
        if payload:
            payload = bytes(byte ^ mask[index & 3] for index, byte in enumerate(payload))

        self.last_activity = time.monotonic()
        return fin, opcode, payload

    def read_message(self) -> str | None:
        """Baca satu pesan teks. None berarti koneksi ditutup klien."""
        fragments: list[bytes] = []
        message_opcode: int | None = None
        total = 0

        while True:
            fin, opcode, payload = self._read_frame()

            if opcode == OP_CLOSE:
                self._send_frame(OP_CLOSE, payload[:125])
                return None
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue

            if opcode == OP_CONTINUATION:
                if message_opcode is None:
                    raise ProtocolError("Frame lanjutan tanpa pesan awal")
            elif opcode in (OP_TEXT, OP_BINARY):
                if message_opcode is not None:
                    raise ProtocolError("Pesan baru di tengah fragmentasi")
                message_opcode = opcode
            else:
                raise ProtocolError(f"Opcode tidak didukung: {opcode}")

            fragments.append(payload)
            total += len(payload)
            if total > MAX_MESSAGE_BYTES:
                raise ProtocolError("Pesan terlalu besar", 1009)

            if fin:
                if message_opcode == OP_BINARY:
                    raise ProtocolError("Hanya pesan teks yang didukung", 1003)
                raw = b"".join(fragments)
                try:
                    return raw.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise ProtocolError("Pesan bukan UTF-8 yang valid", 1007) from exc

    # ----------------------------------------------------------------- tulis
    def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        if self._closed:
            return
        length = len(payload)
        header = bytearray([0x80 | opcode])
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(127)
            header.extend(struct.pack("!Q", length))

        with self._write_lock:
            if self._closed:
                return
            try:
                self.wfile.write(bytes(header) + payload)
                self.wfile.flush()
            except (OSError, ValueError):
                self._closed = True

    def send_text(self, text: str) -> None:
        self._send_frame(OP_TEXT, text.encode("utf-8"))

    def send_json(self, payload: dict[str, Any]) -> None:
        self.send_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    def ping(self) -> None:
        self._send_frame(OP_PING, b"temu")

    def close(self, code: int = 1000, reason: str = "") -> None:
        if self._closed:
            return
        payload = struct.pack("!H", code) + reason.encode("utf-8")[:100]
        self._send_frame(OP_CLOSE, payload)
        self._closed = True


class Client:
    def __init__(self, ws: WSConnection, address: tuple[str, int] | tuple[Any, ...]) -> None:
        self.ws = ws
        self.id = secrets.token_hex(5)
        self.address = address[0] if address else "?"
        self.name = ""
        self.room = ""
        self.muted = False
        self.camera_off = False
        self.screen = False
        self.is_host = False
        self.joined = False
        self.chat_times: deque[float] = deque(maxlen=12)

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "muted": self.muted,
            "cameraOff": self.camera_off,
            "screen": self.screen,
            "isHost": self.is_host,
        }


def _clean_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    cleaned = " ".join(value.replace("\x00", " ").split())
    return cleaned[:MAX_NAME_CHARS].strip()


def _clean_room(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    room = value.strip().upper()
    if len(room) > MAX_ROOM_CHARS:
        return ""
    return room


class Hub:
    """Menyimpan ruang, peserta, dan meneruskan pesan signaling."""

    def __init__(self, max_peers: int = 8, log: Callable[[str], None] | None = None) -> None:
        self.max_peers = max_peers
        self.rooms: dict[str, dict[str, Client]] = {}
        self._lock = threading.RLock()
        self._log = log or (lambda _message: None)

    def join(
        self,
        client: Client,
        room: str,
        name: str,
        muted: bool = False,
        camera_off: bool = False,
        screen: bool = False,
    ) -> bool:
        room = _clean_room(room)
        name = _clean_name(name)
        if client.joined:
            client.ws.send_json({"type": "error", "code": "already-joined", "message": "Kamu sudah berada di sebuah ruang."})
            return True
        if not room or not name:
            client.ws.send_json({"type": "error", "code": "invalid-join", "message": "Nama dan kode ruang wajib diisi."})
            return True

        with self._lock:
            members = self.rooms.setdefault(room, {})
            if len(members) >= self.max_peers:
                client.ws.send_json(
                    {
                        "type": "error",
                        "code": "room-full",
                        "message": f"Ruang sudah penuh (maksimal {self.max_peers} peserta).",
                    }
                )
                if not members:
                    self.rooms.pop(room, None)
                return False

            client.room = room
            client.name = name
            client.muted = bool(muted)
            client.camera_off = bool(camera_off)
            client.screen = bool(screen)
            client.joined = True
            client.is_host = not any(member.is_host for member in members.values())
            members[client.id] = client

            peers = [member.public() for member in members.values() if member is not client]
            host_id = next((member.id for member in members.values() if member.is_host), client.id)
            count = len(members)

        client.ws.send_json(
            {
                "type": "welcome",
                "self": client.public(),
                "peers": peers,
                "hostId": host_id,
                "room": room,
                "maxPeers": self.max_peers,
                "serverTime": int(time.time() * 1000),
            }
        )
        self.broadcast(room, {"type": "peer-joined", "peer": client.public()}, exclude=client.id)
        self._log(f"+ [{room}] {name} ({client.address}) - {count} peserta")
        return True

    def leave(self, client: Client) -> None:
        with self._lock:
            if not client.joined:
                return
            client.joined = False
            room = client.room
            members = self.rooms.get(room)
            if not members:
                return
            members.pop(client.id, None)
            new_host: str | None = None
            if client.is_host:
                client.is_host = False
                for member in members.values():
                    member.is_host = True
                    new_host = member.id
                    break
            count = len(members)
            if not members:
                self.rooms.pop(room, None)
            name = client.name

        self.broadcast(room, {"type": "peer-left", "id": client.id, "name": name})
        if new_host:
            self.broadcast(room, {"type": "host-changed", "hostId": new_host, "id": new_host})
        self._log(f"- [{room}] {name} ({client.address}) - {count} peserta")

    def broadcast(self, room: str, payload: dict[str, Any], exclude: str | None = None) -> None:
        with self._lock:
            members = list(self.rooms.get(room, {}).values())
        if not members:
            return
        text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        for member in members:
            if member.id == exclude:
                continue
            try:
                member.ws.send_text(text)
            except (OSError, ValueError, ConnectionError):
                pass

    # ------------------------------------------------------------- protokol
    def handle_message(self, client: Client, raw: str) -> bool:
        """Proses satu pesan. Return False bila koneksi harus ditutup."""
        try:
            message = json.loads(raw)
        except (TypeError, ValueError):
            client.ws.send_json({"type": "error", "code": "bad-json", "message": "Pesan tidak valid."})
            return True
        if not isinstance(message, dict):
            client.ws.send_json({"type": "error", "code": "bad-message", "message": "Pesan harus berupa objek."})
            return True

        kind = message.get("type")

        if kind == "join":
            return self.join(
                client,
                room=str(message.get("room", "")),
                name=str(message.get("name", "")),
                muted=bool(message.get("muted", False)),
                camera_off=bool(message.get("cameraOff", False)),
                screen=bool(message.get("screen", False)),
            )

        if kind == "ping":
            client.ws.send_json({"type": "pong", "at": int(time.time() * 1000)})
            return True

        if not client.joined:
            client.ws.send_json({"type": "error", "code": "not-joined", "message": "Gabung ke ruang terlebih dahulu."})
            return True

        if kind == "signal":
            target_id = message.get("to")
            data = message.get("data")
            if not isinstance(target_id, str) or not isinstance(data, dict):
                return True
            with self._lock:
                target = self.rooms.get(client.room, {}).get(target_id)
            if target and target is not client:
                target.ws.send_text(
                    json.dumps(
                        {"type": "signal", "from": client.id, "data": data},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                )
            return True

        if kind == "state":
            client.muted = bool(message.get("muted", client.muted))
            client.camera_off = bool(message.get("cameraOff", client.camera_off))
            client.screen = bool(message.get("screen", client.screen))
            self.broadcast(
                client.room,
                {
                    "type": "peer-state",
                    "id": client.id,
                    "muted": client.muted,
                    "cameraOff": client.camera_off,
                    "screen": client.screen,
                },
                exclude=client.id,
            )
            return True

        if kind == "chat":
            text = message.get("text")
            if not isinstance(text, str):
                return True
            text = text.replace("\r\n", "\n").strip()[:MAX_CHAT_CHARS]
            if not text:
                return True
            now = time.monotonic()
            while client.chat_times and now - client.chat_times[0] > 8:
                client.chat_times.popleft()
            if len(client.chat_times) >= 10:
                client.ws.send_json({"type": "error", "code": "chat-rate", "message": "Terlalu banyak pesan. Tunggu sebentar."})
                return True
            client.chat_times.append(now)
            self.broadcast(
                client.room,
                {
                    "type": "chat",
                    "from": client.id,
                    "name": client.name,
                    "text": text,
                    "at": int(time.time() * 1000),
                },
            )
            return True

        if kind == "leave":
            return False

        client.ws.send_json({"type": "error", "code": "unknown-type", "message": "Jenis pesan tidak dikenal."})
        return True

    def stats(self) -> dict[str, int]:
        with self._lock:
            rooms = len(self.rooms)
            participants = sum(len(members) for members in self.rooms.values())
        return {"rooms": rooms, "participants": participants}
