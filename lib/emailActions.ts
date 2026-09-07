import fs from "fs";
import path from "path";
import os from "os";
import nodemailer from "nodemailer";

/**
 * Real email sending via SMTP (nodemailer) — "send email to X saying Y" and
 * optional "attach file Z" actually deliver, unlike the WhatsApp action
 * which only pre-fills. Credentials live in the browser's localStorage
 * exactly like the Gemini API key (see hooks/useAssistant.ts) and are sent
 * with each request; nothing is stored on the server or in the repo.
 *
 * Default transport is Gmail SMTP. Gmail requires a 16-character **App
 * Password** (myaccount.google.com/apppasswords with 2-Step Verification
 * on) — a normal account password will be rejected by Google. Any other
 * SMTP provider can be used by filling in host/port/secure in Settings.
 */

export interface EmailConfig {
  user: string; // the "from" address / SMTP login
  pass: string; // app password / SMTP password
  host?: string; // defaults to smtp.gmail.com
  port?: number; // defaults to 465
  secure?: boolean; // defaults to true (465/SSL)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(addr: string): boolean {
  return EMAIL_RE.test(addr.trim());
}

// ——— Attachment lookup ————————————————————————————————————————————
// The user only ever gives a bare filename ("index.html"), never a path, so
// we search a fixed, small set of allowlisted directories instead of
// trusting any path the model might construct. This mirrors the app-launch
// allowlist in systemActions.ts: the AI can pick *which* file, never *where
// to read from*. Every candidate is re-validated to actually resolve inside
// one of these roots before it's ever opened, which also rules out any
// "../" traversal trick.
function attachmentRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(process.cwd(), "data", "shared"), // put files here to make them emailable
    process.cwd(), // the project itself, e.g. "send index.html"
    path.join(home, "Desktop"),
    path.join(home, "Downloads"),
    path.join(home, "Documents"),
  ];
  return roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo"]);
const MAX_DEPTH = 4;

function searchDir(root: string, filename: string, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  // Files before directories, so an exact match at this level wins over
  // recursing further down.
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

/**
 * Finds a file by bare name within the allowlisted roots and returns an
 * absolute path guaranteed to live inside one of them. Rejects anything
 * with a path separator up front, so "send ../../.env" is refused before
 * any disk access happens.
 */
export function findAttachment(filename: string): string | null {
  const name = filename.trim();
  if (!name || name.includes("/") || name.includes("\\") || name.includes("..")) {
    return null;
  }

  for (const root of attachmentRoots()) {
    const found = searchDir(root, name, 0);
    if (!found) continue;
    const resolvedRoot = path.resolve(root) + path.sep;
    const resolvedFound = path.resolve(found);
    if (resolvedFound.startsWith(resolvedRoot)) return resolvedFound;
  }
  return null;
}

function buildTransport(config: EmailConfig) {
  return nodemailer.createTransport({
    host: config.host?.trim() || "smtp.gmail.com",
    port: config.port || 465,
    secure: config.secure ?? true,
    auth: { user: config.user, pass: config.pass },
  });
}

/**
 * Sends an email, optionally with one attachment found by bare filename.
 * Throws with a clear, speakable message on any failure so it can be
 * surfaced straight back through the assistant's voice/text reply.
 */
export async function sendEmail(
  config: EmailConfig | undefined,
  to: string,
  subject: string,
  message: string,
  attachmentFilename?: string,
): Promise<string> {
  if (!config?.user || !config?.pass) {
    throw new Error("Add your email address and app password in Settings first.");
  }
  const recipient = to.trim();
  if (!isValidEmail(recipient)) {
    throw new Error(`"${to}" doesn't look like a valid email address.`);
  }

  let attachmentPath: string | undefined;
  if (attachmentFilename?.trim()) {
    const found = findAttachment(attachmentFilename.trim());
    if (!found) {
      throw new Error(
        `Couldn't find a file named "${attachmentFilename}" in the project, Desktop, Downloads, or Documents.`,
      );
    }
    attachmentPath = found;
  }

  const transport = buildTransport(config);

  try {
    await transport.sendMail({
      from: config.user,
      to: recipient,
      subject: subject?.trim() || "Message from ULTRON",
      text: message,
      attachments: attachmentPath ? [{ filename: path.basename(attachmentPath), path: attachmentPath }] : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Google's most common rejection — a normal account password instead
    // of an App Password. Surface a fix, not the raw SMTP error text.
    if (/application-specific password required|invalidsecondfactor/i.test(msg)) {
      throw new Error(
        "Google rejected that password — it needs an App Password, not your regular Gmail password. " +
          "Turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords and paste it into Settings.",
      );
    }
    if (/invalid login|username and password not accepted/i.test(msg)) {
      throw new Error("Email login failed — double-check the address and app password in Settings.");
    }
    throw new Error(`Failed to send email: ${msg}`);
  }

  return attachmentPath
    ? `Sent the email to ${recipient} with ${path.basename(attachmentPath)} attached.`
    : `Sent the email to ${recipient}.`;
}
