import { spawn } from "child_process";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Keeps the Gemini prompt reasonable — a whole page/app window's
// accessibility text can run to tens of thousands of characters, most of
// which (repeated menu items, nav chrome) doesn't help answer a question,
// so it's capped rather than sent in full.
const MAX_CHARS = 12000;

export interface ScreenReadResult {
  windowTitle: string;
  text: string;
  truncated: boolean;
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

function capText(raw: string): { text: string; truncated: boolean } {
  const cleaned = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // Accessibility trees often repeat the same label on a wrapper element
    // right next to the text node itself — drop immediate duplicates.
    .filter((line, i, arr) => line !== arr[i - 1])
    .join("\n");

  if (cleaned.length <= MAX_CHARS) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(0, MAX_CHARS), truncated: true };
}

// ——— Windows: UI Automation tree walk ————————————————————————————
// Reads whatever text is exposed through the accessibility tree of the
// CURRENTLY FOCUSED window — the same API screen readers use — so it picks
// up rendered webpage text in Chrome/Edge (a Google results page, a
// ChatGPT or Claude reply, an article) as well as native app content
// (Notepad, Word, etc.), with no screenshot or OCR involved.
function buildWindowsScript(): string {
  return `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UltronScreen {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@

$hwnd = [UltronScreen]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NOTFOUND"; exit }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($root -eq $null) { Write-Output "NOTFOUND"; exit }

$title = $root.Current.Name
$sb = New-Object System.Text.StringBuilder
$seen = New-Object System.Collections.Generic.HashSet[string]
$script:count = 0
$maxNodes = 4000

function Walk($el, $depth) {
  if ($script:count -ge $maxNodes) { return }
  $script:count++

  try {
    $name = $el.Current.Name
    if ($name -and $name.Trim().Length -gt 0 -and -not $seen.Contains($name)) {
      [void]$seen.Add($name)
      [void]$sb.AppendLine($name)
    }
  } catch {}

  try {
    $valPattern = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valPattern)) {
      $val = ([System.Windows.Automation.ValuePattern]$valPattern).Current.Value
      if ($val -and $val.Trim().Length -gt 0 -and -not $seen.Contains($val)) {
        [void]$seen.Add($val)
        [void]$sb.AppendLine($val)
      }
    }
  } catch {}

  if ($depth -ge 40) { return }
  try {
    $children = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      if ($script:count -ge $maxNodes) { break }
      Walk $child ($depth + 1)
    }
  } catch {}
}

Walk $root 0

Write-Output "TITLE|$title"
Write-Output $sb.ToString()
`;
}

async function readOnWindows(): Promise<{ title: string; raw: string } | null> {
  const script = buildWindowsScript();
  const { stdout } = await run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);

  if (!stdout || stdout === "NOTFOUND") return null;

  const lines = stdout.split(/\r?\n/);
  const titleLineIdx = lines.findIndex((l) => l.startsWith("TITLE|"));
  const title = titleLineIdx >= 0 ? lines[titleLineIdx].slice("TITLE|".length) : "";
  const raw = lines.slice(titleLineIdx + 1).join("\n");
  return { title, raw };
}

// ——— macOS: best-effort UI scripting via System Events ———————————————
// Considerably less reliable than the Windows UIA path — many apps
// (browsers especially) don't fully expose page content to Accessibility
// unless this app has been granted Accessibility permission in System
// Settings, and even then only static-text elements come through. Good
// enough for short lookups; a long reply may come back partial.
function buildMacScript(): string {
  return `
tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set winTitle to ""
  try
    set winTitle to name of front window of frontApp
  end try
  set allText to {}
  try
    set allText to (value of every static text of entire contents of front window of frontApp)
  end try
end tell
set AppleScript's text item delimiters to linefeed
return winTitle & "|||" & (allText as text)
`;
}

async function readOnMac(): Promise<{ title: string; raw: string } | null> {
  const { stdout } = await run("osascript", ["-e", buildMacScript()]);
  if (!stdout) return null;
  const sep = stdout.indexOf("|||");
  if (sep === -1) return { title: "", raw: stdout };
  return { title: stdout.slice(0, sep), raw: stdout.slice(sep + 3) };
}

// ——— Linux: best-effort via select-all + clipboard ——————————————————
// No single accessibility API is as reliable as Windows' UI Automation
// across Linux desktop environments, so this falls back to the same trick
// a person would use: focus the window, select all, copy, read the
// clipboard. Genuinely best-effort — Ctrl+A/Ctrl+C mean something else in
// some apps (games, media players) — so it's attempted, never guaranteed.
async function readOnLinux(): Promise<{ title: string; raw: string } | null> {
  const active = await run("xdotool", ["getactivewindow"]);
  if (active.code !== 0 || !active.stdout) return null;
  const winId = active.stdout.trim();

  const nameRes = await run("xdotool", ["getwindowname", winId]);
  const title = nameRes.stdout || "";

  await run("xdotool", ["key", "--window", winId, "ctrl+a"]);
  await new Promise((r) => setTimeout(r, 80));
  await run("xdotool", ["key", "--window", winId, "ctrl+c"]);
  await new Promise((r) => setTimeout(r, 120));

  const clip = await run("xclip", ["-selection", "clipboard", "-o"]);
  if (clip.code !== 0) return { title, raw: "" };
  return { title, raw: clip.stdout };
}

/**
 * Reads the visible text of whatever window currently has OS focus — a
 * browser tab (Google results, a ChatGPT/Claude reply, an article), a
 * document, anything. Never throws; returns null if nothing could be read
 * so the caller can produce a clean spoken error instead.
 */
export async function readForegroundWindow(): Promise<ScreenReadResult | null> {
  try {
    const result = IS_WIN ? await readOnWindows() : IS_MAC ? await readOnMac() : await readOnLinux();
    if (!result || !result.raw || !result.raw.trim()) return null;

    const { text, truncated } = capText(result.raw);
    if (!text) return null;

    return { windowTitle: result.title?.trim() || "the current window", text, truncated };
  } catch {
    return null;
  }
}
