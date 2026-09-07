import { spawn } from "child_process";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim() }));
  });
}

// ——— Windows: Shell.Application COM, matched to the foreground window ———
// File Explorer doesn't expose "what folder am I showing" through a simple
// API, but the classic Shell.Application COM object lists every open
// Explorer window along with its HWND and current folder path — so this
// matches that list against whichever window currently has OS focus, the
// same target every other "current window" feature in ULTRON already uses
// (read_screen, close_window, minimize_window, etc).
function buildWindowsScript(): string {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UltronFolder {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$hwnd = [UltronFolder]::GetForegroundWindow()
$shell = New-Object -ComObject Shell.Application
foreach ($w in $shell.Windows()) {
  try {
    if ([IntPtr]$w.HWND -eq $hwnd) {
      Write-Output $w.Document.Folder.Self.Path
      exit
    }
  } catch {}
}
Write-Output "NOTFOUND"
`;
}

async function getOnWindows(): Promise<string | null> {
  const { stdout } = await run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    buildWindowsScript(),
  ]);
  if (!stdout || stdout === "NOTFOUND") return null;
  return stdout;
}

// ——— macOS: Finder's front window, via AppleScript ———————————————————
function buildMacScript(): string {
  return `
tell application "System Events"
  set frontAppName to name of first application process whose frontmost is true
end tell
if frontAppName is not "Finder" then return "NOTFOUND"
tell application "Finder"
  try
    return POSIX path of (target of front window as alias)
  on error
    return "NOTFOUND"
  end try
end tell
`;
}

async function getOnMac(): Promise<string | null> {
  const { stdout } = await run("osascript", ["-e", buildMacScript()]);
  if (!stdout || stdout === "NOTFOUND") return null;
  return stdout;
}

/**
 * Returns the folder currently open in the focused Explorer/Finder window,
 * or null if the focused window isn't a file browser at all (or on Linux,
 * where there's no single reliable API for this across desktop
 * environments — same honest limitation as lib/screenReader.ts).
 */
export async function getCurrentFolderPath(): Promise<string | null> {
  try {
    if (IS_WIN) return await getOnWindows();
    if (IS_MAC) return await getOnMac();
    return null;
  } catch {
    return null;
  }
}
