# RuangTemu

RuangTemu adalah aplikasi web ringan untuk **panggilan video**, **audio**, dan **berbagi layar** tanpa akun. Dibangun dengan WebRTC (WebSocket sebagai sinykaling) dan Python stdlib sebagai server. Bisa dipakai di **laptop**, **Android**, dan browser desktop lainnya — tanpa unduhan app.

## Fitur

- **Video call & audio** langsung antarpeserta lewat WebRTC (mesh untuk 2–8 peserta per ruang).
- **Berbagi layar** (presentasi, slide, demo) lewat `getDisplayMedia` di desktop.
- **Obrolan teks** langsung melalui WebSocket ke peserta di ruang yang sama.
- **Tanpa akun**: kode ruang 3–40 karakter jadi kunci masuk.
- **Host** mengalir otomatis bila peserta pindah dari satu ruang ke ruang lain.
- **Responsif**: layar besar, tablet, dan mobile dengan dock dan panel khusus ponsel.
- **PWA**: installable via browser; ikon, manifest, dan service worker tersedia.

Catatan media: video/audio berjalan **peer-to-peer** (tanpa relay server media). Untuk jarak jauh yang stabil biasanya dibantu TURN; server menaikkan TURN lewat env jika tersedia.

## Cara menjalankan

### 1. Server lokal

```bash
python server.py --host 0.0.0.0 --port 8000 --max-peers 8
```

Atau lewat launcher Windows:

```bat
ruangtemu.bat
```

Setelah server jalan, buka:

- `http://localhost:8000` (dari laptop ini)
- `http://<IP-LAN-laptop>:8000` (dari laptop lain di jaringan yang sama, mis. `http://192.168.1.25:8000`)

> Browser membutuhkan HTTPS (atau `localhost`) sebelum kamera dan mikrofon aktif. Kode ini aman di `http://localhost`.

### 2. HTTPS / Android

Server bisa memakai sertifikat self-signed:

```bash
python server.py --ssl --host 0.0.0.0 --port 8443
python server.py --ssl --regen-cert
```

Tapi **Android tidak mengizinkan kamera/mikrofon pada HTTPS self-signed**, sehingga untuk uji di Android gunakan:

- **Cloudflare quick tunnel** (paling cepat):

```bash
cloudflared tunnel --url http://localhost:8000
```

Buka tautan `https://*.trycloudflare.com` di Chrome Android dan beri izin kamera/mikrofon.

- Atau **deploy HTTPS** (mis. Cloudflare Tunnel permanen, Render, Vercel, dll.) lalu bagikan tautannya.

Setelah HTTPS aktif, Android/Chrome boleh memakai PWA langsung dari browser dan menambahkan ikon ke layar utama.

### 3. Akses dari mana saja / perangkat apa saja

RuangTemu berjalan di mana pun server berada, asalkan:

- Browser modern (Chrome, Edge, Firefox, Safari terbaru).
- Aplikasi browser Android memakai HTTPS.
- Perangkat:
  - Laptop Windows/macOS/Linux (Chrome/Edge/Firefox).
  - Android Chrome (PWA atau tab biasa).
  - Android/iOS browser (via HTTPS dan tambah ke home screen).
  - Desktop dengan desktop app via https.

Untuk panggilan lintas internet yang sangat stabil, set variabel berikut sebelum menjalankan server:

```bash
set ICE_SERVERS='[{"urls":["turn:your-turn-server:3478?transport=udp","turn:your-turn-server:443?transport=tcp"],"username":"username","credential":"password","credentialType":"password"},{"urls":["stun:stun.l.google.com:19302"]}]'
set TURN_URL='turn:your-turn-server:3478?transport=udp,turn:your-turn-server:443?transport=tcp'
python server.py --host 0.0.0.0 --port 8000 --max-peers 8
```

## Struktur

```
ruang-temu/
  server.py        # entrypoint: HTTP/HTTPS, CLI, ICE, TLS
  webserver.py     # static server + WebSocket signing handler + security headers
  signaling.py     # WebSocket hub + protocol + rate limit
  public/
    index.html     # markup lobby + meeting
    styles.css     # tema & komponen umum
    meeting.css    # tile, dock, panel, responsive
    js/            # app.js, ui.js, media.js, rtc.js
    manifest.webmanifest
    sw.js
    icons/         # favicon & ikon PWA
  tests/           # smoke test + end-to-end test
  tools/           # generator ikon
```

## Uji

```bash
python tests/test_smoke.py
python tests/test_e2e.py   # butuh selenium + Chrome/Edge
python tools/make_icons.py
```

## Catatan

- Video/audio: WebRTC peer-to-peer; tidak ada server yang menyimpan atau memproses konten media.
- Berbagi layar: hanya video; audio dari tab yang di-share tidak dikirim.
- Kode ruang bersifat case-sensitive setelah sanitasi; gunakan huruf besar/angka.
- Kapasitas ruang default 8 peserta per mesh.

## Kontak & pengembangan

- Edit: `public/js/*.js` (modul), `public/styles*.css`, `public/index.html`.
- Server log dan komunikasi internal tetap dalam bahasa Indonesia agar fitur UI konsisten.
