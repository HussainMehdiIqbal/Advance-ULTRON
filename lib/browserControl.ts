import { spawn } from "child_process";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

export type WindowAction = "close_tab" | "minimize" | "pause_play";

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.on("error", () => resolve({ code: -1, stdout: "" }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim() }));
  });
}

// Keep only characters that can't break out of the quoting we build the
// scripts with below — these come from our own tracked window labels
// ("YouTube", "Gmail", etc.), never raw free-form user text, but this is a
// cheap extra layer of safety regardless.
function sanitize(str: string): string {
  return str.replace(/[`"'$\\]/g, "");
}

const BROWSER_PROCESS_WIN = ["chrome", "msedge", "firefox", "brave"];
const BROWSER_PROCESS_MAC = ["Google Chrome", "Safari", "Microsoft Edge", "Firefox", "Brave Browser"];

/**
 * Windows: enumerate visible top-level windows via the Win32 API (through
 * PowerShell's Add-Type/P-Invoke — no extra native dependency needed),
 * find the one belonging to a known browser process whose title contains
 * `titleContains`, focus it, then perform `action` on JUST that window:
 *  - close_tab -> Ctrl+W (closes the active tab in that window, not the
 *    whole browser)
 *  - pause_play -> Space (pauses/resumes an HTML5 video, e.g. YouTube)
 *  - minimize -> ShowWindow(SW_MINIMIZE) on that window handle only
 */
async function runOnWindows(titleContains: string, action: WindowAction): Promise<boolean> {
  const safeTitle = sanitize(titleContains);
  const browsers = BROWSER_PROCESS_WIN.map((n) => `"${n}"`).join(",");

  const actionScript =
    action === "close_tab"
      ? 'Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait("^w")'
      : action === "pause_play"
        ? 'Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait(" ")'
        : "[WinApi]::ShowWindow($match.Handle, 6) | Out-Null";

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$list = New-Object System.Collections.Generic.List[Object]
$cb = {
  param($hWnd, $lParam)
  if ([WinApi]::IsWindowVisible($hWnd)) {
    $len = [WinApi]::GetWindowTextLength($hWnd)
    if ($len -gt 0) {
      $sb = New-Object System.Text.StringBuilder ($len + 1)
      [WinApi]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
      $procId = 0
      [WinApi]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
      $procName = ""
      try { $procName = (Get-Process -Id $procId).ProcessName } catch {}
      $list.Add([PSCustomObject]@{ Handle = $hWnd; Title = $sb.ToString(); Process = $procName })
    }
  }
  return $true
}
[WinApi]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$browsers = @(${browsers})
$match = $list | Where-Object { $browsers -contains $_.Process -and $_.Title -like "*${safeTitle}*" } | Select-Object -First 1
if ($null -eq $match) {
  Write-Output "NOTFOUND"
} else {
  [WinApi]::SetForegroundWindow($match.Handle) | Out-Null
  Start-Sleep -Milliseconds 200
  ${actionScript}
  Write-Output "OK"
}
`;

  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return stdout.includes("OK");
}

/**
 * macOS: same idea via System Events/AppleScript — find the browser window
 * whose title contains `titleContains`, activate it, then act on just it.
 */
async function runOnMac(titleContains: string, action: WindowAction): Promise<boolean> {
  const safeTitle = sanitize(titleContains);
  const apps = BROWSER_PROCESS_MAC.map((n) => `"${n}"`).join(", ");
  const actionScript =
    action === "close_tab"
      ? 'keystroke "w" using command down'
      : action === "pause_play"
        ? "keystroke space"
        : 'keystroke "m" using command down';

  const script = `
set targetApps to {${apps}}
set foundApp to ""
tell application "System Events"
  repeat with appName in targetApps
    if exists (application process appName) then
      repeat with w in windows of application process appName
        if name of w contains "${safeTitle}" then
          set foundApp to appName
          exit repeat
        end if
      end repeat
    end if
    if foundApp is not "" then exit repeat
  end repeat
end tell
if foundApp is "" then
  return "NOTFOUND"
end if
tell application foundApp to activate
delay 0.2
tell application "System Events"
  ${actionScript}
end tell
return "OK"
`;
  const { stdout } = await run("osascript", ["-e", script]);
  return stdout.includes("OK");
}

/**
 * Linux: best-effort via xdotool, which isn't installed by default on every
 * distro. If it's missing, this cleanly reports "not found" so the caller
 * can fall back rather than throwing an unhandled error.
 */
async function runOnLinux(titleContains: string, action: WindowAction): Promise<boolean> {
  const found = await run("xdotool", ["search", "--name", titleContains]);
  if (found.code !== 0 || !found.stdout) return false;
  const winId = found.stdout.split("\n")[0];

  await run("xdotool", ["windowactivate", "--sync", winId]);
  if (action === "close_tab") {
    await run("xdotool", ["key", "--window", winId, "ctrl+w"]);
  } else if (action === "pause_play") {
    await run("xdotool", ["key", "--window", winId, "space"]);
  } else {
    await run("xdotool", ["windowminimize", winId]);
  }
  return true;
}

/**
 * Finds the browser window whose title contains `titleContains` and
 * performs `action` on it alone — never on other browser windows/tabs.
 * Returns false (never throws) if no matching window was found or the
 * platform's window-control tooling isn't available, so callers can fall
 * back to a blunter method instead of hard-failing.
 */
export async function actOnBrowserWindow(titleContains: string, action: WindowAction): Promise<boolean> {
  try {
    if (IS_WIN) return await runOnWindows(titleContains, action);
    if (IS_MAC) return await runOnMac(titleContains, action);
    return await runOnLinux(titleContains, action);
  } catch {
    return false;
  }
}
