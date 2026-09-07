// Electron entry point.
// This spawns the Next.js dev server and loads it inside a native desktop
// window, so ULTRON opens as its own app instead of a browser tab at
// localhost:3000.

const { app, BrowserWindow, Menu } = require("electron");
const { spawn, execSync } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = 3000;
const URL = `http://localhost:${PORT}`;
const IS_WIN = process.platform === "win32";

let nextProcess = null;
let mainWindow = null;
let ownsServer = false; // true only if *we* spawned the Next.js process

function isServerUp(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForServer(url, onReady) {
  const tryOnce = () => {
    const req = http.get(url, (res) => {
      res.destroy();
      onReady();
    });
    req.on("error", () => setTimeout(tryOnce, 500));
  };
  tryOnce();
}

function startNextServer() {
  ownsServer = true;
  nextProcess = spawn(IS_WIN ? "npm.cmd" : "npm", ["run", "dev"], {
    cwd: __dirname,
    shell: true,
    env: { ...process.env, PORT: String(PORT) },
    // detached lets us kill the whole process group on macOS/Linux later
    detached: !IS_WIN,
  });

  nextProcess.stdout.on("data", (d) => process.stdout.write(`[next] ${d}`));
  nextProcess.stderr.on("data", (d) => process.stderr.write(`[next] ${d}`));
  nextProcess.on("exit", (code) => {
    console.log(`Next.js server exited with code ${code}`);
    nextProcess = null;
  });
}

/**
 * Kills the Next.js dev server (and the whole child tree it spawned).
 * A plain `.kill()` only signals the top process (`npm.cmd` on Windows),
 * leaving the actual `node`/`next` process it launched still holding the
 * port — which is why 3000 stayed busy on the next run. `taskkill /T`
 * kills the entire tree instead.
 */
function killServer() {
  if (!nextProcess || !ownsServer) return;
  const pid = nextProcess.pid;
  try {
    if (IS_WIN) {
      execSync(`taskkill /pid ${pid} /T /F`);
    } else {
      process.kill(-pid, "SIGTERM"); // negative pid = whole process group
    }
  } catch {
    // Process may have already exited — safe to ignore.
  }
  nextProcess = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    title: "U.L.T.R.O.N.",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Needed so the mic (SpeechRecognition) permission prompt works.
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadURL(URL);

  // Auto-allow the microphone permission prompt for voice input.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === "media") callback(true);
      else callback(false);
    },
  );

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // If a server is already answering on :3000 (e.g. left over from a
  // previous run, or already started separately), just use it instead of
  // spawning a second one — that's what was causing EADDRINUSE.
  const alreadyUp = await isServerUp(URL);
  if (alreadyUp) {
    ownsServer = false;
    createWindow();
  } else {
    startNextServer();
    waitForServer(URL, createWindow);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killServer();
});
