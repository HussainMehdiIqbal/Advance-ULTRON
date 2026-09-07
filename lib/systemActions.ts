import { spawn } from "child_process";
import os from "os";
import { actOnBrowserWindow } from "./browserControl";
import { actOnForegroundWindow } from "./globalWindowControl";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Fixed allowlist — the AI only ever picks a *key* from this table, never a
// raw command string, so there's no way for a crafted message to make it
// launch something arbitrary.
const APP_MAP: Record<string, { win: string; mac: string; linux: string }> = {
  notepad: { win: "notepad", mac: "TextEdit", linux: "gedit" },
  calculator: { win: "calc", mac: "Calculator", linux: "gnome-calculator" },
  paint: { win: "mspaint", mac: "Preview", linux: "gimp" },
  explorer: { win: "explorer", mac: "Finder", linux: "nautilus" },
  "file explorer": { win: "explorer", mac: "Finder", linux: "nautilus" },
  cmd: { win: "cmd", mac: "Terminal", linux: "gnome-terminal" },
  "command prompt": { win: "cmd", mac: "Terminal", linux: "gnome-terminal" },
  "task manager": {
    win: "taskmgr",
    mac: "Activity Monitor",
    linux: "gnome-system-monitor",
  },
  wordpad: { win: "write", mac: "TextEdit", linux: "gedit" },
};

export function listSupportedApps(): string[] {
  return Object.keys(APP_MAP);
}

// ——— "What did ULTRON last open?" tracking ———————————————————————————
// Kept so a browser tab ULTRON itself launched can still be closed with a
// safe, tab-only Ctrl+W (see closeLastOpened below) instead of the whole
// browser. It's no longer the only thing "close/minimize/pause it" can
// act on, though — see lib/globalWindowControl.ts, which targets whatever
// window currently has OS focus (Notepad, File Explorer, VLC, a browser
// tab ULTRON didn't open, anything), so those commands work globally, not
// just on what this session happened to launch.
type LastOpened = { type: "app"; key: string } | { type: "url"; url: string; label: string } | null;

let lastOpened: LastOpened = null;

/** Turns a URL into a short label to search for in the browser's window
 * title when no explicit label was given — e.g. "https://www.youtube.com/…"
 * -> "youtube", which is virtually always present in the tab title. */
function deriveLabelFromUrl(rawUrl: string): string {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "");
    return host.split(".")[0] || host;
  } catch {
    return rawUrl;
  }
}

// Apps that must never be force-closed this way. explorer.exe *is* the
// Windows shell/taskbar — killing it takes the whole desktop down, not
// just a window, so "close explorer" is refused rather than honoured.
const UNSAFE_TO_CLOSE = new Set(["explorer", "file explorer"]);

// Process image names for the same apps in APP_MAP, used only for closing
// (taskkill/pkill needs the actual executable/process name, which isn't
// always the same string used to launch it).
const APP_PROCESS_NAME: Record<string, { win: string; mac: string; linux: string }> = {
  notepad: { win: "notepad.exe", mac: "TextEdit", linux: "gedit" },
  calculator: { win: "CalculatorApp.exe", mac: "Calculator", linux: "gnome-calculator" },
  paint: { win: "mspaint.exe", mac: "Preview", linux: "gimp" },
  cmd: { win: "cmd.exe", mac: "Terminal", linux: "gnome-terminal" },
  "command prompt": { win: "cmd.exe", mac: "Terminal", linux: "gnome-terminal" },
  "task manager": { win: "Taskmgr.exe", mac: "Activity Monitor", linux: "gnome-system-monitor" },
  wordpad: { win: "write.exe", mac: "TextEdit", linux: "gedit" },
};

function killByName(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    if (IS_WIN) {
      child = spawn("taskkill", ["/IM", name, "/F"]);
    } else if (IS_MAC) {
      child = spawn("pkill", ["-x", name]);
    } else {
      child = spawn("pkill", ["-f", name]);
    }
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

/**
 * Closes a window. Preference order:
 *  1. If ULTRON tracked opening a browser tab (lastOpened.type === "url")
 *     AND that tab's window is still the one in the OS foreground, do the
 *     *targeted* tab-only close (Ctrl+W on just that window) — this keeps
 *     ULTRON's original safety promise for things it opened itself: other
 *     tabs/windows in that browser are never touched.
 *  2. Otherwise, close whatever window currently has OS focus — Notepad,
 *     File Explorer, VLC, a browser window ULTRON didn't open, anything —
 *     via a graceful WM_CLOSE-style request (same as the app's own close
 *     button), so it's global but still only ever touches the one window
 *     the user is actually looking at.
 * The explorer.exe shell/desktop itself is refused in both paths so
 * "close it" can never take out the whole desktop.
 */
export async function closeLastOpened(): Promise<string> {
  if (lastOpened?.type === "app" && UNSAFE_TO_CLOSE.has(lastOpened.key)) {
    throw new Error(`I won't force-close ${lastOpened.key} — that would take your whole desktop down with it.`);
  }

  if (lastOpened?.type === "url") {
    const { label } = lastOpened;
    const targeted = await actOnBrowserWindow(label, "close_tab");
    if (targeted) {
      lastOpened = null;
      return `Closed the ${label} tab.`;
    }
  }

  const result = await actOnForegroundWindow("close");
  if (result.ok) {
    lastOpened = null;
    return `Closed ${result.label ?? "the active window"}.`;
  }
  if (result.refused) {
    throw new Error(`I won't close that — ${result.refused}.`);
  }

  // Last resort: if ULTRON opened a tracked app that isn't currently
  // focused (so the foreground-window path above couldn't reach it),
  // fall back to closing it by process name.
  if (lastOpened?.type === "app") {
    const entry = APP_PROCESS_NAME[lastOpened.key];
    if (entry) {
      const name = IS_WIN ? entry.win : IS_MAC ? entry.mac : entry.linux;
      const closed = await killByName(name);
      if (closed) {
        const key = lastOpened.key;
        lastOpened = null;
        return `Closed ${key}.`;
      }
    }
  }

  throw new Error("Couldn't find a window to close — nothing seems to be focused right now.");
}

/**
 * Pauses/resumes whatever's playing in the currently focused window — the
 * standard Space shortcut for YouTube, most HTML5 video, and most desktop
 * media players (VLC included). Prefers the specific browser tab/window
 * ULTRON itself opened when that's still what's focused; otherwise targets
 * whatever's in the OS foreground.
 */
export async function pausePlayLastOpened(): Promise<string> {
  if (lastOpened?.type === "url") {
    const { label } = lastOpened;
    const targeted = await actOnBrowserWindow(label, "pause_play");
    if (targeted) return `Toggled play/pause on ${label}.`;
  }

  const result = await actOnForegroundWindow("pause_play");
  if (result.ok) return `Toggled play/pause on ${result.label ?? "the active window"}.`;
  if (result.refused) throw new Error(`I won't do that — ${result.refused}.`);
  throw new Error("Couldn't find a window to pause — nothing seems to be focused right now.");
}

/**
 * Minimizes the currently focused window — any app, not just a browser
 * tab ULTRON opened. Prefers the targeted browser-tab path when that's
 * what's actually focused (leaves other tabs/windows untouched exactly as
 * before); otherwise minimizes whatever's in the OS foreground.
 */
export async function minimizeLastOpened(): Promise<string> {
  if (lastOpened?.type === "url") {
    const { label } = lastOpened;
    const targeted = await actOnBrowserWindow(label, "minimize");
    if (targeted) return `Minimized ${label}.`;
  }

  const result = await actOnForegroundWindow("minimize");
  if (result.ok) return `Minimized ${result.label ?? "the active window"}.`;
  if (result.refused) throw new Error(`I won't minimize that — ${result.refused}.`);
  throw new Error("Couldn't find a window to minimize — nothing seems to be focused right now.");
}

export function openApp(appKey: string): Promise<void> {
  const key = appKey.toLowerCase().trim();
  const entry = APP_MAP[key];
  if (!entry) {
    return Promise.reject(
      new Error(
        `"${appKey}" isn't a supported app. Supported: ${listSupportedApps().join(", ")}.`,
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let child;
    if (IS_WIN) {
      child = spawn("cmd.exe", ["/c", "start", "", entry.win]);
    } else if (IS_MAC) {
      child = spawn("open", ["-a", entry.mac]);
    } else {
      child = spawn(entry.linux, [], { detached: true });
    }
    child.on("error", reject);
    setTimeout(() => {
      lastOpened = { type: "app", key };
      resolve();
    }, 300);
  });
}

export function openUrl(rawUrl: string, label?: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.reject(new Error("Invalid URL."));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error("Only http/https URLs can be opened."));
  }

  return new Promise((resolve, reject) => {
    let child;
    if (IS_WIN) {
      child = spawn("cmd.exe", ["/c", "start", "", url.toString()]);
    } else if (IS_MAC) {
      child = spawn("open", [url.toString()]);
    } else {
      child = spawn("xdg-open", [url.toString()], { detached: true });
    }
    child.on("error", reject);
    setTimeout(() => {
      lastOpened = {
        type: "url",
        url: url.toString(),
        label: label?.trim() || deriveLabelFromUrl(url.toString()),
      };
      resolve();
    }, 300);
  });
}

/**
 * Searches YouTube for the query and opens the first video result directly
 * (YouTube autoplays on load), so it actually starts playing rather than
 * just showing a results page. Falls back to the search page if scraping
 * the first result fails for any reason.
 */
export async function playSongOnYouTube(query: string): Promise<string> {
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    if (match) {
      const watchUrl = `https://www.youtube.com/watch?v=${match[1]}&autoplay=1`;
      await openUrl(watchUrl, "YouTube");
      return watchUrl;
    }
  } catch {
    // fall through
  }
  await openUrl(searchUrl, "YouTube");
  return searchUrl;
}

/**
 * Opens a Google search results page in the browser — distinct from the
 * `web_search` action, which fetches results server-side and has Gemini
 * speak/type a synthesized answer. This is for when the user actually
 * wants the browser tab open in front of them.
 */
export async function openBrowserSearch(query: string): Promise<string> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  await openUrl(url, "Google");
  return url;
}

/**
 * Opens a WhatsApp chat with the message pre-filled via wa.me. This
 * deliberately stops short of auto-pressing send — the human still has to
 * hit Enter — so a misheard voice command or a bad AI guess can never fire
 * a message on its own.
 */
export async function openWhatsAppChat(phone: string, message: string): Promise<void> {
  const digits = phone.replace(/[^\d]/g, "");
  if (!digits) throw new Error("Missing or invalid phone number (include country code).");
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
  await openUrl(url, "WhatsApp");
}

/**
 * Local system status — CPU, memory, uptime, platform. Reads entirely from
 * Node's built-in `os` module, so no extra dependency and no data leaves
 * the machine.
 */
export function getSystemStatus(): string {
  const totalMemGB = os.totalmem() / 1024 ** 3;
  const freeMemGB = os.freemem() / 1024 ** 3;
  const usedPct = ((totalMemGB - freeMemGB) / totalMemGB) * 100;
  const uptimeMin = Math.floor(os.uptime() / 60);
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() ?? "Unknown CPU";
  const load = os.loadavg()[0]; // always 0 on Windows

  const lines = [
    `Platform: ${os.platform()} ${os.release()}`,
    `CPU: ${cpuModel} (${cpus.length} cores)`,
    `Memory: ${freeMemGB.toFixed(1)} GB free of ${totalMemGB.toFixed(1)} GB (${usedPct.toFixed(0)}% used)`,
    `Uptime: ${uptimeMin} minute${uptimeMin === 1 ? "" : "s"}`,
  ];
  if (load > 0) lines.push(`Load average (1 min): ${load.toFixed(2)}`);
  return lines.join(". ");
}

/**
 * Weather via wttr.in's plain-text endpoint — no API key needed. When no
 * location is given, wttr.in geolocates by the requesting IP; since this
 * request goes out from the user's own machine (the Next.js server runs
 * locally), that's the user's real location, not the app's.
 */
export async function getWeather(location?: string): Promise<string> {
  const trimmed = location?.trim() ?? "";
  const path = trimmed ? encodeURIComponent(trimmed) : "";
  const url = `https://wttr.in/${path}?format=%l:+%C,+%t+(feels+like+%f),+humidity+%h,+wind+%w`;

  const res = await fetch(url, { headers: { "User-Agent": "curl/8.0" } });
  if (!res.ok) throw new Error("Couldn't reach the weather service.");

  const text = (await res.text()).trim();
  if (!text || /unknown location/i.test(text)) {
    throw new Error(
      trimmed ? `Couldn't find weather for "${trimmed}".` : "Couldn't determine weather for your location.",
    );
  }
  return text;
}

/**
 * Current date/time on the user's own machine (the Next.js server runs
 * locally, so this is always the user's real local time — no timezone
 * lookup needed).
 */
export function getTimeInfo(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${timeStr} on ${dateStr}`;
}
