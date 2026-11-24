"""Smoke test untuk server RuangTemu.

Menjalankan server sementara di port acak, lalu memeriksa endpoint HTTP dan
alur signaling WebSocket (join, state, signal, chat, host, ruang penuh).

Butuh: pip install websocket-client
Jalankan: python tests/test_smoke.py
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

import websocket

ROOT = Path(__file__).resolve().parent.parent
ENV = {"PYTHONPATH": str(ROOT)}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_server(base: str, process: subprocess.Popen[bytes], timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            output = process.stdout.read().decode("utf-8", "replace") if process.stdout else ""
            raise RuntimeError(f"Server berhenti lebih awal:\n{output}")
        try:
            with urlopen(f"{base}/healthz", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Server tidak merespons dalam batas waktu")


def get_json(url: str) -> dict:
    with urlopen(url, timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def connect(port: int) -> websocket.WebSocket:
    ws = websocket.create_connection(
        f"ws://127.0.0.1:{port}/ws",
        timeout=5,
        enable_multithread=False,
    )
    return ws


def send(ws: websocket.WebSocket, payload: dict) -> None:
    ws.send(json.dumps(payload))


def recv_until(ws: websocket.WebSocket, wanted: set[str], timeout: float = 5.0) -> dict:
    """Baca pesan sampai salah satu tipe yang ditunggu muncul."""
    ws.settimeout(timeout)
    while True:
        raw = ws.recv()
        if not raw:
            raise AssertionError("Koneksi ditutup tanpa pesan yang diharapkan")
        message = json.loads(raw)
        if message.get("type") in wanted:
            return message


def join(ws: websocket.WebSocket, name: str, room: str = "TEST-1") -> dict:
    send(ws, {"type": "join", "room": room, "name": name, "muted": False, "cameraOff": False})
    return recv_until(ws, {"welcome", "error"})


def check(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"  ok  {label}")


def main() -> int:
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", str(port), "--max-peers", "2"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env={**__import__("os").environ, **ENV},
    )
    sockets: list[websocket.WebSocket] = []
    try:
        wait_for_server(base, process)
        print("\nHTTP")
        health = get_json(f"{base}/healthz")
        check(health.get("ok") is True, "healthz merespons")
        config = get_json(f"{base}/api/config")
        check(isinstance(config.get("iceServers"), list) and config["iceServers"], "konfigurasi ICE tersedia")
        check(config.get("maxPeers") == 2, "kapasitas ruang dari argumen")

        with urlopen(f"{base}/", timeout=3) as response:
            html = response.read().decode("utf-8")
            headers = response.headers
        check(response.status == 200 and "RuangTemu" in html, "halaman aplikasi disajikan")
        check("Content-Security-Policy" in headers, "header CSP terpasang")

        try:
            urlopen(f"{base}/../server.py", timeout=3)
            raise AssertionError("Path traversal seharusnya ditolak")
        except HTTPError as exc:
            check(exc.code == 404, "path traversal ditolak")

        print("\nWebSocket")
        alice = connect(port)
        sockets.append(alice)
        alice_welcome = join(alice, "Alice")
        check(alice_welcome["type"] == "welcome", "Alice mendapat welcome")
        check(alice_welcome["self"]["isHost"] is True, "Alice menjadi host pertama")
        check(alice_welcome["room"] == "TEST-1", "kode ruang dinormalisasi")

        bob = connect(port)
        sockets.append(bob)
        bob_welcome = join(bob, "Bob")
        check(bob_welcome["type"] == "welcome", "Bob mendapat welcome")
        check(bob_welcome["hostId"] == alice_welcome["self"]["id"], "Bob melihat host yang benar")
        check(
            [peer["name"] for peer in bob_welcome["peers"]] == ["Alice"],
            "Bob melihat Alice di daftar peserta",
        )
        alice_peer = recv_until(alice, {"peer-joined"})
        check(alice_peer["peer"]["name"] == "Bob", "Alice menerima peer-joined Bob")

        send(bob, {"type": "state", "muted": True, "cameraOff": True, "screen": False})
        state = recv_until(alice, {"peer-state"})
        check(state["id"] == bob_welcome["self"]["id"] and state["muted"] and state["cameraOff"], "state peserta diteruskan")

        send(bob, {"type": "signal", "to": alice_welcome["self"]["id"], "data": {"description": {"type": "offer", "sdp": "x"}}})
        signal = recv_until(alice, {"signal"})
        check(signal["from"] == bob_welcome["self"]["id"] and signal["data"]["description"]["sdp"] == "x", "signal diteruskan ke target")

        send(alice, {"type": "chat", "text": "Halo dari Alice"})
        chat_alice = recv_until(alice, {"chat"})
        chat_bob = recv_until(bob, {"chat"})
        check(chat_alice["text"] == "Halo dari Alice" and chat_bob["name"] == "Alice", "chat disiarkan ke semua peserta")

        carol = connect(port)
        sockets.append(carol)
        carol_error = join(carol, "Carol")
        check(carol_error["type"] == "error" and carol_error["code"] == "room-full", "peserta melebihi kapasitas ditolak")

        alice.close()
        left = recv_until(bob, {"peer-left"})
        promoted = recv_until(bob, {"host-changed"})
        check(left["name"] == "Alice", "peer-left diterima")
        check(promoted["hostId"] == bob_welcome["self"]["id"], "host dipindahkan ke peserta berikutnya")

        dave = connect(port)
        sockets.append(dave)
        dave_welcome = join(dave, "Dave")
        check(dave_welcome["hostId"] == bob_welcome["self"]["id"], "host baru terlihat oleh peserta masuk")
        check(any(peer["name"] == "Bob" for peer in dave_welcome["peers"]), "Dave melihat Bob")

        print("\nSemua tes lulus.")
        return 0
    finally:
        for ws in sockets:
            try:
                ws.close()
            except Exception:
                pass
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
