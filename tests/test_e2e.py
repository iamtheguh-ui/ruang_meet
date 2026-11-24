"""Uji end-to-end RuangTemu di Chrome headless.

Menguji alur dua peserta: kamera/mikrofon palsu, koneksi WebRTC, obrolan,
panel peserta, berbagi layar (dengan getDisplayMedia yang distub), keluar
ruang, dan tata letak ponsel.

Butuh: pip install selenium (Chrome/Edge otomatis lewat Selenium Manager)
Jalankan: python tests/test_e2e.py
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ROOT / "tests" / "artifacts"

ERROR_COLLECTOR = """
window.__errors = [];
window.addEventListener('error', (event) => {
  window.__errors.push(String(event.message || event.error || 'error'));
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  window.__errors.push('unhandledrejection: ' + String(reason?.message || reason || ''));
});
const originalError = console.error.bind(console);
console.error = (...args) => {
  window.__errors.push('console.error: ' + args.map((value) => String(value)).join(' '));
  originalError(...args);
};
"""


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_server(base: str, process: subprocess.Popen[bytes], timeout: float = 15.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Server berhenti lebih awal")
        try:
            with urlopen(f"{base}/healthz", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("Server tidak merespons")


def check(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"  ok  {label}")


def wait_js(driver: webdriver.Chrome, script: str, timeout: float = 25.0):
    return WebDriverWait(driver, timeout, poll_frequency=0.25).until(
        lambda current: current.execute_script(script) or False
    )


def install_error_collector(driver: webdriver.Chrome) -> None:
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": ERROR_COLLECTOR})


def join_room(driver: webdriver.Chrome, base: str, name: str, room: str) -> None:
    driver.get(f"{base}/?room={room}")
    wait_js(driver, "return !!document.querySelector('#joinForm');")
    name_input = driver.find_element(By.ID, "nameInput")
    room_input = driver.find_element(By.ID, "roomInput")
    name_input.clear()
    name_input.send_keys(name)
    room_input.clear()
    room_input.send_keys(room)
    driver.find_element(By.ID, "joinBtn").click()
    wait_js(driver, "return !document.querySelector('#meetingView').hidden;", timeout=30)
    wait_js(
        driver,
        """
        const video = document.querySelector('.video-tile.is-self video');
        return !!(video && video.srcObject && video.srcObject.getVideoTracks().length && video.readyState >= 1);
        """,
        timeout=30,
    )
    wait_js(driver, "return document.querySelector('#connPill').dataset.state === 'online';", timeout=20)


def main() -> int:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    process = subprocess.Popen(
        [
            sys.executable,
            str(ROOT / "server.py"),
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--max-peers",
            "4",
        ],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.STDOUT,
        env={**os.environ, "PYTHONPATH": str(ROOT)},
    )

    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--use-fake-ui-for-media-stream")
    options.add_argument("--use-fake-device-for-media-stream")
    options.add_argument("--autoplay-policy=no-user-gesture-required")
    options.add_argument("--window-size=1440,900")

    driver = webdriver.Chrome(options=options)
    driver.set_script_timeout(35)
    install_error_collector(driver)

    try:
        wait_for_server(base, process)
        room = "E2E-TEST"

        print("\nPeserta pertama")
        join_room(driver, base, "Nadia", room)
        check(
            driver.execute_script("return document.querySelector('#mediaWarning').hidden;"),
            "kamera dan mikrofon aktif tanpa peringatan",
        )
        check(
            driver.execute_script(
                "return document.querySelectorAll('.video-tile.is-self').length === 1;"
            ),
            "tile diri sendiri tampil",
        )
        check(
            driver.execute_script(
                "return document.querySelector('.video-tile.is-self').classList.contains('show-avatar') === false;"
            ),
            "video pratinjau diri sendiri berjalan",
        )
        check(
            driver.execute_script("return document.querySelector('#aloneHint').hidden === false;"),
            "petunjuk mengundang tampil saat sendirian",
        )

        print("\nPeserta kedua")
        driver.switch_to.new_window("tab")
        install_error_collector(driver)
        join_room(driver, base, "Budi", room)
        wait_js(
            driver,
            "return document.querySelectorAll('.video-tile').length === 2;",
            timeout=20,
        )
        wait_js(
            driver,
            """
            const video = document.querySelector('.video-tile:not(.is-self) video');
            return !!(video && video.srcObject && video.srcObject.getVideoTracks().length && video.readyState >= 2);
            """,
            timeout=35,
        )
        check(
            driver.execute_script(
                "return document.querySelector('#participantCount').textContent.trim() === '2';"
            ),
            "peserta kedua melihat dua peserta",
        )
        check(
            driver.execute_script(
                "return document.querySelector('.video-tile:not(.is-self) .tile-name').textContent.trim() === 'Nadia';"
            ),
            "nama peserta pertama tampil",
        )
        check(
            driver.execute_script(
                "return document.querySelector('.video-tile:not(.is-self) .tile-status').hidden;"
            ),
            "status menghubungkan hilang setelah video tersambung",
        )

        # Pindah ke tab Nadia untuk memeriksa sisi seberang.
        driver.switch_to.window(driver.window_handles[0])
        wait_js(
            driver,
            """
            const video = document.querySelector('.video-tile:not(.is-self) video');
            return !!(video && video.srcObject && video.srcObject.getVideoTracks().length && video.readyState >= 2);
            """,
            timeout=35,
        )
        check(
            driver.execute_script(
                "return document.querySelector('#participantCount').textContent.trim() === '2';"
            ),
            "peserta pertama melihat peserta kedua",
        )
        check(
            driver.execute_script("return document.querySelector('#aloneHint').hidden;"),
            "petunjuk mengundang tersembunyi saat ada peserta lain",
        )

        print("\nObrolan")
        driver.switch_to.window(driver.window_handles[1])
        driver.find_element(By.ID, "chatBtn").click()
        wait_js(driver, "return !document.querySelector('#sidePanel').hidden;")
        driver.find_element(By.ID, "chatInput").send_keys("Halo dari Budi")
        driver.find_element(By.CSS_SELECTOR, "#chatForm button[type='submit']").click()
        wait_js(
            driver,
            "return document.querySelector('#chatLog').textContent.includes('Halo dari Budi');",
        )

        driver.switch_to.window(driver.window_handles[0])
        wait_js(
            driver,
            "return document.querySelector('#chatLog').textContent.includes('Halo dari Budi');",
            timeout=20,
        )
        check(
            driver.execute_script(
                "return !document.querySelector('#chatUnread').hidden && document.querySelector('#chatUnread').textContent.trim() === '1';"
            ),
            "pesan baru menampilkan lencana belum dibaca",
        )
        driver.find_element(By.ID, "chatBtn").click()
        wait_js(driver, "return !document.querySelector('#sidePanel').hidden;")
        check(
            driver.execute_script("return document.querySelector('#chatUnread').hidden;"),
            "lencana hilang setelah obrolan dibuka",
        )
        check(
            driver.execute_script(
                "return document.querySelector('#chatLog .chat-author').textContent.trim() === 'Budi';"
            ),
            "nama pengirim pesan tampil",
        )
        driver.find_element(By.ID, "chatInput").send_keys("Halo juga, Budi")
        driver.find_element(By.CSS_SELECTOR, "#chatForm button[type='submit']").click()
        wait_js(
            driver,
            "return document.querySelector('#chatLog').textContent.includes('Halo juga, Budi');",
        )
        driver.switch_to.window(driver.window_handles[1])
        wait_js(
            driver,
            "return document.querySelector('#chatLog').textContent.includes('Halo juga, Budi');",
            timeout=20,
        )
        check(True, "obrolan dua arah berjalan")

        print("\nPanel peserta")
        driver.switch_to.window(driver.window_handles[0])
        driver.find_element(By.ID, "peopleBtn").click()
        wait_js(driver, "return !document.querySelector('#peoplePane').hidden;")
        wait_js(
            driver,
            "return document.querySelectorAll('#peopleList .person-row').length === 2;",
        )
        names = driver.execute_script(
            "return [...document.querySelectorAll('#peopleList .person-name')].map((node) => node.textContent);"
        )
        check(any("Nadia" in name for name in names) and any("Budi" in name for name in names), "daftar peserta lengkap")
        driver.find_element(By.ID, "panelCloseBtn").click()

        print("\nMikrofon dan berbagi layar")
        driver.switch_to.window(driver.window_handles[1])
        driver.find_element(By.ID, "micBtn").click()
        driver.switch_to.window(driver.window_handles[0])
        wait_js(
            driver,
            "return document.querySelector('.video-tile:not(.is-self)').classList.contains('is-muted');",
            timeout=15,
        )
        check(True, "status mikrofon mati terlihat oleh peserta lain")

        driver.switch_to.window(driver.window_handles[1])
        driver.execute_script(
            """
            navigator.mediaDevices.getDisplayMedia = async () => {
              return navigator.mediaDevices.getUserMedia({ video: { width: 960, height: 540 } });
            };
            """
        )
        driver.find_element(By.ID, "shareBtn").click()
        wait_js(
            driver,
            "return document.querySelector('.video-tile.is-self').classList.contains('is-screen');",
            timeout=20,
        )
        check(True, "layar sendiri ditampilkan sebagai tile besar")

        driver.switch_to.window(driver.window_handles[0])
        wait_js(
            driver,
            "return document.querySelector('.video-tile:not(.is-self)').classList.contains('is-screen');",
            timeout=25,
        )
        wait_js(
            driver,
            "return document.querySelector('#chatLog').textContent.includes('mulai berbagi layar');",
            timeout=15,
        )
        check(True, "peserta lain menerima siaran layar")
        driver.save_screenshot(str(ARTIFACTS / "e2e-desktop-screen.png"))

        driver.switch_to.window(driver.window_handles[1])
        driver.find_element(By.ID, "shareBtn").click()
        wait_js(
            driver,
            "return !document.querySelector('.video-tile.is-self').classList.contains('is-screen');",
            timeout=20,
        )
        driver.switch_to.window(driver.window_handles[0])
        wait_js(
            driver,
            "return !document.querySelector('.video-tile:not(.is-self)').classList.contains('is-screen');",
            timeout=20,
        )
        check(True, "berbagi layar bisa dihentikan")

        print("\nKeluar ruang")
        driver.switch_to.window(driver.window_handles[1])
        driver.find_element(By.ID, "leaveBtn").click()
        wait_js(driver, "return !document.querySelector('#lobbyView').hidden;", timeout=15)
        check(True, "peserta kembali ke lobi")
        driver.switch_to.window(driver.window_handles[0])
        wait_js(
            driver,
            "return document.querySelector('#participantCount').textContent.trim() === '1';",
            timeout=20,
        )
        wait_js(
            driver,
            "return document.querySelector('#chatLog').textContent.includes('Budi keluar dari ruang');",
            timeout=15,
        )
        check(True, "peserta lain melihat notifikasi keluar")

        print("\nTata letak ponsel")
        driver.set_window_size(390, 844)
        wait_js(driver, "return window.matchMedia('(max-width: 760px)').matches;")
        check(
            driver.execute_script(
                "return getComputedStyle(document.querySelector('.dock-label')).display === 'none';"
            ),
            "label dock disembunyikan di layar sempit",
        )
        check(
            driver.execute_script(
                "return getComputedStyle(document.querySelector('.brand-small .brand-word')).display === 'none';"
            ),
            "nama merek ringkas di header ponsel",
        )
        driver.find_element(By.ID, "chatBtn").click()
        wait_js(driver, "return !document.querySelector('#sidePanel').hidden;")
        check(
            driver.execute_script(
                "return getComputedStyle(document.querySelector('#sidePanel')).position === 'fixed';"
            ),
            "panel obrolan menjadi lapisan penuh di ponsel",
        )
        check(
            driver.execute_script(
                "return getComputedStyle(document.querySelector('#panelScrim')).display !== 'none';"
            ),
            "latar gelap panel tampil di ponsel",
        )
        driver.save_screenshot(str(ARTIFACTS / "e2e-mobile-chat.png"))
        driver.find_element(By.ID, "panelCloseBtn").click()

        errors_a = driver.execute_script("return window.__errors || [];")
        driver.switch_to.window(driver.window_handles[1])
        errors_b = driver.execute_script("return window.__errors || [];")
        check(not errors_a, f"tidak ada error JavaScript di tab pertama: {errors_a}")
        check(not errors_b, f"tidak ada error JavaScript di tab kedua: {errors_b}")

        print("\nSemua tes end-to-end lulus.")
        print(f"Screenshot: {ARTIFACTS}")
        return 0
    finally:
        try:
            driver.quit()
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
