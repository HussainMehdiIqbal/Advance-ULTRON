import fs from "fs";
import path from "path";

/**
 * Persists every command/reply pair ULTRON handles into a plain-text,
 * date-named log under the project's own `history/` folder — so "give me
 * history of today" has real data to work with no matter how many times
 * the app has been closed and reopened since. Chat state in the browser
 * (hooks/useAssistant.ts) is only in-memory and resets on reload; this is
 * the durable copy, written server-side on every request.
 */

const HISTORY_DIR = path.join(process.cwd(), "history");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** YYYY-MM-DD using the machine's own local time — this app runs on the
 * user's own computer, so "today" means their today, not UTC's. */
export function todayDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeString(d: Date = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `dateStr` is only ever a caller-validated YYYY-MM-DD (see DATE_RE
 * checks at every call site below), so this can never resolve outside
 * HISTORY_DIR — same allowlist-style guarantee as the email attachment
 * lookup in emailActions.ts. */
function historyFilePath(dateStr: string): string {
  return path.join(HISTORY_DIR, `${dateStr}.txt`);
}

/**
 * Appends one user/assistant exchange to today's log file, creating the
 * history/ folder and the day's file on first use. Best-effort: a logging
 * failure must never break the actual assistant response, so every error
 * here is swallowed.
 */
export function appendHistoryEntry(userText: string, assistantText: string): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const now = new Date();
    const stamp = `[${timeString(now)}]`;
    const line = `${stamp} YOU: ${userText}\n${stamp} ULTRON: ${assistantText}\n\n`;
    fs.appendFileSync(historyFilePath(todayDateString(now)), line, "utf-8");
  } catch {
    // non-fatal — logging should never take down a real response
  }
}

/**
 * Reads a day's raw log. `dateStr` must already look like YYYY-MM-DD or
 * it's ignored in favor of today — untrusted input is never resolved
 * directly into a path.
 */
export function readHistoryLog(dateStr?: string): { date: string; content: string } | null {
  const date = dateStr && DATE_RE.test(dateStr) ? dateStr : todayDateString();
  try {
    const content = fs.readFileSync(historyFilePath(date), "utf-8");
    return { date, content };
  } catch {
    return null;
  }
}

/**
 * Appends a generated overview block to the end of a day's log, so the
 * .txt file itself ends up holding both the raw run log AND the
 * human-readable summary if the user opens it directly.
 */
export function appendOverviewToLog(dateStr: string, overview: string): void {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    const date = DATE_RE.test(dateStr) ? dateStr : todayDateString();
    const block = `\n=== OVERVIEW (generated ${timeString()}) ===\n${overview}\n=== end overview ===\n\n`;
    fs.appendFileSync(historyFilePath(date), block, "utf-8");
  } catch {
    // non-fatal
  }
}
