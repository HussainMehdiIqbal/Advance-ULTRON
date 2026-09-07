import { spawn } from "child_process";
import os from "os";
import fs from "fs/promises";
import path from "path";
import { openApp } from "./systemActions";

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

/**
 * Types `text` into whatever window currently has OS focus, via a
 * clipboard-and-paste trick rather than character-by-character key
 * simulation. A multi-paragraph generated letter can contain quotes,
 * punctuation, and line breaks that SendKeys/keystroke need fiddly
 * escaping for and send painfully slowly one key at a time — a paste is
 * instant and exact regardless of what's in the text.
 *
 * Side effect: this overwrites the system clipboard with the generated
 * text (same trade-off any paste-based automation makes). Whatever the
 * user had copied before is replaced.
 */
async function pasteIntoFocusedWindow(text: string): Promise<void> {
  if (IS_WIN) {
    // The text is written to a temp file and read back inside the
    // PowerShell script, rather than interpolated into the command line,
    // so arbitrarily long or quote-heavy generated text never has to
    // survive shell escaping.
    const tmpFile = path.join(os.tmpdir(), `ultron-doc-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, text, "utf8");
    const script = `
$t = Get-Content -Raw -Encoding UTF8 '${tmpFile}'
Set-Clipboard -Value $t
Start-Sleep -Milliseconds 200
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^v")
`;
    await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
    await fs.unlink(tmpFile).catch(() => {});
    return;
  }

  if (IS_MAC) {
    const tmpFile = path.join(os.tmpdir(), `ultron-doc-${Date.now()}.txt`);
    await fs.writeFile(tmpFile, text, "utf8");
    await run("bash", ["-c", `cat '${tmpFile}' | pbcopy`]);
    await fs.unlink(tmpFile).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await run("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']);
    return;
  }

  // Linux — xdotool can type text directly without ever touching the
  // clipboard, sidestepping the need for xclip/xsel to be installed.
  await run("xdotool", ["type", "--clearmodifiers", "--delay", "1", text]);
}

export type EditorTarget = "notepad" | "wordpad";

/**
 * Opens a text editor and writes `text` into it. Waits briefly for the
 * freshly launched app to actually appear and take OS focus before
 * pasting — a new process isn't instantly focused the moment it's spawned.
 */
export async function writeIntoEditor(target: EditorTarget, text: string): Promise<void> {
  await openApp(target);
  await new Promise((r) => setTimeout(r, 800));
  await pasteIntoFocusedWindow(text);
}
