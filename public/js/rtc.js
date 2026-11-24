/* Mesh WebRTC + signaling WebSocket untuk RuangTemu. */

const MAX_RECONNECT_ATTEMPTS = 8;

function publicPeer(peer) {
  return {
    id: peer.id,
    name: peer.name,
    muted: peer.muted,
    cameraOff: peer.cameraOff,
    screen: peer.screen,
    isHost: peer.isHost,
  };
}

export class PeerMesh {
  constructor(options) {
    this.room = options.room;
    this.name = options.name;
    this.iceServers = options.iceServers || [];
    this.getLocalState = options.getLocalState || (() => ({}));
    this.getLocalTracks = options.getLocalTracks || (() => ({ audio: null, video: null }));

    this.onWelcome = options.onWelcome;
    this.onPeerAdded = options.onPeerAdded;
    this.onPeerUpdated = options.onPeerUpdated;
    this.onPeerLeft = options.onPeerLeft;
    this.onHostChanged = options.onHostChanged;
    this.onChat = options.onChat;
    this.onStatus = options.onStatus;
    this.onError = options.onError;
    this.onRemoteStream = options.onRemoteStream;
    this.onPeerConnectionState = options.onPeerConnectionState;

    this.ws = null;
    this.selfId = null;
    this.hostId = null;
    this.maxPeers = options.maxPeers || 8;
    this.peers = new Map();

    this._manualClose = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = 0;
    this._refreshChain = Promise.resolve();
  }

  get isOnline() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getServerUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}/ws`;
  }

  connect() {
    this._manualClose = false;
    this._openSocket();
  }

  _openSocket() {
    if (this._manualClose) return;
    this.onStatus?.({
      state: this._reconnectAttempt > 0 ? "reconnecting" : "connecting",
      attempt: this._reconnectAttempt,
    });

    let ws;
    try {
      ws = new WebSocket(this.getServerUrl());
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._send({
        type: "join",
        room: this.room,
        name: this.name,
        ...this.getLocalState(),
      });
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this._handleMessage(event.data);
    };

    ws.onerror = () => {
      // onclose akan menangani rekonstruksi koneksi
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this._manualClose) return;
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this._manualClose) return;
    this._reconnectAttempt += 1;
    if (this._reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      this.onStatus?.({ state: "offline", attempt: this._reconnectAttempt, exhausted: true });
      return;
    }
    const delay = Math.min(8000, 500 * 2 ** Math.min(this._reconnectAttempt - 1, 4));
    this.onStatus?.({ state: "reconnecting", attempt: this._reconnectAttempt, delay });
    window.clearTimeout(this._reconnectTimer);
    this._reconnectTimer = window.setTimeout(() => this._openSocket(), delay);
  }

  disconnect() {
    this._manualClose = true;
    window.clearTimeout(this._reconnectTimer);
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "leave" }));
      } catch {
        // abaikan
      }
    }
    try {
      this.ws?.close(1000, "leave");
    } catch {
      // abaikan
    }
    this.ws = null;
    this._closeAllPeers();
    this.selfId = null;
    this.hostId = null;
  }

  sendChat(text) {
    return this._send({ type: "chat", text });
  }

  sendState(state) {
    return this._send({ type: "state", ...state });
  }

  getPeers() {
    return [...this.peers.values()].map(publicPeer);
  }

  _send(payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  _signal(targetId, data) {
    this._send({ type: "signal", to: targetId, data });
  }

  _handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "welcome":
        this._handleWelcome(message);
        break;
      case "peer-joined":
        if (message.peer) this._addPeer(message.peer, { initiator: true, initial: false });
        break;
      case "peer-left":
        this._removePeer(message.id, message.name);
        break;
      case "peer-state": {
        const peer = this.peers.get(message.id);
        if (!peer) break;
        peer.muted = Boolean(message.muted);
        peer.cameraOff = Boolean(message.cameraOff);
        peer.screen = Boolean(message.screen);
        this.onPeerUpdated?.(publicPeer(peer));
        break;
      }
      case "signal":
        this._handleSignal(message.from, message.data);
        break;
      case "chat":
        this.onChat?.(message);
        break;
      case "host-changed": {
        this.hostId = message.hostId || null;
        for (const peer of this.peers.values()) {
          peer.isHost = peer.id === this.hostId;
        }
        this.onHostChanged?.(this.hostId);
        break;
      }
      case "error":
        this._handleError(message);
        break;
      case "pong":
        break;
      default:
        break;
    }
  }

  _handleWelcome(message) {
    const reconnected = Boolean(this.selfId);
    this.selfId = message.self?.id || null;
    this.hostId = message.hostId || null;
    this.room = message.room || this.room;
    this.maxPeers = message.maxPeers || this.maxPeers;
    this._reconnectAttempt = 0;

    this._closeAllPeers();
    this.onStatus?.({ state: "online" });
    this.onWelcome?.({
      selfId: this.selfId,
      hostId: this.hostId,
      room: this.room,
      maxPeers: this.maxPeers,
      reconnected,
    });

    for (const peer of message.peers || []) {
      this._addPeer({ ...peer, isHost: peer.id === this.hostId }, { initiator: false, initial: true });
    }
  }

  _addPeer(info, { initiator, initial }) {
    let peer = this.peers.get(info.id);
    if (peer) {
      peer.name = info.name || peer.name;
      peer.muted = Boolean(info.muted);
      peer.cameraOff = Boolean(info.cameraOff);
      peer.screen = Boolean(info.screen);
      peer.isHost = peer.id === this.hostId;
      this.onPeerUpdated?.(publicPeer(peer));
      return;
    }

    peer = {
      id: info.id,
      name: info.name || "Peserta",
      muted: Boolean(info.muted),
      cameraOff: Boolean(info.cameraOff),
      screen: Boolean(info.screen),
      isHost: Boolean(info.isHost),
      pc: null,
      stream: new MediaStream(),
      polite: this.selfId ? this.selfId.localeCompare(info.id) > 0 : true,
      makingOffer: false,
      ignoreOffer: false,
      allowOffer: Boolean(initiator),
      pendingCandidates: [],
      queue: Promise.resolve(),
      iceRestarted: false,
      closed: false,
      audioSender: null,
      videoSender: null,
    };
    this.peers.set(peer.id, peer);
    this.onPeerAdded?.(publicPeer(peer), { initial: Boolean(initial) });
    this._createConnection(peer);
  }

  _createConnection(peer) {
    if (typeof RTCPeerConnection === "undefined") {
      this.onError?.("Browser ini tidak mendukung WebRTC. Gunakan Chrome, Edge, Firefox, atau Safari terbaru.", true);
      return;
    }

    let pc;
    try {
      pc = new RTCPeerConnection({
        iceServers: this.iceServers,
        iceCandidatePoolSize: 2,
        bundlePolicy: "max-bundle",
      });
    } catch {
      this.onError?.("Tidak bisa membuat koneksi WebRTC.", false);
      return;
    }
    peer.pc = pc;

    pc.onnegotiationneeded = () => {
      if (peer.allowOffer) this._negotiate(peer);
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      let candidate;
      try {
        candidate = event.candidate.toJSON();
      } catch {
        candidate = event.candidate;
      }
      this._signal(peer.id, { candidate });
    };

    pc.ontrack = (event) => {
      const track = event.track;
      if (!peer.stream.getTracks().includes(track)) {
        peer.stream.addTrack(track);
      }
      track.onended = () => {
        if (peer.stream.getTracks().includes(track)) {
          peer.stream.removeTrack(track);
          this.onRemoteStream?.(peer.id, peer.stream, track);
        }
      };
      this.onRemoteStream?.(peer.id, peer.stream, track);
    };

    pc.onconnectionstatechange = () => {
      if (peer.closed) return;
      const connectionState = pc.connectionState;
      this.onPeerConnectionState?.(peer.id, connectionState);
      if (connectionState === "failed" && !peer.iceRestarted) {
        peer.iceRestarted = true;
        window.setTimeout(() => {
          if (peer.closed || peer.pc !== pc || pc.connectionState !== "failed") return;
          try {
            peer.allowOffer = true;
            pc.restartIce();
            this._negotiate(peer);
          } catch {
            // tetap tampilkan status gagal di UI
          }
        }, 1200);
      }
    };

    const tracks = this.getLocalTracks();
    const audioTransceiver = tracks.audio
      ? pc.addTransceiver(tracks.audio, { direction: "sendrecv" })
      : pc.addTransceiver("audio", { direction: "sendrecv" });
    const videoTransceiver = tracks.video
      ? pc.addTransceiver(tracks.video, { direction: "sendrecv" })
      : pc.addTransceiver("video", { direction: "sendrecv" });

    peer.audioSender = audioTransceiver.sender;
    peer.videoSender = videoTransceiver.sender;
  }

  _negotiate(peer) {
    if (peer.closed || this._manualClose || !peer.allowOffer) return;
    if (peer.makingOffer) return;
    if (peer.pc.signalingState !== "stable") return;

    this._enqueue(peer, async () => {
      if (peer.closed || peer.pc.signalingState !== "stable" || !peer.allowOffer) return;
      try {
        peer.makingOffer = true;
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        this._signal(peer.id, { description: peer.pc.localDescription });
      } finally {
        peer.makingOffer = false;
      }
    });
  }

  _handleSignal(from, data) {
    const peer = this.peers.get(from);
    if (!peer || !peer.pc || !data) return;

    this._enqueue(peer, async () => {
      if (peer.closed) return;
      const pc = peer.pc;

      if (data.description) {
        const description = data.description;
        if (!description.type) return;
        const offerCollision =
          description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        if (offerCollision && pc.signalingState !== "stable") {
          try {
            await pc.setLocalDescription({ type: "rollback" });
          } catch {
            // lanjutkan; setRemoteDescription akan memberi error jika tidak valid
          }
        }

        await pc.setRemoteDescription(description);
        peer.allowOffer = true;

        for (const candidate of peer.pendingCandidates.splice(0)) {
          try {
            await pc.addIceCandidate(candidate);
          } catch {
            // kandidat basi boleh diabaikan
          }
        }

        if (description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this._signal(peer.id, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        if (peer.ignoreOffer) return;
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate);
        } catch {
          // abaikan kandidat yang tidak valid
        }
      }
    });
  }

  _enqueue(peer, task) {
    peer.queue = peer.queue
      .then(task)
      .catch((error) => {
        if (peer.closed || this._manualClose) return;
        console.warn("RuangTemu signaling:", error);
      });
  }

  async refreshSenders() {
    this._refreshChain = this._refreshChain
      .then(async () => {
        const { audio, video } = this.getLocalTracks();
        const jobs = [];
        for (const peer of this.peers.values()) {
          if (peer.closed || !peer.pc) continue;
          const emptyAudio = !peer.audioSender?.track;
          const emptyVideo = !peer.videoSender?.track;
          if (peer.audioSender) {
            jobs.push(peer.audioSender.replaceTrack(audio || null).catch(() => {}));
          }
          if (peer.videoSender) {
            jobs.push(peer.videoSender.replaceTrack(video || null).catch(() => {}));
          }
          if ((emptyAudio && audio) || (emptyVideo && video)) {
            window.setTimeout(() => this._negotiate(peer), 0);
          }
        }
        await Promise.allSettled(jobs);
      })
      .catch(() => {});
    return this._refreshChain;
  }

  _closeAllPeers() {
    for (const peer of this.peers.values()) {
      peer.closed = true;
      try {
        peer.pc?.close();
      } catch {
        // abaikan
      }
    }
    this.peers.clear();
  }

  _removePeer(id, fallbackName = "") {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.closed = true;
    try {
      peer.pc?.close();
    } catch {
      // abaikan
    }
    this.peers.delete(id);
    this.onPeerLeft?.({ id, name: peer.name || fallbackName });
  }

  _handleError(message) {
    const code = message.code || "error";
    const text = message.message || "Terjadi kesalahan pada koneksi.";
    if (code === "room-full" || code === "invalid-join") {
      this._fatal(text);
      return;
    }
    this.onError?.(text, false);
  }

  _fatal(message) {
    this._manualClose = true;
    window.clearTimeout(this._reconnectTimer);
    this.onStatus?.({ state: "offline", fatal: true });
    this.onError?.(message, true);
    try {
      this.ws?.close(4000, "fatal");
    } catch {
      // abaikan
    }
    this.ws = null;
  }
}
