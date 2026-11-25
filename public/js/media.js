/* Manajemen kamera, mikrofon, berbagi layar, dan deteksi suara. */

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
};

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: "user",
};

const PERMISSION_ERRORS = new Set(["NotAllowedError", "PermissionDeniedError", "SecurityError"]);

const FALLBACK_AUDIO_CONSTRAINTS = {};
const FALLBACK_VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 15, max: 15 },
  facingMode: "user",
};

export class MediaManager {
  constructor({ onMediaChange, onScreenChange } = {}) {
    this.onMediaChange = onMediaChange;
    this.onScreenChange = onScreenChange;

    this.mic = null;
    this.camera = null;
    this.screen = null;
    this.silent = null;
    this.placeholder = null;

    this.micEnabled = true;
    this.cameraEnabled = true;

    this.silentContext = null;
    this.placeholderCanvas = null;
    this._stoppingAll = false;

    this.audioContext = null;
    this.meters = new Map();
    this._meterTimer = 0;
    this._speakingCallback = null;
  }

  static isLive(track) {
    return Boolean(track && track.readyState === "live");
  }

  hasMic() {
    return MediaManager.isLive(this.mic);
  }

  hasCamera() {
    return MediaManager.isLive(this.camera);
  }

  hasScreen() {
    return MediaManager.isLive(this.screen);
  }

  setMicEnabled(enabled) {
    this.micEnabled = Boolean(enabled);
    if (this.mic) this.mic.enabled = this.micEnabled;
  }

  setCameraEnabled(enabled) {
    this.cameraEnabled = Boolean(enabled);
    if (this.camera) this.camera.enabled = this.cameraEnabled;
  }

  outboundAudioTrack() {
    if (this.hasMic()) return this.mic;
    return this._ensureSilentTrack();
  }

  outboundVideoTrack() {
    if (this.hasScreen()) return this.screen;
    if (this.hasCamera()) return this.camera;
    return this._ensurePlaceholderTrack();
  }

  ensureFallbacks() {
    this._ensureSilentTrack();
    this._ensurePlaceholderTrack();
  }

  async ensure({ audio = false, video = false } = {}) {
    const result = {
      audio: this.hasMic(),
      video: this.hasCamera(),
      error: null,
    };

    const needAudio = audio && !result.audio;
    const needVideo = video && !result.video;
    if (!needAudio && !needVideo) return result;

    if (!navigator.mediaDevices?.getUserMedia) {
      const error = new TypeError("getUserMedia tidak tersedia");
      result.error = error;
      return result;
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: needAudio ? AUDIO_CONSTRAINTS : false,
        video: needVideo ? VIDEO_CONSTRAINTS : false,
      });
      this._attachStream(stream);
    } catch (error) {
      result.error = error;
      if (!PERMISSION_ERRORS.has(error?.name)) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: needAudio ? FALLBACK_AUDIO_CONSTRAINTS : false,
            video: needVideo ? FALLBACK_VIDEO_CONSTRAINTS : false,
          });
          this._attachStream(stream);
          error = null;
          result.error = null;
        } catch (fallbackError) {
          error = fallbackError;
          result.error = fallbackError;
        }
      }
      if (!stream && needAudio && needVideo) {
        // Bila satu perangkat tidak ada, coba sisanya secara terpisah agar
        // mikrofon tetap bisa dipakai saat kamera tidak tersedia (dan sebaliknya).
        const [audioResult, videoResult] = await Promise.allSettled([
          navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false }),
          navigator.mediaDevices.getUserMedia({ audio: false, video: VIDEO_CONSTRAINTS }),
        ]);
        const failures = [];
        if (audioResult.status === "fulfilled") this._attachStream(audioResult.value);
        else failures.push(audioResult.reason);
        if (videoResult.status === "fulfilled") this._attachStream(videoResult.value);
        else failures.push(videoResult.reason);
        result.error = failures.find((failure) => !PERMISSION_ERRORS.has(failure?.name)) || failures[0] || null;
      }
    }

    result.audio = this.hasMic();
    result.video = this.hasCamera();
    if (result.audio || result.video) {
      this.onMediaChange?.({ kind: "devices", error: result.error });
    } else {
      this.onMediaChange?.({ kind: "error", error: result.error });
    }
    return result;
  }

  _attachStream(stream) {
    for (const track of stream.getTracks()) {
      if (track.kind === "audio") this._attachMic(track);
      else if (track.kind === "video") this._attachCamera(track);
      else track.stop();
    }
  }

  _attachMic(track) {
    if (this.hasMic()) {
      track.stop();
      return;
    }
    this._disposeTrack(this.mic);
    this.mic = track;
    track.enabled = this.micEnabled;
    track.onended = () => {
      if (this._stoppingAll || this.mic !== track) return;
      this.mic = null;
      this.onMediaChange?.({ kind: "mic-ended" });
    };
  }

  _attachCamera(track) {
    if (this.hasCamera()) {
      track.stop();
      return;
    }
    this._disposeTrack(this.camera);
    this.camera = track;
    track.enabled = this.cameraEnabled;
    track.onended = () => {
      if (this._stoppingAll || this.camera !== track) return;
      this.camera = null;
      this.onMediaChange?.({ kind: "camera-ended" });
    };
  }

  async startScreenShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      const error = new Error("getDisplayMedia tidak didukung");
      error.name = "NotSupportedError";
      throw error;
    }
    if (this.hasScreen()) return this.screen;

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      const error = new Error("Tidak ada video dari layar");
      error.name = "NotFoundError";
      throw error;
    }
    // Hentikan track lain yang mungkin ikut dibagikan (mis. audio tab).
    stream.getTracks().forEach((item) => {
      if (item !== track) item.stop();
    });

    this._disposeTrack(this.screen);
    this.screen = track;
    track.onended = () => {
      if (this._stoppingAll || this.screen !== track) return;
      this.screen = null;
      this.onScreenChange?.(false, true);
    };
    this.onScreenChange?.(true, false);
    return track;
  }

  stopScreenShare() {
    const track = this.screen;
    if (!track) return false;
    this.screen = null;
    this._disposeTrack(track);
    this.onScreenChange?.(false, false);
    return true;
  }

  _disposeTrack(track) {
    if (!track) return;
    track.onended = null;
    try {
      track.stop();
    } catch {
      // abaikan
    }
  }

  _ensureSilentTrack() {
    if (this.silent) return this.silent;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      gain.gain.value = 0.00001;
      oscillator.type = "sine";
      oscillator.frequency.value = 220;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      this.silentContext = context;
      this.silent = destination.stream.getAudioTracks()[0] || null;
      return this.silent;
    } catch {
      return null;
    }
  }

  _ensurePlaceholderTrack() {
    if (this.placeholder) return this.placeholder;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const context = canvas.getContext("2d");
      if (context) {
        const gradient = context.createLinearGradient(0, 0, 640, 360);
        gradient.addColorStop(0, "#0b1424");
        gradient.addColorStop(1, "#070c15");
        context.fillStyle = gradient;
        context.fillRect(0, 0, 640, 360);
        context.strokeStyle = "rgba(148, 163, 184, 0.08)";
        context.lineWidth = 2;
        for (let x = 40; x < 640; x += 80) {
          context.beginPath();
          context.moveTo(x, 0);
          context.lineTo(x, 360);
          context.stroke();
        }
      }
      const stream = canvas.captureStream(1);
      const track = stream.getVideoTracks()[0] || null;
      this.placeholderCanvas = canvas;
      this.placeholder = track;
      return track;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------- deteksi suara */

  startSpeaking(callback) {
    this._speakingCallback = callback;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!this.audioContext) {
      try {
        this.audioContext = new AudioContextClass();
      } catch {
        return;
      }
    }
    this.resumeAudio();
    if (this._meterTimer) window.clearInterval(this._meterTimer);
    this._meterTimer = window.setInterval(() => this._pollMeters(), 220);
  }

  async resumeAudio() {
    if (this.audioContext?.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch {
        // abaikan; meter hanya akan diam sampai ada gestur berikutnya
      }
    }
    if (this.silentContext?.state === "suspended") {
      this.silentContext.resume().catch(() => {});
    }
  }

  setLocalMeter(track) {
    if (!track) {
      this.removeMeter("self");
      return;
    }
    this._setMeter("self", new MediaStream([track]));
  }

  setRemoteMeter(key, stream) {
    if (!stream) {
      this.removeMeter(key);
      return;
    }
    this._setMeter(key, stream);
  }

  _setMeter(key, stream) {
    if (!this.audioContext) return;
    this.removeMeter(key);
    if (!stream.getAudioTracks().length) return;
    try {
      const source = this.audioContext.createMediaStreamSource(stream);
      const analyser = this.audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(analyser);
      this.meters.set(key, {
        source,
        analyser,
        data: new Uint8Array(analyser.fftSize),
        active: false,
      });
    } catch {
      // MediaStreamAudioSourceNode bisa gagal untuk track yang sudah berakhir
    }
  }

  removeMeter(key) {
    const meter = this.meters.get(key);
    if (!meter) return;
    try {
      meter.source.disconnect();
      meter.analyser.disconnect();
    } catch {
      // abaikan
    }
    this.meters.delete(key);
    if (meter.active) this._speakingCallback?.(key, false);
  }

  _pollMeters() {
    if (!this.audioContext || this.audioContext.state !== "running") return;
    for (const [key, meter] of this.meters) {
      meter.analyser.getByteTimeDomainData(meter.data);
      let sum = 0;
      for (const value of meter.data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / meter.data.length);
      const speaking = meter.active ? rms > 0.028 : rms > 0.045;
      if (speaking !== meter.active) {
        meter.active = speaking;
        this._speakingCallback?.(key, speaking);
      }
    }
  }

  _stopMeters() {
    if (this._meterTimer) {
      window.clearInterval(this._meterTimer);
      this._meterTimer = 0;
    }
    for (const key of [...this.meters.keys()]) this.removeMeter(key);
    this._speakingCallback = null;
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  stopAll() {
    this._stoppingAll = true;
    this._stopMeters();
    this._disposeTrack(this.screen);
    this.screen = null;
    this._disposeTrack(this.camera);
    this.camera = null;
    this._disposeTrack(this.mic);
    this.mic = null;
    this._disposeTrack(this.silent);
    this.silent = null;
    this._disposeTrack(this.placeholder);
    this.placeholder = null;
    this.placeholderCanvas = null;
    if (this.silentContext) {
      this.silentContext.close().catch(() => {});
      this.silentContext = null;
    }
    this._stoppingAll = false;
  }
}
