import { spawn } from "child_process";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

export type GlobalWindowAction = "close" | "minimize" | "pause_play";

export interface ForegroundResult {
  ok: boolean;
  /** Best-effort human label for the window that was acted on, e.g. "Notepad". */
  label?: string;
  /** Set when we deliberately refused to act (e.g. target was the desktop/taskbar shell). */
  refused?: string;
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim() }));
  });
}

// ——— Windows ———————————————————————————————————————————————————————
//
// Acts on whatever window is CURRENTLY in the OS foreground — this is the
// generic path used for "close/minimize/pause it" when the target isn't
// something ULTRON itself tracked opening (see systemActions.ts), so it
// works for Notepad, File Explorer, VLC, or literally anything else the
// user has focused, not just a browser tab ULTRON launched.
//
// Close uses WM_CLOSE (a graceful "please close yourself" message the app
// itself handles — same as clicking the window's own X button, so unsaved-
// work prompts still show) rather than killing the process, so it only
// ever affects the one focused window/document, never the whole app.
//
// Refuses to act on the desktop/taskbar shell itself (empty title, or
// title "Program Manager") — that's Explorer.exe's shell window, not a
// real app window, and closing/minimizing it doesn't do what a user means
// by "minimize it".
function buildWindowsForegroundScript(action: GlobalWindowAction): string {
  const WM_CLOSE = 0x0010;
  const SW_MINIMIZE = 6;

  const actionScript =
    action === "close"
      ? `[UltronGlobal]::PostMessage($hwnd, ${WM_CLOSE}, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null`
      : action === "minimize"
        ? `[UltronGlobal]::ShowWindow($hwnd, ${SW_MINIMIZE}) | Out-Null`
        : `[UltronGlobal]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 150
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(" ")`;

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class UltronGlobal {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$hwnd = [UltronGlobal]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) {
  Write-Output "NOTFOUND"
  exit
}

$len = [UltronGlobal]::GetWindowTextLength($hwnd)
$title = ""
if ($len -gt 0) {
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [UltronGlobal]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
}

$procId = 0
[UltronGlobal]::GetWindowThreadProcessId($hwnd, [ref]$procId) | Out-Null
$procName = ""
try { $procName = (Get-Process -Id $procId).ProcessName } catch {}

if ($title -eq "" -or $title -eq "Program Manager") {
  Write-Output "REFUSED"
  exit
}

${actionScript}
Write-Output "OK|$procName|$title"
`;
}

async function runOnWindows(action: GlobalWindowAction): Promise<ForegroundResult> {
  const script = buildWindowsForegroundScript(action);
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);

  if (stdout === "NOTFOUND") return { ok: false };
  if (stdout === "REFUSED") {
    return { ok: false, refused: "that's the desktop itself, not a real app window" };
  }
  if (stdout.startsWith("OK|")) {
    const [, , title] = stdout.split("|");
    return { ok: true, label: title || undefined };
  }
  return { ok: false };
}

// ——— macOS ————————————————————————————————————————————————————————
//
// "Frontmost process" is macOS's equivalent of the foreground window.
// Close/minimize are sent as the standard system-wide keyboard shortcuts
// (⌘W / ⌘M) rather than an Accessibility-API window handle, since that
// keeps this working across arbitrary third-party apps without needing
// per-app AppleScript dictionaries.
async function runOnMac(action: GlobalWindowAction): Promise<ForegroundResult> {
  const keystroke =
    action === "close" ? '"w" using command down' : action === "minimize" ? '"m" using command down' : "space";

  const script = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
end tell
if frontApp is "Finder" and "${action}" is "close" then
  return "REFUSED"
end if
tell application "System Events"
  keystroke ${keystroke}
end tell
return "OK|" & frontApp
`;
  const { stdout } = await run("osascript", ["-e", script]);
  if (stdout === "REFUSED") return { ok: false, refused: "that's the Finder desktop, not a real app window" };
  if (stdout.startsWith("OK|")) return { ok: true, label: stdout.slice(3) || undefined };
  return { ok: false };
}

// ——— Linux ————————————————————————————————————————————————————————
//
// Best-effort via xdotool (for finding/activating the active window and
// sending play/pause) and wmctrl (for a graceful, standards-based close
// request — _NET_CLOSE_WINDOW — that the window manager forwards to the
// app, same as clicking its own close button). Falls back to an Alt+F4
// keypress, which most Linux desktop environments bind to "close active
// window", if wmctrl isn't installed.
async function runOnLinux(action: GlobalWindowAction): Promise<ForegroundResult> {
  const active = await run("xdotool", ["getactivewindow"]);
  if (active.code !== 0 || !active.stdout) return { ok: false };
  const winId = active.stdout.trim();

  const nameRes = await run("xdotool", ["getwindowname", winId]);
  const label = nameRes.stdout || undefined;

  if (action === "minimize") {
    await run("xdotool", ["windowminimize", winId]);
    return { ok: true, label };
  }
  if (action === "pause_play") {
    await run("xdotool", ["key", "--window", winId, "space"]);
    return { ok: true, label };
  }

  // close
  const wmctrl = await run("wmctrl", ["-ic", winId]);
  if (wmctrl.code !== 0) {
    await run("xdotool", ["key", "--window", winId, "alt+F4"]);
  }
  return { ok: true, label };
}

/**
 * Acts on whatever window currently has OS focus — any app, not just a
 * browser. This is the generic fallback used when ULTRON doesn't have a
 * more specific, safer target in mind (see systemActions.ts). Never
 * throws; returns { ok: false } on failure so callers can produce a clean
 * spoken error instead of an unhandled exception.
 */
export async function actOnForegroundWindow(action: GlobalWindowAction): Promise<ForegroundResult> {
  try {
    if (IS_WIN) return await runOnWindows(action);
    if (IS_MAC) return await runOnMac(action);
    return await runOnLinux(action);
  } catch {
    return { ok: false };
  }
}
