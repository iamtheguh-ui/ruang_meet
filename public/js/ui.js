/* Utilitas kecil yang dipakai bersama oleh modul RuangTemu. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function initials(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return Array.from(words[0]).slice(0, 2).join("").toUpperCase();
  }
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

export function hueFor(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = (hash * 31 + char.codePointAt(0)) % 360;
  }
  return hash;
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(rest)}`;
  return `${pad(minutes)}:${pad(rest)}`;
}

const timeFormatter = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatTime(timestamp = Date.now()) {
  try {
    return timeFormatter.format(new Date(timestamp));
  } catch {
    return "";
  }
}

const TOAST_ICONS = { info: "i", success: "✓", error: "!", warning: "!" };
const MAX_TOASTS = 4;

export function showToast(message, options = {}) {
  const { type = "info", duration } = options;
  const host = document.getElementById("toasts");
  if (!host || !message) return;

  while (host.children.length >= MAX_TOASTS) {
    host.firstElementChild?.remove();
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.dataset.type = type;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = TOAST_ICONS[type] || TOAST_ICONS.info;

  const text = document.createElement("div");
  text.textContent = message;

  toast.append(icon, text);
  host.append(toast);

  const timeout = duration ?? (type === "error" ? 7000 : type === "warning" ? 8000 : 4200);
  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 240);
  };
  const timer = window.setTimeout(remove, timeout);
  toast.addEventListener("click", () => {
    window.clearTimeout(timer);
    remove();
  });
}

export function friendlyMediaError(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Akses kamera/mikrofon ditolak. Izinkan lewat ikon kamera di bilah alamat, lalu coba lagi.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Kamera atau mikrofon tidak ditemukan di perangkat ini.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Kamera/mikrofon sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "Pengaturan kamera tidak didukung perangkat ini.";
  }
  if (name === "AbortError") {
    return "Akses perangkat dihentikan. Coba lagi.";
  }
  if (name === "TypeError" || name === "NotSupportedError") {
    return "Browser ini tidak bisa mengakses media. Buka lewat HTTPS atau localhost dengan browser terbaru.";
  }
  return "Tidak dapat mengakses kamera atau mikrofon. Coba lagi.";
}

export async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // jatuh ke fallback di bawah
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function isMobileLayout() {
  return window.matchMedia("(max-width: 920px)").matches;
}

export function isNarrowLayout() {
  return window.matchMedia("(max-width: 760px)").matches;
}

export function debounce(fn, wait = 120) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export const storage = {
  get(key, fallback = null) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // penyimpanan bisa diblokir mode privat
    }
  },
  getBool(key, fallback = true) {
    const value = this.get(key);
    if (value === null) return fallback;
    return value !== "false" && value !== "0";
  },
};
