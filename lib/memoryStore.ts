import fs from "fs";
import path from "path";

/**
 * Simple persistent memory for ULTRON — "remember X" saves a fact,
 * "what's X" / "do you remember X" recalls it later, even after the
 * server restarts. Stored as a flat JSON file on disk (not in browser
 * localStorage like the API key), since it's server-side state that
 * should survive across devices hitting the same local server.
 */

interface MemoryFact {
  key: string;
  value: string;
  savedAt: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const MEMORY_FILE = path.join(DATA_DIR, "memory.json");

function loadAll(): MemoryFact[] {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // File doesn't exist yet, or is corrupt — start fresh either way.
    return [];
  }
}

function saveAll(facts: MemoryFact[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(facts, null, 2), "utf-8");
}

/**
 * Saves (or overwrites) a fact under a short label. Re-remembering the
 * same label updates it rather than piling up duplicates, so "remember my
 * wifi password is X" said twice just keeps the latest value.
 */
export function rememberFact(key: string, value: string): string {
  const normalizedKey = key.trim();
  if (!normalizedKey) throw new Error("I need something to label this memory with.");
  if (!value.trim()) throw new Error("I need something to actually remember.");

  const facts = loadAll();
  const existingIdx = facts.findIndex(
    (f) => f.key.toLowerCase() === normalizedKey.toLowerCase(),
  );
  const fact: MemoryFact = {
    key: normalizedKey,
    value: value.trim(),
    savedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    facts[existingIdx] = fact;
  } else {
    facts.push(fact);
  }
  saveAll(facts);
  return `Got it — I'll remember that ${normalizedKey} is ${fact.value}.`;
}

/**
 * Recalls facts matching a query (checked against both the label and the
 * saved value, either direction — "wifi" matches a fact labeled "wifi
 * password", and "what's my password" loosely matches too). An empty
 * query lists everything saved.
 */
export function recallFacts(query?: string): string {
  const facts = loadAll();
  if (facts.length === 0) {
    return "I don't have anything saved in memory yet.";
  }

  const q = query?.trim().toLowerCase() ?? "";
  if (!q) {
    return facts.map((f) => `${f.key}: ${f.value}`).join(". ");
  }

  const matches = facts.filter(
    (f) =>
      f.key.toLowerCase().includes(q) ||
      q.includes(f.key.toLowerCase()) ||
      f.value.toLowerCase().includes(q),
  );

  if (matches.length === 0) {
    return `I don't have anything saved about "${query}".`;
  }
  return matches.map((f) => `${f.key}: ${f.value}`).join(". ");
}

/**
 * Deletes a saved fact by label. Explicit-only — nothing else in the app
 * ever removes a memory on its own.
 */
export function forgetFact(key: string): string {
  const facts = loadAll();
  const normalizedKey = key.trim().toLowerCase();
  const filtered = facts.filter((f) => f.key.toLowerCase() !== normalizedKey);

  if (filtered.length === facts.length) {
    throw new Error(`I don't have anything saved under "${key}".`);
  }
  saveAll(filtered);
  return `Forgot what I knew about ${key}.`;
}
