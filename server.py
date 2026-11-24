#!/usr/bin/env python3
"""RuangTemu - panggilan video & berbagi layar lewat browser.

Contoh:
    python server.py --open
    python server.py --port 8080
    python server.py --ssl            # HTTPS self-signed (butuh cryptography)
    python server.py --ssl --regen-cert
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from signaling import Hub
from webserver import AppServer, RequestHandler, serve_ssl_context

APP_NAME = "RuangTemu"
APP_VERSION = "1.0.0"
BASE_DIR = Path(__file__).resolve().parent
CERT_DIR = BASE_DIR / "certs"

DEFAULT_ICE_SERVERS: list[dict[str, Any]] = [
    {"urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"]},
]


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def load_ice_servers() -> list[dict[str, Any]]:
    """Ambil konfigurasi STUN/TURN dari env, dengan default STUN publik."""
    raw = os.environ.get("ICE_SERVERS", "").strip()
    servers: list[dict[str, Any]] | None = None

    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                parsed = parsed.get("iceServers", parsed.get("ice_servers"))
            if isinstance(parsed, list):
                servers = []
                for item in parsed:
                    if not isinstance(item, dict) or not item.get("urls"):
                        log("ICE_SERVERS: entri tanpa 'urls' dilewati.")
                        continue
                    entry: dict[str, Any] = {"urls": item["urls"]}
                    if item.get("username") is not None:
                        entry["username"] = str(item["username"])
                    if item.get("credential") is not None:
                        entry["credential"] = str(item["credential"])
                    if item.get("credentialType") in ("password", "oauth"):
                        entry["credentialType"] = item["credentialType"]
                    servers.append(entry)
            else:
                log("ICE_SERVERS harus berupa array JSON. Memakai STUN bawaan.")
        except (ValueError, TypeError) as exc:
            log(f"ICE_SERVERS tidak valid ({exc}); memakai STUN bawaan.")

    if servers is None:
        servers = [dict(server) for server in DEFAULT_ICE_SERVERS]

    turn_url = os.environ.get("TURN_URL", "").strip()
    if turn_url:
        urls = [part.strip() for part in turn_url.split(",") if part.strip()]
        entry = {"urls": urls}
        username = os.environ.get("TURN_USERNAME")
        credential = os.environ.get("TURN_CREDENTIAL")
        if username:
            entry["username"] = username
        if credential:
            entry["credential"] = credential
        servers.append(entry)

    return servers


def ice_summary(servers: list[dict[str, Any]]) -> str:
    kinds: set[str] = set()
    for server in servers:
        urls = server.get("urls", "")
        if isinstance(urls, str):
            urls = [urls]
        for url in urls:
            if isinstance(url, str) and ":" in url:
                kinds.add(url.split(":", 1)[0].lower())
    if not kinds:
        return "tidak ada"
    return " + ".join(sorted(kind.upper() for kind in kinds))


def local_ips() -> list[str]:
    ips: set[str] = set()
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            ips.add(ip)
    except OSError:
        pass
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            ips.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass

    cleaned: list[str] = []
    for ip in ips:
        try:
            address = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if address.is_loopback or address.is_unspecified or address.is_multicast:
            continue
        cleaned.append(str(address))
    return sorted(cleaned, key=lambda value: (":" in value, value))


def ensure_certificate(regenerate: bool = False) -> tuple[Path, Path]:
    cert_file = CERT_DIR / "cert.pem"
    key_file = CERT_DIR / "key.pem"
    if cert_file.exists() and key_file.exists() and not regenerate:
        return cert_file, key_file

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
        from datetime import datetime, timedelta, timezone
    except ImportError:
        print(
            "Mode HTTPS membutuhkan paket 'cryptography'.\n"
            "Pasang dengan:  python -m pip install cryptography\n"
            "Atau jalankan tanpa --ssl (kamera di perangkat lain memerlukan HTTPS).",
            flush=True,
        )
        raise SystemExit(2)

    CERT_DIR.mkdir(parents=True, exist_ok=True)
    ips = ["127.0.0.1", "::1", *local_ips()]
    hostname = socket.gethostname()
    dns_names = ["localhost", hostname, f"{hostname}.local"]

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "RuangTemu"),
            x509.NameAttribute(NameOID.COMMON_NAME, "RuangTemu Development"),
        ]
    )
    now = datetime.now(timezone.utc)
    san_entries: list[x509.GeneralName] = [
        x509.DNSName(name) for name in dict.fromkeys(dns_names)
    ] + [x509.IPAddress(ipaddress.ip_address(ip)) for ip in dict.fromkeys(ips)]

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=False,
                key_encipherment=True,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=False,
                crl_sign=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName(san_entries), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )

    key_file.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    try:
        key_file.chmod(0o600)
    except OSError:
        pass
    log(f"Sertifikat self-signed dibuat: {cert_file}")
    return cert_file, key_file


def print_banner(urls: list[str], *, https: bool, ice: str, max_peers: int) -> None:
    print()
    print(f"  {APP_NAME} {APP_VERSION}")
    print("  Panggilan video & berbagi layar lewat browser")
    print()
    for index, url in enumerate(urls):
        label = "Lokal    " if index == 0 else "Jaringan "
        print(f"  {label} {url}")
    print()
    print(f"  ICE      {ice}")
    print(f"  Kapasitas {max_peers} peserta per ruang (mesh WebRTC)")
    if https:
        print("  HTTPS    aktif - sertifikat self-signed, browser akan menampilkan peringatan.")
        print("           Untuk Android sebaiknya gunakan tunnel/deploy HTTPS yang tepercaya.")
    else:
        print("  Catatan  Kamera/mikrofon hanya aktif via localhost atau HTTPS.")
        print("           Untuk uji di Android, jalankan jalankan-publik.bat atau deploy HTTPS.")
    print()
    print("  Tekan Ctrl+C untuk berhenti.")
    print()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Server panggilan video RuangTemu")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"), help="alamat bind (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=env_int("PORT", 8000), help="port HTTP/HTTPS (default 8000)")
    parser.add_argument("--ssl", action="store_true", help="jalankan HTTPS dengan sertifikat self-signed")
    parser.add_argument("--regen-cert", action="store_true", help="buat ulang sertifikat self-signed")
    parser.add_argument("--open", action="store_true", help="buka browser otomatis")
    parser.add_argument(
        "--max-peers",
        type=int,
        default=env_int("MAX_ROOM_SIZE", 8),
        help="kapasitas maksimum peserta per ruang (2-12, default 8)",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    max_peers = max(2, min(12, args.max_peers))
    ice_servers = load_ice_servers()

    cert_file = key_file = None
    ssl_context: ssl.SSLContext | None = None
    if args.ssl:
        cert_file, key_file = ensure_certificate(regenerate=args.regen_cert)
        ssl_context = serve_ssl_context(cert_file, key_file)

    hub = Hub(max_peers=max_peers, log=log)
    try:
        server = AppServer(
            (args.host, args.port),
            RequestHandler,
            hub=hub,
            ice_servers=ice_servers,
            version=APP_VERSION,
            logger=log,
        )
    except OSError as exc:
        print(f"Gagal membuka {args.host}:{args.port} - {exc}", flush=True)
        print("Coba port lain, misalnya: python server.py --port 8080", flush=True)
        return 1

    actual_port = server.server_address[1]
    scheme = "https" if ssl_context else "http"
    if ssl_context:
        server.socket = ssl_context.wrap_socket(server.socket, server_side=True)

    host = args.host
    urls = [f"{scheme}://localhost:{actual_port}"]
    if host in ("0.0.0.0", "::"):
        urls.extend(f"{scheme}://{ip}:{actual_port}" for ip in local_ips())
    elif host not in ("127.0.0.1", "localhost", "::1"):
        urls = [f"{scheme}://{host}:{actual_port}"]

    print_banner(
        urls,
        https=bool(ssl_context),
        ice=ice_summary(ice_servers),
        max_peers=max_peers,
    )
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(urls[0])).start()

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nMenghentikan server...", flush=True)
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
