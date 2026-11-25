/* RuangTemu - orkestrasi lobby, media, ruang meeting, dan PWA. */

import {
  $,
  showToast,
  initials,
  hueFor,
  formatDuration,
  formatTime,
  friendlyMediaError,
  copyText,
  storage,
  isMobileLayout,
  debounce,
} from "./ui.js";
import { MediaManager } from "./media.js";
import { PeerMesh } from "./rtc.js";

const DEFAULT_ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];
const ROOM_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,39}$/;
const DEFAULT_TITLE = "RuangTemu - Video call & berbagi layar";

const els = {
  lobbyView: $("#lobbyView"),
  lobbyVideo: $("#lobbyVideo"),
  previewEmpty: $("#previewEmpty"),
  previewEmptyText: $("#previewEmptyText"),
  enablePreviewBtn: $("#enablePreviewBtn"),
  lobbyAvatar: $("#lobbyAvatar"),
  lobbyInitials: $("#lobbyInitials"),
  lobbyMicBtn: $("#lobbyMicBtn"),
  lobbyCamBtn: $("#lobbyCamBtn"),
  previewName: $("#previewName"),
  joinForm: $("#joinForm"),
  nameInput: $("#nameInput"),
  roomInput: $("#roomInput"),
  newRoomBtn: $("#newRoomBtn"),
  formError: $("#formError"),
  joinBtn: $("#joinBtn"),
  joinBtnText: $("#joinBtnText"),
  joinSpinner: $("#joinSpinner"),
  joinArrow: $("#joinArrow"),
  year: $("#year"),

  meetingView: $("#meetingView"),
  roomPill: $("#roomPill"),
  meetingRoom: $("#meetingRoom"),
  dockRoom: $("#dockRoom"),
  connPill: $("#connPill"),
  connText: $("#connText"),
  meetingTime: $("#meetingTime"),
  inviteBtn: $("#inviteBtn"),
  reconnectBanner: $("#reconnectBanner"),
  reconnectText: $("#reconnectText"),
  reloadBtn: $("#reloadBtn"),
  mediaWarning: $("#mediaWarning"),
  mediaWarningText: $("#mediaWarningText"),
  retryMediaBtn: $("#retryMediaBtn"),

  videoGrid: $("#videoGrid"),
  aloneHint: $("#aloneHint"),
  aloneInviteBtn: $("#aloneInviteBtn"),
  panelScrim: $("#panelScrim"),
  sidePanel: $("#sidePanel"),
  tabChat: $("#tabChat"),
  tabPeople: $("#tabPeople"),
  peopleTabCount: $("#peopleTabCount"),
  panelCloseBtn: $("#panelCloseBtn"),
  chatPane: $("#chatPane"),
  chatLog: $("#chatLog"),
  chatForm: $("#chatForm"),
  chatInput: $("#chatInput"),
  peoplePane: $("#peoplePane"),
  peopleList: $("#peopleList"),
  panelInviteBtn: $("#panelInviteBtn"),

  unmuteNudge: $("#unmuteNudge"),
  unmuteAllBtn: $("#unmuteAllBtn"),
  peopleBtn: $("#peopleBtn"),
  participantCount: $("#participantCount"),
  micBtn: $("#micBtn"),
  camBtn: $("#camBtn"),
  shareBtn: $("#shareBtn"),
  chatBtn: $("#chatBtn"),
  chatUnread: $("#chatUnread"),
  leaveBtn: $("#leaveBtn"),

  inviteDialog: $("#inviteDialog"),
  inviteCode: $("#inviteCode"),
  inviteLink: $("#inviteLink"),
  copyCodeBtn: $("#copyCodeBtn"),
  copyLinkIconBtn: $("#copyLinkIconBtn"),
  copyLinkBtn: $("#copyLinkBtn"),
  shareLinkBtn: $("#shareLinkBtn"),
};

const supportsScreenShare = Boolean(
  window.isSecureContext && navigator.mediaDevices?.getDisplayMedia,
);

const state = {
  inMeeting: false,
  joining: false,
  sessionToken: 0,
  room: "",
  name: "",
  micEnabled: true,
  camEnabled: true,
  screenSharing: false,
  cameraError: "",
  mediaIssue: "",
  insecure: !window.isSecureContext,
  selfId: null,
  hostId: null,
  maxPeers: 8,
  meetingStart: 0,
  timerId: 0,
  mesh: null,
  config: null,
  chatUnread: 0,
  panelOpen: false,
  activeTab: "chat",
  previewBusy: false,
  audioBlocked: false,
  tiles: new Map(),
  reconnectNoticeShown: false,
};

let media = null;
let configPromise = null;

/* ------------------------------------------------------------- utilitas */

function sanitizeRoom(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-_]/g, "")
    .slice(0, 40);
}

function generateRoom() {
  const words = [
    "KOPI", "SENJA", "HUJAN", "PADI", "LAUT", "GUNUNG", "KOTA", "AWAN",
    "TAMAN", "MEJA", "SORE", "BIRU", "CERIA", "SINAR", "RUMPUT", "BULAN",
  ];
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = (max) => {
    if (window.crypto?.getRandomValues) {
      const buffer = new Uint32Array(1);
      window.crypto.getRandomValues(buffer);
      return buffer[0] % max;
    }
    return Math.floor(Math.random() * max);
  };
  const word = words[random(words.length)];
  const suffix = Array.from({ length: 3 }, () => alphabet[random(alphabet.length)]).join("");
  return `${word}-${suffix}`;
}

function updateUrlRoom(room) {
  try {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    if (room) url.searchParams.set("room", room);
    window.history.replaceState(null, "", url);
  } catch {
    // abaikan bila URL tidak bisa diubah
  }
}

function inviteUrl() {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("room", state.room);
  return url.toString();
}

function setFormError(message) {
  if (!message) {
    els.formError.hidden = true;
    els.formError.textContent = "";
    return;
  }
  els.formError.textContent = message;
  els.formError.hidden = false;
}

function clearFormError() {
  setFormError("");
}

function setJoinBusy(busy, label = "Gabung sekarang") {
  els.joinBtn.disabled = busy;
  els.joinBtnText.textContent = busy ? label : "Gabung sekarang";
  els.joinSpinner.hidden = !busy;
  els.joinArrow.hidden = busy;
}

function updateLobbyIdentity() {
  const name = els.nameInput.value.trim() || state.name || "Kamu";
  const label = els.nameInput.value.trim() || "Kamu";
  els.previewName.textContent = label;
  els.lobbyInitials.textContent = initials(name);
  els.lobbyInitials.style.setProperty("--hue", String(hueFor(name)));
}

function getLocalState() {
  return {
    muted: !state.micEnabled,
    cameraOff: !state.camEnabled,
    screen: state.screenSharing,
  };
}

function getLocalTracks() {
  return {
    audio: media.outboundAudioTrack(),
    video: media.outboundVideoTrack(),
  };
}

function currentPeerList() {
  if (!state.mesh) return [];
  return state.mesh.getPeers().map((peer) => ({
    ...peer,
    isHost: peer.id === state.hostId,
  }));
}

/* ---------------------------------------------------------------- start */

async function loadConfig() {
  try {
    const response = await fetch("./api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.config = {
      iceServers: Array.isArray(data.iceServers) && data.iceServers.length ? data.iceServers : DEFAULT_ICE,
      maxPeers: Number.isFinite(data.maxPeers) ? data.maxPeers : 8,
    };
    state.maxPeers = state.config.maxPeers;
  } catch {
    state.config = { iceServers: DEFAULT_ICE, maxPeers: 8 };
    state.maxPeers = 8;
  }
  return state.config;
}

function getConfig() {
  const fallback = state.config || { iceServers: DEFAULT_ICE, maxPeers: 8 };
  if (state.config) return Promise.resolve(state.config);
  return Promise.race([
    configPromise,
    new Promise((resolve) => window.setTimeout(() => resolve(fallback), 1600)),
  ]);
}

function init() {
  media = new MediaManager({
    onMediaChange: handleMediaChange,
    onScreenChange: handleScreenChange,
  });
  configPromise = loadConfig();

  state.name = storage.get("ruangtemu:name", "");
  state.micEnabled = storage.getBool("ruangtemu:mic", true);
  state.camEnabled = storage.getBool("ruangtemu:cam", true);

  const params = new URLSearchParams(window.location.search);
  const requestedRoom = sanitizeRoom(params.get("room") || "");
  state.room = requestedRoom || generateRoom();

  els.nameInput.value = state.name;
  els.roomInput.value = state.room;
  els.year.textContent = String(new Date().getFullYear());

  bindEvents();
  updateLobbyIdentity();
  updateMediaButtons();
  updatePreview();
  checkEnvironment();
  registerServiceWorker();

  if (!supportsScreenShare) els.shareBtn.hidden = true;
}

function bindEvents() {
  els.joinForm.addEventListener("submit", handleJoin);
  els.enablePreviewBtn.addEventListener("click", startPreview);
  els.newRoomBtn.addEventListener("click", () => {
    state.room = generateRoom();
    els.roomInput.value = state.room;
    clearFormError();
    els.roomInput.focus();
    showToast("Kode ruang baru dibuat. Bagikan saat kamu siap.", { type: "info", duration: 3000 });
  });

  els.nameInput.addEventListener("input", () => {
    state.name = els.nameInput.value.trim();
    updateLobbyIdentity();
    clearFormError();
  });

  els.roomInput.addEventListener("input", () => {
    const cleaned = sanitizeRoom(els.roomInput.value);
    if (els.roomInput.value !== cleaned) els.roomInput.value = cleaned;
    clearFormError();
  });

  els.lobbyMicBtn.addEventListener("click", toggleMic);
  els.lobbyCamBtn.addEventListener("click", toggleCamera);

  els.micBtn.addEventListener("click", toggleMic);
  els.camBtn.addEventListener("click", toggleCamera);
  els.shareBtn.addEventListener("click", toggleScreenShare);
  els.chatBtn.addEventListener("click", () => {
    if (state.panelOpen && state.activeTab === "chat") closePanel();
    else openPanel("chat");
  });
  els.peopleBtn.addEventListener("click", () => {
    if (state.panelOpen && state.activeTab === "people") closePanel();
    else openPanel("people");
  });
  els.leaveBtn.addEventListener("click", () => leaveMeeting());

  els.tabChat.addEventListener("click", () => setActiveTab("chat"));
  els.tabPeople.addEventListener("click", () => setActiveTab("people"));
  els.panelCloseBtn.addEventListener("click", closePanel);
  els.panelScrim.addEventListener("click", closePanel);
  els.chatForm.addEventListener("submit", sendChat);

  els.inviteBtn.addEventListener("click", openInvite);
  els.aloneInviteBtn.addEventListener("click", openInvite);
  els.panelInviteBtn.addEventListener("click", openInvite);
  els.roomPill.addEventListener("click", () => copyInviteLink(els.roomPill));
  els.copyCodeBtn.addEventListener("click", () => copyRoomCode(els.copyCodeBtn));
  els.copyLinkIconBtn.addEventListener("click", () => copyInviteLink(els.copyLinkIconBtn));
  els.copyLinkBtn.addEventListener("click", () => copyInviteLink(els.copyLinkBtn));
  els.shareLinkBtn.addEventListener("click", shareInvite);
  els.inviteLink.addEventListener("click", () => els.inviteLink.select());

  els.inviteDialog.addEventListener("click", (event) => {
    if (event.target !== els.inviteDialog) return;
    const rect = els.inviteDialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) els.inviteDialog.close();
  });

  els.unmuteAllBtn.addEventListener("click", unmuteAll);
  els.reloadBtn.addEventListener("click", () => window.location.reload());
  els.retryMediaBtn.addEventListener("click", retryMedia);

  window.addEventListener("resize", debounce(handleResize, 100));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.panelOpen && !els.inviteDialog.open) closePanel();
  });
  window.addEventListener("pagehide", (event) => {
    if (!state.inMeeting || event.persisted) return;
    state.mesh?.disconnect();
    media?.stopAll();
  });
}

function checkEnvironment() {
  if (!window.RTCPeerConnection || !window.WebSocket) {
    showToast("Browser ini tidak mendukung WebRTC. Gunakan Chrome, Edge, Firefox, atau Safari terbaru.", {
      type: "error",
      duration: 12000,
    });
    els.joinBtn.disabled = true;
    els.joinBtnText.textContent = "Browser tidak didukung";
    return;
  }
  if (state.insecure) {
    showToast(
      "Kamera dan mikrofon hanya bisa aktif lewat HTTPS atau localhost. Untuk Android, gunakan tautan HTTPS dari tunnel atau hasil deploy.",
      { type: "warning", duration: 10000 },
    );
  }
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

/* --------------------------------------------------------------- preview */

function updatePreview() {
  if (!media) return;
  const hasCamera = media.hasCamera();
  const live = hasCamera && state.camEnabled;
  const showError = Boolean(state.cameraError);
  const showEmpty = !live && (showError || state.camEnabled || state.insecure);
  const showAvatar = !live && !showEmpty;

  const track = live ? media.camera : null;
  if (track) {
    if (els.lobbyVideo.dataset.trackId !== track.id) {
      els.lobbyVideo.srcObject = new MediaStream([track]);
      els.lobbyVideo.dataset.trackId = track.id;
      els.lobbyVideo.play().catch(() => {});
    }
  } else if (els.lobbyVideo.srcObject) {
    els.lobbyVideo.srcObject = null;
    delete els.lobbyVideo.dataset.trackId;
  }
  els.lobbyVideo.hidden = !live;

  els.previewEmpty.hidden = !showEmpty;
  els.lobbyAvatar.hidden = !showAvatar;

  if (showEmpty) {
    if (state.insecure) {
      els.previewEmptyText.textContent = "Kamera membutuhkan HTTPS atau localhost";
      els.enablePreviewBtn.textContent = "Info keamanan";
    } else if (showError) {
      els.previewEmptyText.textContent = state.cameraError;
      els.enablePreviewBtn.textContent = "Coba lagi";
    } else {
      els.previewEmptyText.textContent = "Aktifkan kamera untuk melihat pratinjau";
      els.enablePreviewBtn.textContent = "Nyalakan kamera";
    }
    els.enablePreviewBtn.disabled = state.previewBusy;
  }

  updateLobbyIdentity();
}

async function startPreview() {
  if (state.previewBusy || state.inMeeting) return;
  if (state.insecure) {
    showToast("Buka RuangTemu lewat HTTPS atau localhost agar browser mengizinkan kamera.", {
      type: "warning",
      duration: 7000,
    });
    return;
  }
  state.previewBusy = true;
  state.cameraError = "";
  state.camEnabled = true;
  media.setCameraEnabled(true);
  media.setMicEnabled(state.micEnabled);
  updateMediaButtons();
  updatePreview();
  try {
    const result = await media.ensure({ audio: state.micEnabled, video: true });
    if (!result.audio && state.micEnabled) {
      state.micEnabled = false;
      media.setMicEnabled(false);
    }
    if (!result.video) {
      state.camEnabled = false;
      media.setCameraEnabled(false);
      state.cameraError = friendlyMediaError(result.error);
      showToast(state.cameraError, { type: "error" });
    } else {
      state.cameraError = "";
    }
    if (result.audio || result.video) {
      state.mediaIssue = "";
      media.resumeAudio();
    }
    storage.set("ruangtemu:mic", state.micEnabled);
    storage.set("ruangtemu:cam", state.camEnabled);
  } finally {
    state.previewBusy = false;
    updateMediaButtons();
    updatePreview();
    updateMediaWarning();
  }
}

/* --------------------------------------------------------------- media UI */

function updateMediaButtons() {
  const micOn = Boolean(state.micEnabled);
  const camOn = Boolean(state.camEnabled);

  for (const button of [els.lobbyMicBtn, els.micBtn]) {
    button.setAttribute("aria-pressed", String(micOn));
    button.setAttribute("aria-label", micOn ? "Matikan mikrofon" : "Nyalakan mikrofon");
  }
  for (const button of [els.lobbyCamBtn, els.camBtn]) {
    button.setAttribute("aria-pressed", String(camOn));
    button.setAttribute("aria-label", camOn ? "Matikan kamera" : "Nyalakan kamera");
  }
  els.lobbyMicBtn.title = micOn ? "Mikrofon aktif" : "Mikrofon mati";
  els.lobbyCamBtn.title = camOn ? "Kamera aktif" : "Kamera mati";
  els.micBtn.dataset.on = String(micOn);
  els.camBtn.dataset.on = String(camOn);

  els.shareBtn.classList.toggle("is-active", state.screenSharing);
  els.shareBtn.setAttribute("aria-pressed", String(state.screenSharing));
  els.shareBtn.setAttribute("aria-label", state.screenSharing ? "Hentikan berbagi layar" : "Bagikan layar");
  const shareLabel = els.shareBtn.querySelector(".dock-label");
  if (shareLabel) shareLabel.textContent = state.screenSharing ? "Hentikan" : "Layar";

  const chatPanelOpen = state.panelOpen && state.activeTab === "chat";
  els.chatBtn.classList.toggle("is-active", chatPanelOpen);
  els.chatBtn.setAttribute("aria-pressed", String(chatPanelOpen));
  els.peopleBtn.classList.toggle("is-active", state.panelOpen && state.activeTab === "people");
}

function updateMediaWarning() {
  if (!state.inMeeting) {
    els.mediaWarning.hidden = true;
    return;
  }
  const hasAnyMedia = media.hasCamera() || media.hasMic();
  if (state.mediaIssue && !hasAnyMedia) {
    els.mediaWarningText.textContent = state.mediaIssue;
    els.mediaWarning.hidden = false;
  } else {
    els.mediaWarning.hidden = true;
  }
}

async function toggleMic() {
  if (state.joining && state.inMeeting) return;
  const next = !state.micEnabled;

  if (next && !media.hasMic()) {
    if (state.insecure) {
      showToast("Mikrofon membutuhkan HTTPS atau localhost.", { type: "warning" });
      return;
    }
    const result = await media.ensure({ audio: true, video: false });
    if (!result.audio) {
      showToast(friendlyMediaError(result.error), { type: "error" });
      return;
    }
    state.mediaIssue = "";
    media.resumeAudio();
  }

  state.micEnabled = next;
  media.setMicEnabled(next);
  storage.set("ruangtemu:mic", next);
  if (!next) setTileSpeaking("self", false);

  updateMediaButtons();
  updatePreview();
  updateSelfTile();
  renderPeople();
  updateMediaWarning();
  broadcastState();
}

async function toggleCamera() {
  if (state.joining && state.inMeeting) return;
  const next = !state.camEnabled;

  if (next) {
    if (!media.hasCamera()) {
      if (state.insecure) {
        showToast("Kamera membutuhkan HTTPS atau localhost.", { type: "warning" });
        return;
      }
      const result = await media.ensure({ audio: false, video: true });
      if (!result.video) {
        state.camEnabled = false;
        state.cameraError = friendlyMediaError(result.error);
        media.setCameraEnabled(false);
        showToast(state.cameraError, { type: "error" });
        updateMediaButtons();
        updatePreview();
        updateMediaWarning();
        broadcastState();
        return;
      }
      state.cameraError = "";
      state.mediaIssue = "";
      media.resumeAudio();
    }
    state.camEnabled = true;
    media.setCameraEnabled(true);
  } else {
    state.camEnabled = false;
    media.setCameraEnabled(false);
  }

  storage.set("ruangtemu:cam", state.camEnabled);
  updateMediaButtons();
  updatePreview();
  updateSelfTile();
  renderPeople();
  updateMediaWarning();
  broadcastState();
  state.mesh?.refreshSenders();
}

function handleMediaChange(event) {
  if (!media) return;

  if (event?.kind === "mic-ended") {
    state.micEnabled = false;
    media.setMicEnabled(false);
    showToast("Mikrofon terputus. Kamu bisa menyalakannya lagi lewat tombol mikrofon.", { type: "warning" });
  } else if (event?.kind === "camera-ended") {
    state.camEnabled = false;
    media.setCameraEnabled(false);
    state.cameraError = "Kamera terputus dari perangkat.";
    showToast("Kamera terputus. Kamu bisa mencoba menyalakannya lagi.", { type: "warning" });
  }

  if (media.hasCamera()) state.cameraError = "";
  if (media.hasCamera() || media.hasMic()) state.mediaIssue = "";
  if (event?.kind === "error" && !media.hasCamera() && !media.hasMic()) {
    state.mediaIssue = friendlyMediaError(event.error);
  }

  updateMediaButtons();
  updatePreview();
  updateMediaWarning();
  updateSelfTile();
  renderPeople();

  if (state.inMeeting) {
    media.setLocalMeter(state.micEnabled ? media.mic : null);
    state.mesh?.refreshSenders();
    broadcastState();
  }
}

function handleScreenChange(active, fromBrowser) {
  state.screenSharing = Boolean(active);
  updateMediaButtons();
  updateSelfTile();
  renderPeople();

  if (!state.inMeeting) return;
  state.mesh?.refreshSenders();
  broadcastState();

  if (active) {
    addSystemMessage("Kamu mulai berbagi layar.");
    showToast("Layar kamu sedang dibagikan ke ruang ini.", { type: "success" });
  } else {
    addSystemMessage("Kamu berhenti berbagi layar.");
    if (fromBrowser) showToast("Berbagi layar berakhir.", { type: "info" });
  }
}

async function toggleScreenShare() {
  if (!supportsScreenShare) {
    showToast("Berbagi layar hanya tersedia di browser desktop dengan HTTPS/localhost.", {
      type: "warning",
    });
    return;
  }
  if (state.screenSharing) {
    media.stopScreenShare();
    return;
  }
  try {
    await media.startScreenShare();
  } catch (error) {
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
      showToast("Berbagi layar dibatalkan.", { type: "info", duration: 2500 });
    } else {
      showToast("Tidak bisa memulai berbagi layar. Pastikan browser mendukung dan kamu memberi izin.", {
        type: "error",
      });
    }
  }
}

async function retryMedia() {
  if (state.insecure) {
    showToast("Buka lewat HTTPS atau localhost agar kamera bisa diakses.", { type: "warning" });
    return;
  }
  els.retryMediaBtn.disabled = true;
  try {
    state.micEnabled = true;
    state.camEnabled = true;
    media.setMicEnabled(true);
    media.setCameraEnabled(true);
    const result = await media.ensure({ audio: true, video: true });
    if (!result.audio) state.micEnabled = false;
    if (!result.video) {
      state.camEnabled = false;
      state.cameraError = friendlyMediaError(result.error);
    }
    media.setMicEnabled(state.micEnabled);
    media.setCameraEnabled(state.camEnabled);

    if (result.audio && result.video) {
      state.mediaIssue = "";
      state.cameraError = "";
      showToast("Kamera dan mikrofon aktif.", { type: "success" });
    } else if (result.audio || result.video) {
      state.mediaIssue = "";
      showToast(friendlyMediaError(result.error), { type: "warning" });
    } else {
      state.mediaIssue = friendlyMediaError(result.error);
      showToast(state.mediaIssue, { type: "error" });
    }

    updateMediaButtons();
    updatePreview();
    updateMediaWarning();
    updateSelfTile();
    renderPeople();
    media.setLocalMeter(state.micEnabled ? media.mic : null);
    state.mesh?.refreshSenders();
    broadcastState();
  } finally {
    els.retryMediaBtn.disabled = false;
  }
}

/* --------------------------------------------------------------- masuk */

function handleJoin(event) {
  event.preventDefault();
  if (state.joining) return;
  if (!window.RTCPeerConnection || !window.WebSocket) {
    setFormError("Browser ini tidak mendukung WebRTC. Gunakan Chrome, Edge, Firefox, atau Safari terbaru.");
    return;
  }

  const name = els.nameInput.value.trim();
  const room = sanitizeRoom(els.roomInput.value);
  if (!name) {
    setFormError("Isi nama kamu dulu, ya.");
    els.nameInput.focus();
    return;
  }
  if (!ROOM_PATTERN.test(room)) {
    setFormError("Kode ruang minimal 3 karakter. Gunakan huruf, angka, tanda hubung, atau garis bawah.");
    els.roomInput.focus();
    return;
  }

  state.name = name.slice(0, 40);
  state.room = room;
  els.nameInput.value = state.name;
  els.roomInput.value = room;
  storage.set("ruangtemu:name", state.name);
  clearFormError();
  state.joining = true;
  state.cameraError = "";
  setJoinBusy(true, "Menyiapkan...");

  (async () => {
    try {
      await getConfig();

      if (!state.insecure) {
        const wantAudio = state.micEnabled;
        const wantVideo = state.camEnabled;
        if (wantAudio || wantVideo) {
          const result = await media.ensure({ audio: wantAudio, video: wantVideo });
          if (wantAudio && !result.audio) state.micEnabled = false;
          if (wantVideo && !result.video) {
            state.camEnabled = false;
            state.cameraError = friendlyMediaError(result.error);
          }
          if (result.audio || result.video) {
            state.mediaIssue = "";
            state.cameraError = "";
            media.resumeAudio();
          } else if (result.error) {
            state.mediaIssue = friendlyMediaError(result.error);
          }
        }
      } else {
        state.micEnabled = false;
        state.camEnabled = false;
        state.mediaIssue = "Kamera dan mikrofon memerlukan HTTPS atau localhost.";
      }

      media.setMicEnabled(state.micEnabled);
      media.setCameraEnabled(state.camEnabled);
      media.ensureFallbacks();
      media.setLocalMeter(state.micEnabled ? media.mic : null);
      storage.set("ruangtemu:mic", state.micEnabled);
      storage.set("ruangtemu:cam", state.camEnabled);
      updateUrlRoom(state.room);
      state.joining = false;
      enterMeeting();
    } catch (error) {
      console.warn("RuangTemu join:", error);
      if (state.inMeeting) leaveMeeting({ silent: true });
      state.joining = false;
      setJoinBusy(false);
      setFormError("Tidak bisa menyiapkan ruang. Coba lagi.");
      showToast("Gagal menyiapkan kamera atau koneksi. Coba lagi.", { type: "error" });
    } finally {
      state.joining = false;
      setJoinBusy(false);
    }
  })();
}

function enterMeeting() {
  state.inMeeting = true;
  state.meetingStart = Date.now();
  state.selfId = null;
  state.hostId = null;
  state.chatUnread = 0;
  state.panelOpen = false;
  state.activeTab = "chat";
  state.audioBlocked = false;
  state.tiles.clear();
  if (state.timerId) window.clearInterval(state.timerId);
  state.timerId = window.setInterval(updateTimer, 1000);

  els.lobbyView.hidden = true;
  els.meetingView.hidden = false;
  els.videoGrid.replaceChildren();
  els.chatLog.replaceChildren();
  els.chatInput.value = "";
  els.sidePanel.hidden = true;
  els.panelScrim.hidden = true;
  els.unmuteNudge.hidden = true;
  els.mediaWarning.hidden = true;
  els.reconnectBanner.hidden = true;
  els.reconnectBanner.removeAttribute("data-state");
  els.reloadBtn.hidden = true;
  els.inviteDialog.close?.();

  els.meetingRoom.textContent = state.room;
  els.dockRoom.textContent = state.room;
  els.inviteCode.textContent = state.room;
  els.inviteLink.value = inviteUrl();
  els.meetingTime.textContent = "00:00";

  updateConnectionStatus("connecting");
  setActiveTab("chat");
  createSelfTile();
  updateSelfTile();
  renderPeople();
  updateAloneHint();
  layoutGrid();
  renderChatEmpty();
  updateChatBadge();
  updateMediaButtons();
  updateMediaWarning();

  media.startSpeaking(handleSpeaking);
  media.setLocalMeter(state.micEnabled ? media.mic : null);
  startMesh();
  window.scrollTo(0, 0);
}

function startMesh() {
  const mesh = new PeerMesh({
    room: state.room,
    name: state.name,
    iceServers: state.config?.iceServers || DEFAULT_ICE,
    maxPeers: state.config?.maxPeers || state.maxPeers,
    getLocalState,
    getLocalTracks,
    onWelcome: handleWelcome,
    onPeerAdded: handlePeerAdded,
    onPeerUpdated: handlePeerUpdated,
    onPeerLeft: handlePeerLeft,
    onHostChanged: handleHostChanged,
    onChat: handleChat,
    onStatus: handleMeshStatus,
    onError: handleMeshError,
    onRemoteStream: handleRemoteStream,
    onPeerConnectionState: handlePeerConnectionState,
  });
  state.mesh = mesh;
  mesh.connect();
}

/* ------------------------------------------------------------- signaling */

function handleWelcome({ selfId, hostId, room, maxPeers, reconnected }) {
  state.selfId = selfId;
  state.hostId = hostId;
  if (Number.isFinite(maxPeers) && maxPeers > 0) state.maxPeers = maxPeers;
  if (room && room !== state.room) {
    state.room = room;
    els.meetingRoom.textContent = room;
    els.dockRoom.textContent = room;
    els.inviteCode.textContent = room;
    els.inviteLink.value = inviteUrl();
  }

  // Saat menyambung ulang, peserta lama dibangun kembali dari daftar welcome.
  for (const [id, tile] of [...state.tiles]) {
    if (id === "self") continue;
    media?.removeMeter(id);
    tile.el.remove();
    state.tiles.delete(id);
  }

  els.reconnectBanner.hidden = true;
  els.reloadBtn.hidden = true;
  els.reconnectBanner.removeAttribute("data-state");
  updateConnectionStatus("online");

  updateSelfTile();
  renderPeople();
  updateAloneHint();
  layoutGrid();
  updateChatBadge();

  if (media) {
    media.setLocalMeter(state.micEnabled ? media.mic : null);
    media.resumeAudio();
  }
  state.mesh?.refreshSenders();
  broadcastState();

  if (reconnected) {
    addSystemMessage("Kamu tersambung kembali ke ruang.");
    showToast("Tersambung kembali ke ruang.", { type: "success", duration: 3200 });
  }
}

function handleMeshStatus({ state: status, attempt, exhausted, fatal } = {}) {
  if (status === "online") {
    updateConnectionStatus("online");
    els.reconnectBanner.hidden = true;
    return;
  }
  if (status === "connecting") {
    updateConnectionStatus("connecting");
    return;
  }
  if (status === "reconnecting") {
    updateConnectionStatus("connecting");
    if (state.inMeeting && state.selfId) {
      els.reconnectBanner.hidden = false;
      els.reconnectBanner.removeAttribute("data-state");
      els.reconnectText.textContent = attempt
        ? `Menyambung ulang... (percobaan ${attempt})`
        : "Menyambung ulang...";
      els.reloadBtn.hidden = true;
    }
    return;
  }
  if (status === "offline") {
    updateConnectionStatus("offline");
    if (!state.inMeeting) return;
    els.reconnectBanner.hidden = false;
    els.reconnectBanner.dataset.state = "error";
    els.reconnectText.textContent = fatal
      ? "Tidak bisa masuk ke ruang ini."
      : exhausted
        ? "Koneksi terputus. Periksa jaringan lalu muat ulang."
        : "Koneksi terputus.";
    els.reloadBtn.hidden = false;
  }
}

function handleMeshError(message, fatal) {
  if (fatal) {
    if (state.inMeeting) leaveMeeting({ silent: true });
    state.joining = false;
    setJoinBusy(false);
    setFormError(message || "Tidak bisa bergabung ke ruang.");
    showToast(message || "Tidak bisa bergabung ke ruang.", { type: "error", duration: 10000 });
    return;
  }
  showToast(message || "Terjadi masalah pada koneksi ruang.", { type: "warning" });
}

function updateConnectionStatus(kind, text) {
  els.connPill.dataset.state = kind;
  if (text) {
    els.connText.textContent = text;
    return;
  }
  els.connText.textContent =
    kind === "online" ? "Terhubung" : kind === "offline" ? "Terputus" : "Menghubungkan";
}

function handlePeerAdded(info, meta = {}) {
  const tile = ensurePeerTile(info);
  updateTileInfo(tile, info, false);
  renderPeople();
  updateAloneHint();
  layoutGrid();
  if (!meta.initial) addSystemMessage(`${info.name || "Seseorang"} bergabung ke ruang.`);
}

function handlePeerUpdated(info) {
  let tile = state.tiles.get(info.id);
  if (!tile) tile = ensurePeerTile(info);
  const wasScreen = Boolean(tile.screen);
  updateTileInfo(tile, info, false);
  if (wasScreen !== Boolean(info.screen)) {
    addSystemMessage(
      info.screen
        ? `${info.name || "Peserta"} mulai berbagi layar.`
        : `${info.name || "Peserta"} berhenti berbagi layar.`,
    );
    layoutGrid();
  }
  renderPeople();
}

function handlePeerLeft({ id, name } = {}) {
  const tile = state.tiles.get(id);
  const displayName = name || tile?.name || "Peserta";
  if (tile) {
    tile.el.remove();
    state.tiles.delete(id);
  }
  media?.removeMeter(id);
  renderPeople();
  updateAloneHint();
  layoutGrid();
  addSystemMessage(`${displayName} keluar dari ruang.`);
}

function handleHostChanged(hostId) {
  state.hostId = hostId || null;
  updateSelfTile();
  for (const peer of currentPeerList()) {
    const tile = state.tiles.get(peer.id);
    if (tile) updateTileInfo(tile, peer, false);
  }
  renderPeople();
}

function handleChat(message) {
  if (!state.inMeeting || !message || typeof message.text !== "string") return;
  const isSelf = message.from === state.selfId;
  const text = message.text.slice(0, 2000);
  if (!text) return;
  addChatMessage({
    name: message.name || "Peserta",
    text,
    at: message.at,
    isSelf,
  });
  if (!isSelf && (!state.panelOpen || state.activeTab !== "chat")) {
    state.chatUnread += 1;
    updateChatBadge();
  }
}

function handleRemoteStream(id, stream) {
  if (!state.inMeeting) return;
  const info = state.mesh?.getPeers().find((peer) => peer.id === id) || { id, name: "Peserta" };
  const tile = ensurePeerTile(info);
  if (tile.video.srcObject !== stream) {
    tile.video.srcObject = stream;
    if (state.audioBlocked) tile.video.muted = true;
  }
  const audioTrack = stream.getAudioTracks()[0];
  if (audioTrack) {
    const audioStream = new MediaStream([audioTrack]);
    if (tile.audio.srcObject !== audioStream) {
      tile.audio.srcObject = audioStream;
      tryPlayRemoteAudio(tile);
    }
  } else if (tile.audio.srcObject) {
    tile.audio.srcObject = null;
  }
  if (stream.getTracks().length) tile.statusEl.hidden = true;
  tryPlayRemoteVideo(tile);
  media?.setRemoteMeter(id, stream);
}

function handlePeerConnectionState(id, connectionState) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  if (connectionState === "connected") {
    tile.statusEl.hidden = true;
    tryPlayRemoteVideo(tile);
  } else if (connectionState === "failed") {
    setTileStatus(tile, "Koneksi gagal", "failed");
  } else if (connectionState === "disconnected") {
    setTileStatus(tile, "Menyambung ulang...", "connecting");
  } else if (connectionState === "connecting" || connectionState === "new") {
    setTileStatus(tile, "Menghubungkan...", "connecting");
  }
}

function handleSpeaking(id, speaking) {
  setTileSpeaking(id, speaking);
}

/* --------------------------------------------------------------- tiles */

function buildTile(id, info, isSelf) {
  const name = info.name || (isSelf ? state.name : "Peserta");
  const el = document.createElement("article");
  el.className = `video-tile${isSelf ? " is-self" : ""}`;
  el.dataset.peerId = id;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  if (isSelf) {
    video.muted = true;
    video.setAttribute("aria-label", "Pratinjau video kamu");
  } else {
    video.setAttribute("aria-label", `Video ${name}`);
  }

  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.playsInline = true;
  audio.setAttribute("playsinline", "");
  audio.style.position = "absolute";
  audio.style.width = "0";
  audio.style.height = "0";
  audio.style.opacity = "0";
  audio.style.pointerEvents = "none";

  const avatar = document.createElement("div");
  avatar.className = "tile-avatar";
  const initial = document.createElement("span");
  initial.className = "initial-circle";
  initial.textContent = initials(name);
  initial.style.setProperty("--hue", String(hueFor(name)));
  const hint = document.createElement("span");
  hint.className = "avatar-hint";
  hint.textContent = "Kamera mati";
  avatar.append(initial, hint);

  const topline = document.createElement("div");
  topline.className = "tile-topline";
  const statusEl = document.createElement("span");
  statusEl.className = "tile-status";
  statusEl.dataset.status = "connecting";
  const statusSpinner = document.createElement("span");
  statusSpinner.className = "spinner";
  statusSpinner.setAttribute("aria-hidden", "true");
  statusEl.append(statusSpinner, document.createTextNode("Menghubungkan..."));
  const screenBadge = document.createElement("span");
  screenBadge.className = "tile-screen-badge";
  screenBadge.append(makeIcon("screen"), document.createTextNode("Layar"));
  topline.append(statusEl, screenBadge);

  const bottom = document.createElement("div");
  bottom.className = "tile-bottom";
  const nameEl = document.createElement("span");
  nameEl.className = "tile-name";
  nameEl.textContent = name;
  const tagSelf = document.createElement("span");
  tagSelf.className = "tile-tag";
  tagSelf.textContent = "Kamu";
  tagSelf.hidden = !isSelf;
  const tagHost = document.createElement("span");
  tagHost.className = "tile-tag host";
  tagHost.textContent = "Host";
  tagHost.hidden = true;
  const micEl = document.createElement("span");
  micEl.className = "tile-mic";
  micEl.title = "Mikrofon mati";
  micEl.append(makeIcon("mic-off"));
  bottom.append(nameEl, tagSelf, tagHost, micEl);

  el.append(video, audio, avatar, topline, bottom);

  const tile = {
    id,
    name,
    el,
    video,
    audio,
    initial,
    hint,
    nameEl,
    tagSelf,
    tagHost,
    statusEl,
    micEl,
    isSelf,
    screen: false,
  };
  updateTileInfo(tile, info, isSelf);
  return tile;
}

function updateTileInfo(tile, info, isSelf) {
  const name = (isSelf ? state.name : info.name) || "Peserta";
  const screen = Boolean(info.screen);
  const cameraOff = Boolean(info.cameraOff);

  tile.name = name;
  tile.nameEl.textContent = name;
  tile.initial.textContent = initials(name);
  tile.initial.style.setProperty("--hue", String(hueFor(name)));
  tile.hint.textContent = screen ? "Layar dibagikan" : "Kamera mati";
  tile.tagSelf.hidden = !isSelf;
  tile.tagHost.hidden = !info.isHost;
  tile.video.setAttribute("aria-label", isSelf ? "Pratinjau video kamu" : `Video ${name}`);

  tile.el.classList.toggle("is-muted", Boolean(info.muted));
  tile.el.classList.toggle("is-screen", screen);
  tile.el.classList.toggle("show-avatar", !screen && cameraOff);
  tile.screen = screen;
}

function setTileStatus(tile, label, status) {
  tile.statusEl.hidden = false;
  tile.statusEl.dataset.status = status;
  tile.statusEl.replaceChildren();
  if (status === "connecting") {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    tile.statusEl.append(spinner);
  }
  tile.statusEl.append(document.createTextNode(label));
}

function createSelfTile() {
  const tile = buildTile(
    "self",
    {
      id: "self",
      name: state.name,
      muted: !state.micEnabled,
      cameraOff: !state.camEnabled,
      screen: false,
      isHost: false,
    },
    true,
  );
  state.tiles.set("self", tile);
  els.videoGrid.append(tile.el);
  return tile;
}

function ensurePeerTile(info) {
  const existing = state.tiles.get(info.id);
  if (existing) return existing;
  const tile = buildTile(info.id, info, false);
  state.tiles.set(info.id, tile);
  els.videoGrid.append(tile.el);
  return tile;
}

function updateSelfTile() {
  const tile = state.tiles.get("self");
  if (!tile || !media) return;

  const screen = Boolean(state.screenSharing && media.hasScreen());
  const cameraOn = Boolean(state.camEnabled && media.hasCamera());
  updateTileInfo(
    tile,
    {
      id: "self",
      name: state.name,
      muted: !state.micEnabled,
      cameraOff: !cameraOn,
      screen,
      isHost: Boolean(state.selfId && state.selfId === state.hostId),
    },
    true,
  );
  tile.statusEl.hidden = true;

  const track = screen ? media.screen : cameraOn ? media.camera : null;
  if (track) {
    if (tile.video.dataset.trackId !== track.id) {
      tile.video.srcObject = new MediaStream([track]);
      tile.video.dataset.trackId = track.id;
      tile.el.classList.remove("show-avatar");
    }
    tile.video.play().catch(() => {});
  } else if (tile.video.srcObject) {
    tile.video.srcObject = null;
    delete tile.video.dataset.trackId;
  }

  layoutGrid();
}

function setTileSpeaking(id, speaking) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  tile.el.classList.toggle("is-speaking", Boolean(speaking));
}

function layoutGrid() {
  const tiles = [...state.tiles.values()];
  const count = Math.max(1, tiles.length);
  const screenCount = tiles.filter((tile) => tile.screen).length;
  const screenMode = screenCount === 1;

  els.videoGrid.dataset.count = String(count);
  els.videoGrid.dataset.screen = String(screenMode);

  let columns;
  if (screenMode) {
    const thumbnailCount = Math.max(1, count - screenCount);
    const maxThumbnailColumns = window.innerWidth <= 640 ? 3 : 6;
    columns = Math.min(thumbnailCount, maxThumbnailColumns);
  } else {
    columns = gridColumns(count);
  }
  els.videoGrid.style.setProperty("--grid-cols", String(columns));
  updateAloneHint();
}

function gridColumns(count) {
  const width = window.innerWidth;
  const portrait = window.innerHeight >= width;
  if (count <= 1) return 1;
  if (count === 2) return width <= 760 && portrait ? 1 : 2;
  if (count <= 4) return 2;
  if (count <= 6) return width <= 900 ? 2 : 3;
  if (count <= 9) return 3;
  return 4;
}

function updateAloneHint() {
  const others = currentPeerList().length;
  els.aloneHint.hidden = !state.inMeeting || others > 0;
  els.aloneHint.classList.toggle("has-peers", others > 0);
}

/* ------------------------------------------------------------- peserta */

function renderPeople() {
  const peers = currentPeerList();
  const total = peers.length + 1;
  els.participantCount.textContent = String(total);
  els.peopleTabCount.textContent = String(total);
  els.peopleBtn.title = `${total} peserta di ruang (maksimal ${state.maxPeers})`;

  const list = els.peopleList;
  list.replaceChildren();
  list.append(
    makePersonRow(
      {
        name: state.name || "Kamu",
        muted: !state.micEnabled,
        cameraOff: !state.camEnabled,
        screen: state.screenSharing,
        isHost: Boolean(state.selfId && state.selfId === state.hostId),
      },
      true,
    ),
  );
  for (const peer of peers) list.append(makePersonRow(peer, false));
}

function makePersonRow(peer, isSelf) {
  const row = document.createElement("div");
  row.className = `person-row${isSelf ? " is-self" : ""}`;

  const avatar = document.createElement("span");
  avatar.className = "person-avatar";
  avatar.textContent = initials(peer.name || "Peserta");
  avatar.style.setProperty("--hue", String(hueFor(peer.name || "Peserta")));

  const info = document.createElement("div");
  info.className = "person-info";
  const name = document.createElement("span");
  name.className = "person-name";
  name.append(document.createTextNode(peer.name || "Peserta"));
  if (peer.isHost) {
    const badge = document.createElement("span");
    badge.className = "person-badge host";
    badge.textContent = "Host";
    name.append(badge);
  }
  if (isSelf) {
    const badge = document.createElement("span");
    badge.className = "person-badge";
    badge.textContent = "Kamu";
    name.append(badge);
  }
  const sub = document.createElement("span");
  sub.className = "person-sub";
  sub.textContent = describeParticipant(peer, isSelf);
  info.append(name, sub);

  const icons = document.createElement("span");
  icons.className = "person-icons";
  if (peer.muted) {
    const icon = makeIcon("mic-off");
    icon.classList.add("is-muted");
    icons.append(icon);
  }
  if (peer.cameraOff) icons.append(makeIcon("video-off"));
  if (peer.screen) {
    const icon = makeIcon("screen");
    icon.classList.add("is-sharing");
    icons.append(icon);
  }

  row.append(avatar, info, icons);
  return row;
}

function describeParticipant(peer, isSelf) {
  const parts = [isSelf ? "Kamu" : "Peserta"];
  if (peer.muted) parts.push("mikrofon mati");
  if (peer.cameraOff) parts.push("kamera mati");
  if (peer.screen) parts.push("berbagi layar");
  if (parts.length === 1) parts.push("terhubung");
  return parts.join(" · ");
}

/* ---------------------------------------------------------------- chat */

function renderChatEmpty() {
  if (els.chatLog.children.length) return;
  const empty = document.createElement("div");
  empty.className = "chat-empty";
  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.append(makeIcon("chat"));
  const title = document.createElement("strong");
  title.textContent = "Belum ada pesan";
  const caption = document.createElement("span");
  caption.textContent = "Sapa peserta lain atau kirim tautan penting di sini.";
  empty.append(icon, title, caption);
  els.chatLog.append(empty);
}

function addChatMessage({ name, text, at, isSelf }) {
  els.chatLog.querySelector(".chat-empty")?.remove();
  const nearBottom = isNearChatBottom();
  const message = document.createElement("div");
  message.className = `chat-msg${isSelf ? " is-self" : ""}`;

  if (!isSelf) {
    const avatar = document.createElement("span");
    avatar.className = "chat-avatar";
    avatar.textContent = initials(name);
    avatar.style.setProperty("--hue", String(hueFor(name)));
    message.append(avatar);
  }

  const body = document.createElement("div");
  body.className = "chat-msg-body";
  const meta = document.createElement("div");
  meta.className = "chat-meta";
  const author = document.createElement("span");
  author.className = "chat-author";
  author.textContent = isSelf ? "Kamu" : name;
  const time = document.createElement("span");
  time.className = "chat-time";
  time.textContent = formatTime(at || Date.now());
  meta.append(author, time);
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  body.append(meta, bubble);
  message.append(body);
  els.chatLog.append(message);

  if (isSelf || nearBottom) scrollChatToBottom();
}

function addSystemMessage(text) {
  if (!state.inMeeting || !text) return;
  els.chatLog.querySelector(".chat-empty")?.remove();
  const nearBottom = isNearChatBottom();
  const line = document.createElement("div");
  line.className = "chat-system";
  line.textContent = text;
  els.chatLog.append(line);
  if (nearBottom) scrollChatToBottom();
}

function isNearChatBottom() {
  const log = els.chatLog;
  return log.scrollHeight - log.scrollTop - log.clientHeight < 90;
}

function scrollChatToBottom() {
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function updateChatBadge() {
  const count = state.chatUnread;
  els.chatUnread.hidden = count === 0;
  els.chatUnread.textContent = count > 9 ? "9+" : String(count);
  document.title = count
    ? `(${count}) RuangTemu`
    : state.inMeeting
      ? `Ruang ${state.room} - RuangTemu`
      : DEFAULT_TITLE;
}

function sendChat(event) {
  event.preventDefault();
  if (!state.inMeeting || !state.mesh) return;
  const text = els.chatInput.value.trim();
  if (!text) return;
  if (!state.mesh.sendChat(text)) {
    showToast("Pesan belum terkirim. Koneksi sedang bermasalah.", { type: "warning" });
    return;
  }
  els.chatInput.value = "";
  els.chatInput.focus();
}

function openPanel(tab = "chat") {
  if (!state.inMeeting) return;
  state.panelOpen = true;
  els.sidePanel.hidden = false;
  els.panelScrim.hidden = !isMobileLayout();
  setActiveTab(tab);
  window.requestAnimationFrame(() => {
    layoutGrid();
    if (tab === "chat" && !isMobileLayout()) els.chatInput.focus();
  });
}

function closePanel() {
  state.panelOpen = false;
  els.sidePanel.hidden = true;
  els.panelScrim.hidden = true;
  updateMediaButtons();
  window.requestAnimationFrame(layoutGrid);
}

function setActiveTab(tab) {
  const next = tab === "people" ? "people" : "chat";
  state.activeTab = next;
  const isChat = next === "chat";
  els.tabChat.classList.toggle("is-active", isChat);
  els.tabChat.setAttribute("aria-selected", String(isChat));
  els.tabPeople.classList.toggle("is-active", !isChat);
  els.tabPeople.setAttribute("aria-selected", String(!isChat));
  els.chatPane.hidden = !isChat;
  els.peoplePane.hidden = isChat;
  if (isChat) {
    state.chatUnread = 0;
    updateChatBadge();
    scrollChatToBottom();
  }
  updateMediaButtons();
}

/* --------------------------------------------------------------- undang */

function openInvite() {
  if (!state.room) return;
  const code = state.room;
  const link = inviteUrl();
  els.inviteCode.textContent = code;
  els.inviteLink.value = link;

  if (typeof els.inviteDialog.showModal === "function") {
    if (!els.inviteDialog.open) els.inviteDialog.showModal();
  } else {
    els.inviteDialog.setAttribute("open", "");
  }
}

async function copyRoomCode(button) {
  const ok = await copyText(state.room);
  if (ok) {
    showToast("Kode ruang disalin.", { type: "success", duration: 2600 });
    flashCopied(button);
  } else {
    showToast("Tidak bisa menyalin otomatis. Salin kode secara manual.", { type: "warning" });
  }
}

async function copyInviteLink(button) {
  const ok = await copyText(inviteUrl());
  if (ok) {
    showToast("Tautan undangan disalin.", { type: "success", duration: 2600 });
    flashCopied(button);
  } else {
    showToast("Tidak bisa menyalin otomatis. Salin tautan dari kotak undangan.", { type: "warning" });
  }
}

async function shareInvite() {
  const url = inviteUrl();
  const text = `Ayo bergabung ke ruang ${state.room} di RuangTemu.`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "RuangTemu", text, url });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  const ok = await copyText(url);
  if (ok) {
    showToast("Tautan undangan disalin. Tempel di aplikasi pesanmu.", {
      type: "success",
      duration: 3500,
    });
    flashCopied(els.shareLinkBtn);
  } else {
    showToast("Salin tautan secara manual dari kotak di atas.", { type: "warning" });
  }
}

function flashCopied(button) {
  const use = button?.querySelector("use");
  if (!use) return;
  const previous = use.getAttribute("href");
  if (!previous) return;
  use.setAttribute("href", "#i-check");
  window.setTimeout(() => {
    if (use.isConnected) use.setAttribute("href", previous);
  }, 1400);
}

/* ---------------------------------------------------------------- audio */

function setAudioBlocked(blocked) {
  state.audioBlocked = Boolean(blocked);
  els.unmuteNudge.hidden = !state.audioBlocked;
}

function tryPlayRemoteVideo(tile) {
  const promise = tile.video.play();
  if (!promise?.catch) return;
  promise.catch((error) => {
    if (error?.name === "AbortError") return;
    tile.video.muted = true;
    tile.video.play().catch(() => {});
    setAudioBlocked(true);
  });
}

function tryPlayRemoteAudio(tile) {
  const promise = tile.audio.play();
  if (!promise?.catch) return;
  promise.catch((error) => {
    if (error?.name === "AbortError") return;
    tile.audio.muted = true;
    tile.audio.play().catch(() => {});
    setAudioBlocked(true);
  });
}

async function unmuteAll() {
  media?.resumeAudio();
  const mediaElements = [...state.tiles.entries()]
    .filter(([id]) => id !== "self")
    .flatMap(([, tile]) => [tile.video, tile.audio]);
  if (!mediaElements.length) {
    setAudioBlocked(false);
    return;
  }
  for (const element of mediaElements) element.muted = false;
  const results = await Promise.allSettled(mediaElements.map((element) => element.play()));
  const failed = results.some((result) => result.status === "rejected");
  if (failed) {
    for (const element of mediaElements) element.muted = true;
    showToast("Browser masih memblokir suara. Ketuk tombol ini sekali lagi.", { type: "warning" });
    return;
  }
  setAudioBlocked(false);
  showToast("Suara peserta aktif.", { type: "success", duration: 2200 });
}

/* ---------------------------------------------------------- keluar ruang */

function leaveMeeting(options = {}) {
  const { silent = false } = options;
  if (!state.inMeeting) return;

  state.inMeeting = false;
  state.joining = false;
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = 0;
  }

  state.mesh?.disconnect();
  state.mesh = null;
  state.selfId = null;
  state.hostId = null;

  media?.stopAll();
  state.screenSharing = false;
  state.audioBlocked = false;
  state.chatUnread = 0;
  state.panelOpen = false;
  state.mediaIssue = "";
  state.tiles.clear();

  els.videoGrid.replaceChildren();
  els.chatLog.replaceChildren();
  els.chatInput.value = "";
  els.sidePanel.hidden = true;
  els.panelScrim.hidden = true;
  els.unmuteNudge.hidden = true;
  els.mediaWarning.hidden = true;
  els.reconnectBanner.hidden = true;
  els.reconnectBanner.removeAttribute("data-state");
  els.reloadBtn.hidden = true;
  if (els.inviteDialog.open) els.inviteDialog.close?.();

  els.meetingView.hidden = true;
  els.lobbyView.hidden = false;
  els.participantCount.textContent = "1";
  els.peopleTabCount.textContent = "1";
  updateConnectionStatus("connecting");
  setJoinBusy(false);
  updateMediaButtons();
  updatePreview();
  updateMediaWarning();
  updateChatBadge();

  if (!silent) {
    showToast("Kamu sudah keluar dari ruang.", { type: "info", duration: 3000 });
  }
}

/* ----------------------------------------------------------------- misc */

function updateTimer() {
  if (!state.inMeeting) return;
  const elapsed = (Date.now() - state.meetingStart) / 1000;
  els.meetingTime.textContent = formatDuration(elapsed);
}

function handleResize() {
  if (state.panelOpen) els.panelScrim.hidden = !isMobileLayout();
  layoutGrid();
}

function broadcastState() {
  state.mesh?.sendState(getLocalState());
}

function makeIcon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

init();
