import { spawn } from "child_process";
import os from "os";
import fs from "fs/promises";
import path from "path";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Generated code files live in their own folder in the user's home
// directory — not inside ULTRON's own project source — so VS Code opens
// onto the user's actual generated file, not into ULTRON's codebase, and
// so the files are easy to find outside the app.
const CODE_DIR = path.join(os.homedir(), "ULTRON Code");

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: IS_WIN });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", () => resolve({ code: -1, stdout: "", stderr: "spawn error" }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/**
 * Reduces whatever filename Gemini suggested to a single safe basename —
 * no directory separators, no "..", a sane length cap, and a fallback
 * extension — so the generated file can never land outside CODE_DIR
 * regardless of what the model returns.
 */
function sanitizeFilename(raw: string): string {
  let name = raw.trim().split(/[/\\]/).pop() ?? "";
  name = name.replace(/\.\./g, "").replace(/[<>:"|?*\x00-\x1f]/g, "");
  name = name.trim();

  if (!name) name = "untitled.txt";
  if (!path.extname(name)) name += ".txt";
  if (name.length > 100) {
    const ext = path.extname(name);
    name = name.slice(0, 100 - ext.length) + ext;
  }
  return name;
}

/** Appends " (2)", " (3)", etc. before the extension if the name's taken,
 * so generating the same kind of file twice never clobbers the first one. */
async function uniquePath(filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(CODE_DIR, filename);
  let n = 2;
  while (
    await fs
      .access(candidate)
      .then(() => true)
      .catch(() => false)
  ) {
    candidate = path.join(CODE_DIR, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

async function openInVSCode(filePath: string): Promise<void> {
  // "code" is VS Code's own CLI, present on PATH once a user has run
  // "Shell Command: Install 'code' command in PATH" from the command
  // palette (VS Code often offers to do this on first install). Tried
  // first everywhere since it's the most reliable, official way to open a
  // specific file into a running or fresh VS Code window.
  const viaCli = await run("code", [filePath]);
  if (viaCli.code === 0) return;

  if (IS_WIN) {
    // Falls back to the two standard install locations if "code" isn't on
    // PATH — the per-user install (default for the normal installer) and
    // the machine-wide one.
    const candidates = [
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
      path.join(process.env.ProgramFiles ?? "", "Microsoft VS Code", "Code.exe"),
    ];
    for (const exe of candidates) {
      const exists = await fs
        .access(exe)
        .then(() => true)
        .catch(() => false);
      if (!exists) continue;
      const res = await run("cmd.exe", ["/c", "start", "", `"${exe}"`, `"${filePath}"`]);
      if (res.code === 0) return;
    }
  } else if (IS_MAC) {
    const res = await run("open", ["-a", "Visual Studio Code", filePath]);
    if (res.code === 0) return;
  } else {
    const res = await run("flatpak", ["run", "com.visualstudio.code", filePath]);
    if (res.code === 0) return;
  }

  throw new Error(
    "The file was written, but I couldn't open VS Code automatically — it may not be installed, or the 'code' command isn't on your PATH. " +
      "In VS Code, open the Command Palette and run \"Shell Command: Install 'code' command in PATH\", then try again.",
  );
}

export interface WrittenCodeFile {
  filePath: string;
  filename: string;
}

/**
 * Writes `code` to a new file (auto-numbered if the name's taken) inside
 * the dedicated ULTRON Code folder, then opens it in VS Code. Throws with
 * a clear, speakable message if VS Code itself couldn't be launched —
 * the file is still saved in that case, so nothing generated is lost.
 */
export async function writeCodeFile(rawFilename: string, code: string): Promise<WrittenCodeFile> {
  await fs.mkdir(CODE_DIR, { recursive: true });

  const filename = sanitizeFilename(rawFilename);
  const filePath = await uniquePath(filename);

  await fs.writeFile(filePath, code, "utf8");
  await openInVSCode(filePath);

  return { filePath, filename: path.basename(filePath) };
}
