import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { getCurrentFolderPath } from "./currentFolder";

// The same small set of locations used elsewhere in ULTRON for
// name-only file lookups (see lib/emailActions.ts's attachment search) —
// the AI can pick WHICH file, never WHERE to read from. Kept as its own
// copy here rather than importing from emailActions.ts, matching this
// codebase's existing pattern of small self-contained helpers per module
// (see the repeated `run()` helper across screenReader/documentWriter/
// codeWriter) rather than a shared cross-module dependency.
function searchRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(process.cwd(), "data", "shared"),
    process.cwd(),
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
    path.join(home, "Documents"),
  ];
  return roots.filter((r) => {
    try {
      return fsSync.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo"]);
const MAX_DEPTH = 4;

function searchDir(root: string, filename: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
      return path.join(root, entry.name);
    }
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
      const found = searchDir(path.join(root, entry.name), filename, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Finds a file by bare name in the allowlisted roots — never accepts a
 * path (blocks "../" up front) and re-verifies the match actually resolves
 * inside the root it was found under. */
function findFile(filename: string): string | null {
  const name = filename.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) return null;

  for (const root of searchRoots()) {
    const found = searchDir(root, name, 0);
    if (!found) continue;
    const resolvedRoot = path.resolve(root) + path.sep;
    const resolvedFound = path.resolve(found);
    if (resolvedFound.startsWith(resolvedRoot)) return resolvedFound;
  }
  return null;
}

const KNOWN_FOLDERS: Record<string, string> = {
  desktop: "Desktop",
  downloads: "Downloads",
  documents: "Documents",
  docs: "Documents",
  pictures: "Pictures",
  photos: "Pictures",
  music: "Music",
  videos: "Videos",
  movies: "Videos",
};

/**
 * Resolves a spoken folder name to an absolute path. A recognized standard
 * folder (Desktop, Downloads, Documents, Pictures, Music, Videos) maps
 * straight to that folder in the user's home directory. Anything else is
 * treated as a new/existing subfolder INSIDE Documents — sanitized to a
 * single safe path segment, so "copy it to MyBackup" is safe to create
 * without ever writing outside a small set of known locations.
 */
function resolveNamedFolder(name: string): string {
  const home = os.homedir();
  const key = name.trim().toLowerCase();
  if (KNOWN_FOLDERS[key]) return path.join(home, KNOWN_FOLDERS[key]);

  const safeSeg =
    name
      .trim()
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.\./g, "")
      .replace(/[<>:"|?*\x00-\x1f]/g, "")
      .trim() || "ULTRON Files";
  return path.join(home, "Documents", safeSeg);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Phrases meaning "whatever folder is currently open" rather than a named
// one — matched as a whole trimmed phrase (case-insensitive), same style
// as the STOP_LISTENING_PHRASES match in useAssistant.ts.
const CURRENT_WINDOW_ALIASES = new Set([
  "current window",
  "this window",
  "current folder",
  "this folder",
  "currently open folder",
  "open window",
  "the current window",
]);

/**
 * Resolves a folder name to an absolute path, handling "current window" /
 * "this folder" specially by asking whatever File Explorer/Finder window
 * currently has OS focus what it's showing — the piece that was missing
 * before, since "current window" doesn't match any of the known folder
 * names in resolveNamedFolder and so had nothing to resolve to.
 */
async function resolveFolder(name: string): Promise<string> {
  const trimmed = name.trim().toLowerCase();
  if (CURRENT_WINDOW_ALIASES.has(trimmed)) {
    const folder = await getCurrentFolderPath();
    if (!folder) {
      throw new Error(
        "I couldn't tell which folder is open in the current window — make sure a File Explorer/Finder window is focused (clicked into) and try again.",
      );
    }
    return folder;
  }
  return resolveNamedFolder(name);
}

/** Appends " (2)", " (3)", etc. before the extension if the destination
 * name is already taken, so a copy never silently overwrites an existing
 * file of the same name. */
async function uniqueDestPath(destDir: string, filename: string): Promise<string> {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(destDir, filename);
  let n = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(destDir, `${base} (${n})${ext}`);
    n++;
  }
  return candidate;
}

export interface CopyResult {
  copied: string[];
  destinationPath: string;
  destinationLabel: string;
}

/** Copies one named file (found via the search roots above) into a named
 * destination folder. */
export async function copySingleFile(filename: string, destinationName: string): Promise<CopyResult> {
  const found = findFile(filename);
  if (!found) {
    throw new Error(
      `Couldn't find a file named "${filename}" in the project, Desktop, Downloads, or Documents.`,
    );
  }

  const destDir = await resolveFolder(destinationName);
  await fs.mkdir(destDir, { recursive: true });

  const destPath = await uniqueDestPath(destDir, path.basename(found));
  await fs.copyFile(found, destPath);

  return { copied: [path.basename(destPath)], destinationPath: destDir, destinationLabel: path.basename(destDir) };
}

/**
 * Copies every top-level FILE (not subfolders, and never recursing into
 * them) from a source folder into a destination folder. Both names go
 * through resolveFolder — either a known folder (Desktop/Downloads/
 * Documents/...), a new subfolder inside Documents, or "current window" to
 * mean whatever's open in the focused Explorer/Finder window — so this can
 * only ever touch that small, safe set of locations, never an arbitrary
 * path. Capped at 200 files so a mistaken "copy everything" can't turn
 * into an unbounded operation.
 */
export async function copyAllFiles(sourceName: string, destinationName: string): Promise<CopyResult> {
  const sourceDir = await resolveFolder(sourceName);
  if (!(await pathExists(sourceDir))) {
    throw new Error(`Couldn't find a folder named "${sourceName}".`);
  }

  const destDir = await resolveFolder(destinationName);
  if (path.resolve(sourceDir) === path.resolve(destDir)) {
    throw new Error("The source and destination are the same folder.");
  }
  await fs.mkdir(destDir, { recursive: true });

  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".")).slice(0, 200);

  if (!files.length) {
    throw new Error(`There aren't any files in ${sourceName} to copy.`);
  }

  const copied: string[] = [];
  for (const f of files) {
    const destPath = await uniqueDestPath(destDir, f.name);
    await fs.copyFile(path.join(sourceDir, f.name), destPath);
    copied.push(path.basename(destPath));
  }

  return { copied, destinationPath: destDir, destinationLabel: path.basename(destDir) };
}
