import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  openApp,
  openUrl,
  playSongOnYouTube,
  openWhatsAppChat,
  openBrowserSearch,
  closeLastOpened,
  pausePlayLastOpened,
  minimizeLastOpened,
  getSystemStatus,
  getWeather,
  getTimeInfo,
} from "@/lib/systemActions";
import { rememberFact, recallFacts, forgetFact } from "@/lib/memoryStore";
import { sendEmail, type EmailConfig } from "@/lib/emailActions";
import { readForegroundWindow } from "@/lib/screenReader";
import { writeIntoEditor, type EditorTarget } from "@/lib/documentWriter";
import { writeCodeFile } from "@/lib/codeWriter";
import { copySingleFile, copyAllFiles } from "@/lib/fileOps";
import { appendHistoryEntry, readHistoryLog, appendOverviewToLog, todayDateString } from "@/lib/historyLog";
import {
  startWindowDrag,
  stopWindowDrag,
  startCameraDragSession,
  stopCameraDragSession,
} from "@/lib/windowDragControl";

export const runtime = "nodejs";

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Lightweight web search using DuckDuckGo's HTML endpoint — no API key
 * required. Good enough to ground Gemini's answer with a few live results.
 * `freshness` ("d"/"w"/"m") biases toward results from the last day/week/
 * month — used by the news briefing below, where "latest" actually means
 * something; omitted for a plain one-off web_search.
 */
async function webSearch(query: string, freshness?: "d" | "w" | "m", limit = 5): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (freshness) params.set("df", freshness);

  const res = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!res.ok) return [];
  const html = await res.text();

  const results: SearchResult[] = [];
  const blockRegex =
    /<a rel="nofollow" class="result__a" href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(html)) && results.length < limit) {
    let url = match[1];
    const uddgMatch = url.match(/uddg=([^&]+)/);
    if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);

    results.push({
      url,
      title: stripTags(match[2]),
      snippet: stripTags(match[3]),
    });
  }

  return results;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Pulls current headlines from Google News' RSS feed — either its general
 * top-stories feed, or a topic search feed if the user named a
 * country/region/subject. Deliberately NOT built on the DuckDuckGo HTML
 * scrape above: that endpoint's date-filter parameter tends to return a
 * differently-structured (or rate-limited/empty) page that the scraping
 * regex can't parse, which silently produced zero results for every news
 * request. An RSS feed is structured data made for exactly this — no
 * markup-guessing involved — and Google News' own editorial ranking
 * already does the "what are today's top stories" job a raw web search
 * doesn't.
 */
async function fetchWorldNews(topic?: string): Promise<SearchResult[]> {
  const trimmedTopic = topic?.trim();
  const url = trimmedTopic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(trimmedTopic)}&hl=en-US&gl=US&ceid=US:en`
    : `https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });
  if (!res.ok) return [];

  const xml = await res.text();
  const items: SearchResult[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;

  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) && items.length < 8) {
    const block = m[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    if (!titleMatch || !linkMatch) continue;

    const rawTitle = decodeXmlEntities(titleMatch[1]);
    // Google News titles arrive as "Headline - Source Name" — split that
    // off so the headline itself is clean, keeping the source separately.
    const dashIdx = rawTitle.lastIndexOf(" - ");
    const headline = dashIdx > 0 ? rawTitle.slice(0, dashIdx).trim() : rawTitle;
    const source = dashIdx > 0 ? rawTitle.slice(dashIdx + 3).trim() : "";

    items.push({
      title: headline,
      snippet: source ? `via ${source}` : "",
      url: decodeXmlEntities(linkMatch[1]),
    });
  }

  return items;
}

// Google periodically retires Gemini model ids, and the free tier's daily
// request quota is tracked *per model*, not shared across models. So the
// fallback chain now advances on BOTH 404 (model retired) and 429 (that
// specific model's quota is exhausted) — a model hitting its daily cap no
// longer hard-breaks the app as long as at least one model in the list
// still has quota left.
const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"];

// Attachment analysis reuses the same fallback chain as everything else
// (GEMINI_MODELS) — all of these support inline image/PDF input, and
// keeping one list means a model Google retires only needs updating once.

async function callGeminiModel(
  apiKey: string,
  model: string,
  prompt: string,
  maxOutputTokens?: number,
): Promise<{ ok: true; text: string } | { ok: false; status: number; body: string }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        // Only set when a caller explicitly asks for more headroom (see
        // write_code/write_application below) — omitted otherwise so
        // every existing call keeps using the API's own default exactly
        // as before, with no risk of newly capping something that
        // previously had no limit at all.
        ...(maxOutputTokens ? { generationConfig: { maxOutputTokens } } : {}),
      }),
    },
  );

  if (!res.ok) {
    return { ok: false, status: res.status, body: await res.text() };
  }

  const data = await res.json();
  const text =
    data.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "")
      .join("") ?? "";

  return { ok: true, text: text.trim() || "(No response from Gemini.)" };
}

/** Pulls the RetryInfo.retryDelay Google sends back on a 429 (e.g. "13s"),
 * so a short transient rate-limit can be waited out instead of immediately
 * giving up on a model that has plenty of daily quota left. */
function parseRetryDelaySeconds(body: string): number | null {
  try {
    const parsed = JSON.parse(body);
    const details = parsed?.error?.details;
    if (!Array.isArray(details)) return null;
    const retryInfo = details.find((d: { "@type"?: string }) =>
      d["@type"]?.includes("RetryInfo"),
    );
    const delay = retryInfo?.retryDelay as string | undefined;
    if (!delay) return null;
    const match = delay.match(/^([\d.]+)s$/);
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

async function callGemini(apiKey: string, prompt: string, maxOutputTokens?: number): Promise<string> {
  let lastResult: { status: number; body: string } | null = null;

  for (const model of GEMINI_MODELS) {
    let result = await callGeminiModel(apiKey, model, prompt, maxOutputTokens);

    // On a rate limit, honor Google's suggested retry delay and try this
    // SAME model once more (capped at 15s so a slow reply doesn't hang the
    // whole request) before giving up on it and moving to the next model.
    if (!result.ok && result.status === 429) {
      const delaySec = parseRetryDelaySeconds(result.body);
      if (delaySec !== null && delaySec <= 15) {
        await new Promise((r) => setTimeout(r, delaySec * 1000));
        result = await callGeminiModel(apiKey, model, prompt, maxOutputTokens);
      }
    }

    if (result.ok) return result.text;

    lastResult = result;
    // 404 = model retired/unknown, 429 = this model's quota is exhausted —
    // both mean "try the next model in the list" rather than failing hard.
    if (result.status !== 404 && result.status !== 429) break;
  }

  if (!lastResult) {
    throw new Error("Gemini API call failed for an unknown reason.");
  }

  if (lastResult.status === 429) {
    throw new Error(
      "All available Gemini models have hit their free-tier daily quota right now. " +
        "Wait a bit and try again, or add billing at https://aistudio.google.com/apikey to raise the limit.",
    );
  }
  if (lastResult.status === 401 || lastResult.status === 403) {
    throw new Error("Gemini rejected the API key — double-check it in Settings.");
  }

  throw new Error(`Gemini API error (${lastResult.status}): ${lastResult.body}`);
}

// ——— Attachment analysis ———
// A file/image the user attached from the COMMAND panel (separate from the
// bare-filename lookup in emailActions.ts, which only searches a fixed set
// of local folders for something to attach to an OUTGOING email). Images
// and PDFs go to Gemini as inline binary data so it can actually "look" at
// them; anything else is treated as text (source code, .txt, .csv, .json,
// .md, etc.) — if it doesn't decode as readable text, that's reported
// honestly instead of feeding Gemini garbage bytes.
const MAX_ATTACHMENT_TEXT_CHARS = 20000;

async function callGeminiVision(
  apiKey: string,
  mimeType: string,
  base64Data: string,
  prompt: string,
): Promise<string> {
  let lastErr: string | null = null;

  for (const model of GEMINI_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ inlineData: { mimeType, data: base64Data } }, { text: prompt }],
            },
          ],
        }),
      },
    );

    if (res.ok) {
      const data = await res.json();
      const text =
        data.candidates?.[0]?.content?.parts
          ?.map((p: { text?: string }) => p.text ?? "")
          .join("") ?? "";
      if (text.trim()) return text.trim();
      lastErr = "empty response";
      continue;
    }

    lastErr = await res.text();
    if (res.status !== 404 && res.status !== 429) break;
  }

  throw new Error(`Couldn't analyze that file with Gemini: ${lastErr ?? "unknown error"}`);
}

/** Rough heuristic: decoded text is "readable" if it's mostly printable
 * characters, so a binary file (image the browser mis-typed, a zip, etc.)
 * that slips past the mimeType check doesn't get silently mangled into
 * the prompt as noise. */
function looksLikeText(s: string): boolean {
  if (!s) return false;
  let printable = 0;
  const sample = s.slice(0, 4000);
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 0xd800) || code > 0xdfff) printable++;
  }
  return printable / sample.length > 0.95;
}

/**
 * Produces a text description of an attached file the classify prompt can
 * reason over — either a Gemini vision analysis (images/PDFs) or the raw
 * decoded text (everything else that's actually readable text).
 */
async function describeAttachment(
  apiKey: string,
  name: string,
  mimeType: string,
  base64Data: string,
): Promise<string> {
  const isVisual = mimeType.startsWith("image/") || mimeType === "application/pdf";

  if (isVisual) {
    const prompt =
      `Describe this file ("${name}") thoroughly: what it shows/contains, any visible text, ` +
      `and notable facts someone would want to know.\n\n` +
      `Then include a section starting with "TEXT:" on its own line, containing a verbatim, ` +
      `exact transcription of ALL readable/printed/handwritten text visible in the file — ` +
      `preserve the original line breaks, order, and layout as closely as plain text allows, ` +
      `and don't summarize, correct, or omit any of it. If there is no readable text at all, ` +
      `write exactly "TEXT: (no readable text found)".\n\n` +
      `Then on a final line starting with "KEYWORDS:", give 4-6 short comma-separated terms ` +
      `someone could use to search the web for more information about this specific subject.`;
    return await callGeminiVision(apiKey, mimeType, base64Data, prompt);
  }

  let decoded: string;
  try {
    decoded = Buffer.from(base64Data, "base64").toString("utf-8");
  } catch {
    return `(Couldn't read "${name}" — it doesn't appear to be a text file, and isn't an image or PDF either.)`;
  }

  if (!looksLikeText(decoded)) {
    return `(Attached "${name}" (${mimeType || "unknown type"}) — this looks like a binary file ULTRON can't read as text.)`;
  }

  const truncated = decoded.length > MAX_ATTACHMENT_TEXT_CHARS;
  const body = truncated ? decoded.slice(0, MAX_ATTACHMENT_TEXT_CHARS) : decoded;
  return `Contents of "${name}"${truncated ? " (truncated — showing the first part)" : ""}:\n\n${body}`;
}


// ——— Intent classification ———
// One Gemini call decides *what to do*, then we execute it on the server.
// The action set is a closed list, and every action either goes through a
// fixed allowlist (openApp) or gets validated (openUrl) — the model can
// steer *which* of these run, never run arbitrary commands.

type Action =
  | { action: "chat"; reply: string }
  | { action: "web_search"; query: string }
  | { action: "open_app"; app: string }
  | { action: "open_url"; url: string; label?: string }
  | { action: "play_song"; query: string }
  | {
      action: "send_whatsapp";
      phone: string;
      message: string;
    }
  | { action: "close_window" }
  | { action: "pause_video" }
  | { action: "minimize_window" }
  | { action: "system_status" }
  | { action: "weather"; location?: string }
  | { action: "time" }
  | { action: "browser_search"; query: string }
  | { action: "remember"; key: string; value: string }
  | { action: "recall"; query?: string }
  | { action: "forget"; key: string }
  | { action: "window_drag"; mode: "on" | "off" | "title_bar_only" }
  | { action: "camera_window_drag"; mode: "on" | "off" | "title_bar_only" }
  | {
      action: "send_email";
      to: string;
      subject?: string;
      message: string;
      attachment?: string;
    }
  | { action: "read_screen"; question?: string }
  | {
      action: "write_application";
      type: string;
      details?: string;
      target?: "notepad" | "wordpad";
    }
  | { action: "write_code"; description: string; language?: string }
  | { action: "world_news"; topic?: string }
  | { action: "set_reminder"; task: string; delaySeconds: number }
  | { action: "copy_files"; file: string; from?: string; to: string }
  | { action: "history_report"; date?: string }
  | { action: "barrel_roll" };

interface HistoryTurn {
  role: "user" | "assistant";
  text: string;
}

const CLASSIFY_PROMPT = (
  message: string,
  history: HistoryTurn[],
  attachmentName?: string,
  attachmentContext?: string,
) => `You are ULTRON, a voice-controlled computer assistant. The current date and time (the user's own local time, since this runs on their machine) is: ${new Date().toString()}. Read the conversation so far plus the user's newest message, and reply with ONLY a single raw JSON object (no markdown fences, no explanation) matching exactly one of these shapes:

{"action":"chat","reply":"<short, direct, spoken-style answer to the user's message>"}
{"action":"web_search","query":"<what to search for>"}
{"action":"open_app","app":"<one of: notepad, calculator, paint, explorer, cmd, task manager, wordpad>"}
{"action":"open_url","url":"<a full https:// URL>","label":"<short site name, e.g. YouTube>"}
{"action":"play_song","query":"<song name and artist if known>"}
{"action":"send_whatsapp","phone":"<digits only with country code, no + or spaces>","message":"<message text>"}
{"action":"close_window"}
{"action":"pause_video"}
{"action":"minimize_window"}
{"action":"system_status"}
{"action":"weather","location":"<city name if the user named one, otherwise omit or leave empty>"}
{"action":"time"}
{"action":"browser_search","query":"<what to search for in an actual browser tab>"}
{"action":"remember","key":"<short label for this fact, e.g. 'wifi password', 'mom's birthday'>","value":"<the actual information to save>"}
{"action":"recall","query":"<what they're asking about — a guess at the label or content, empty string to recall everything saved>"}
{"action":"forget","key":"<the label of the saved fact to delete>"}
{"action":"window_drag","mode":"<one of: on, off, title_bar_only>"}
{"action":"camera_window_drag","mode":"<one of: on, off, title_bar_only>"}
{"action":"send_email","to":"<recipient email address>","subject":"<short subject line — invent a sensible one if the user didn't give one>","message":"<the email body, in the user's words>","attachment":"<bare filename if the user asked to attach/send a file, e.g. 'index.html' — otherwise omit>"}
{"action":"read_screen","question":"<the user's specific question about what's on screen, if any — otherwise omit for a general read-aloud/summary>"}
{"action":"write_application","type":"<kind of document, e.g. 'medical leave application', 'resignation letter', 'leave request'>","details":"<any specifics the user gave — name, dates, reason, recipient, company — otherwise omit>","target":"<'wordpad' ONLY if the user explicitly asked for WordPad — otherwise omit, defaults to Notepad>"}
{"action":"write_code","description":"<what to build, in the user's own words, e.g. 'a login page', 'a python script that renames files in a folder'>","language":"<language/framework ONLY if the user named one, e.g. 'python', 'react' — otherwise omit and let ULTRON pick the best fit>"}
{"action":"world_news","topic":"<a country, region, or subject to focus on, e.g. 'Pakistan', 'technology', 'cricket' — otherwise omit for general top world headlines>"}
{"action":"set_reminder","task":"<what to remind the user about, e.g. 'eat burger', 'call mom'>","delaySeconds":<a positive whole number of seconds from RIGHT NOW until the reminder should fire — work this out yourself from the current date/time given above and what the user said, e.g. "after 8 min" = 480, "in half an hour" = 1800, "at 5pm" = however many seconds from now that is>}
{"action":"copy_files","file":"<a bare filename, e.g. 'report.pdf' — OR the literal words 'all files' if the user means every file in a folder>","from":"<source folder name, e.g. 'Desktop', 'Downloads' — REQUIRED when file is 'all files'; omit for a single named file (ULTRON searches common locations itself)>","to":"<destination folder name, e.g. 'Desktop', 'Documents', or a new folder name to create — always required>"}
{"action":"history_report","date":"<YYYY-MM-DD ONLY if the user named a specific day other than today — otherwise omit for today>"}
{"action":"barrel_roll"}

IMPORTANT — multi-turn requests: the user often gives an email/WhatsApp request across SEVERAL messages instead of one ("send an email" -> "to hm@gmail.com" -> "say how are you"). Use the conversation history below to collect every piece (recipient, body, attachment) mentioned across ALL turns, not just the newest message. Once a recipient AND a body have been given at ANY point in this conversation and haven't already been sent, emit the completed send_email/send_whatsapp action rather than asking again — do not keep re-asking for a piece of information the user already gave in an earlier turn. Only fall back to "chat" and ask a clarifying question if something is still genuinely missing after considering the whole history. If a message is just a bare email address or phone number with no other content, treat it as the missing recipient for whatever email/WhatsApp request was already in progress, not as a new stand-alone request.

Rules:
${
  attachmentContext
    ? `- The user has attached a file — see "Attached file" below. If their message asks what it is, to explain/summarize/read/describe it, or gives no separate instruction at all (they just attached it) -> answer directly and thoroughly via chat, using the attached file's content. If their message asks to CONVERT/EXTRACT the text, or asks what the text SAYS ("convert this image into text", "extract the text from this", "give me the text in this image", "OCR this", "what does the text say", "read out the text") -> answer via chat with ONLY the verbatim content of the file's "TEXT:" section, exactly as given there (plain text, preserving its line breaks) — no summary, no extra commentary, no markdown. If their message asks to search/look this up/find more about it on the web ("search the web about this", "look this up", "find more info on this") -> use browser_search with a specific, well-formed query built from the file's actual content/subject (use its KEYWORDS if given) — never a vague query like "this file" or "this image". If they ask to email it, use send_email with the attachment field set to the attached file's own name. Otherwise treat their message normally, using the file as extra context if relevant.\n`
    : ""
}
- Opening a website (YouTube, Google, Gmail, GitHub, etc.) -> open_url with the correct https URL.
- Opening a desktop app (notepad/calculator/paint/file explorer/command prompt/task manager/wordpad) -> open_app.
- Playing a song or music -> play_song.
- Sending a WhatsApp message where a phone number and message text have been given (across this turn or earlier ones) -> send_whatsapp. Only ask (via chat) for whichever piece is still missing.
- Sending an email where a recipient address and body text have been given (across this turn or earlier ones — "send email to x@y.com saying hi", or "send an email" then later "to john@x.com" then later "say I'm running late") -> send_email. If the user also asked to attach/send a specific file by name at any point ("send index.html on that email", "attach report.pdf") -> include it as "attachment" (bare filename only, no path). Only ask (via chat) for whichever piece — recipient or message — is still missing; never invent an email address.
- User wants ULTRON to look at, read aloud, summarize, or answer a question about whatever is CURRENTLY OPEN and visible on their screen — a webpage, a ChatGPT/Claude conversation, a Google results page, an article, a document, anything in the focused window ("read the current window", "read this to me", "what does this say", "summarize what's on screen", "what is chatgpt saying", "explain this page") -> read_screen. Put their specific question in "question" if they asked one (e.g. "what does this say about X"); omit it for a plain read-aloud/summary. This is different from web_search, which looks something up online — read_screen only reads what's ALREADY open in front of the user.
- User wants ULTRON to WRITE/DRAFT some kind of formal application, letter, or request and have it opened ready to use — medical leave, a leave/vacation request, a resignation letter, a complaint letter, a job application cover letter, a permission request, anything of that shape ("write a medical leave application", "write me a leave request for tomorrow", "draft a resignation letter", "write an application for two days leave, I'm Hussain, reason is fever") -> write_application. Put the kind of document in "type" (e.g. "medical leave application") and any specifics the user gave — name, dates, reason, recipient, company — in "details" as free text; omit "details" if they gave none (still write it, using sensible placeholders — never ask a clarifying question for this one, just draft it). Only set "target" to "wordpad" if the user explicitly named WordPad/Word; otherwise omit it.
- User wants ULTRON to WRITE CODE for something and have it opened in VS Code, ready to run/edit — a webpage, a script, a function, a login page, an API, a game, anything code-shaped ("write a code of login page", "write me a python script to rename files", "create a react login form", "build a simple calculator app") -> write_code. Put what they want built in "description", in their own words. Only set "language" if they explicitly named a language/framework (e.g. "python", "react", "html"); otherwise omit it and let ULTRON pick the most sensible one for the request. Never ask a clarifying question for this one — just build it with reasonable defaults.
- User wants a NEWS BRIEFING — today's/the latest world news, "what's happening right now", headlines about a specific country/region/subject ("give me the latest world news", "what's happening in the world today", "news about Pakistan", "any tech news today") -> world_news. Put the country/region/subject in "topic" only if they explicitly named one; omit it for general top world headlines. This is different from web_search (which answers ONE specific question with one answer) — world_news returns several distinct fresh headlines as a briefing.
- Any general-knowledge question — facts, definitions, how something works, history, science, geography, "who was X", "what is Y" — is answered directly and confidently via chat using what you already know. Don't reach for web_search just because a question sounds factual; only use web_search when the answer genuinely depends on something that changes over time (current prices, who currently holds some position, recent/breaking events, "as of today") or that you plainly don't know.
- User wants to be reminded of something after a delay or at a specific time ("remind me to eat burger in 8 minutes", "after 8 min remind me to eat burger", "remind me at 5pm to call mom") -> set_reminder. Put what to remind them of in "task". Compute "delaySeconds" yourself using the current date/time given at the top of this prompt — for a relative delay ("in 8 minutes", "after half an hour") just convert it to seconds; for an absolute time ("at 5pm", "at 9:30 tomorrow morning") work out how many seconds from right now that moment is (if that time has already passed today, assume they mean the next occurrence of it). If the user gave no timing at all (just "remind me to eat"), use chat and ask when instead of guessing.
- User wants ULTRON to copy/paste file(s) from one place to another — a specific file, or every file in a folder ("copy index.html to desktop", "copy all files from downloads to desktop", "select all files and paste them to my documents", "copy report.pdf to a folder called Backup", "select all files in this window and paste them on desktop") -> copy_files. Put the filename in "file" (or the literal words "all files" if they mean every file in a folder). Put the source folder name in "from" ONLY if named — REQUIRED when "file" is "all files" (ask via chat instead of guessing if it's missing in that case); omit "from" for a single specific file, since ULTRON searches common locations for it itself. "to" (the destination) is always required — if missing, ask via chat rather than guessing. For either "from" or "to", if the user refers to whatever folder/window is currently open/focused rather than naming one ("this window", "the current window", "this folder"), pass that phrase through literally (e.g. "current window") rather than guessing a real folder name — ULTRON resolves that specially.
- User wants a summary/report/overview of what they asked ULTRON to do — today or a past day — or explicitly wants that day's activity saved to a file ("give me history of today", "save history of today", "what did I do today", "aaj ka overview do", "aaj main ne kya kya kaam kiya", "show me yesterday's history", "history for 15 august") -> history_report. Every command/reply ULTRON handles is already being saved automatically to a dated .txt file in the project's own history/ folder — this action reads that day's saved log, writes an organized overview back into the same file, and replies with that overview. Omit "date" for "today"; only set it (as "YYYY-MM-DD", worked out from the current date/time given above) when the user names a specific other day like "yesterday" or a calendar date.
- User wants ULTRON to do a barrel roll of the screen ("do a barrel roll", "do a barrel roll of the current screen", "barrel roll", "spin the screen around", "flip the screen") -> barrel_roll. This is a pure visual flourish with no other fields — never confuse it with the hand-gesture "spin" mode (that's real-time camera control, not a one-off command like this).
- Closing, stopping, or dismissing whatever's focused right now ("close youtube", "close it", "close that", "close this tab", "close notepad", "close the browser") -> close_window. Works globally on whatever window currently has focus — Notepad, File Explorer, VLC, a browser tab, anything — not just something ULTRON itself opened, and only ever touches that one window.
- Pausing or resuming whatever's playing in the currently focused window ("pause the video", "pause it", "resume the video", "play it again") -> pause_video. Works for a browser tab or a desktop media player like VLC.
- Minimizing whatever window currently has focus ("minimize it", "minimize the screen", "minimize youtube", "minimize notepad") -> minimize_window.
- Asking about CPU, RAM, memory, disk space, uptime, or general "how's my system/PC doing" -> system_status.
- Asking about weather, temperature, or forecast -> weather. Put the city in "location" only if the user actually named one; otherwise omit it so it falls back to the user's own location.
- Asking what time it is, or today's date -> time.
- Wanting an actual browser tab opened with search results for something ("search for X in the browser", "google X", "look up X on the web") -> browser_search. Use web_search instead only when the user wants a spoken/typed answer without a tab opening.
- User explicitly asking ULTRON to remember/save/note something for later ("remember my wifi password is X", "remember that my anniversary is on Y", "note this down") -> remember. Pick a short sensible label for "key" and put the actual info in "value". Only use this when the user clearly wants it saved for future recall — not for information they're just mentioning in passing.
- User asking ULTRON to recall something previously saved ("what's my wifi password", "do you remember...", "what did I tell you about X") -> recall, with your best guess at the label/content as "query" (empty string if they're asking "what do you remember" in general).
- User explicitly asking to forget/delete/remove a saved memory ("forget my wifi password", "delete what you know about X") -> forget, with the label to remove.
- Turning ON one-finger window dragging (letting the user press and slide a window like Chrome/Notepad/File Explorer to move it) -> window_drag mode "on". This defaults to allowing the drag to start from anywhere on the window, not just the title bar.
- Restricting dragging to start ONLY from a window's title bar (e.g. because body-dragging is interfering with normal clicking/dragging inside apps) -> window_drag mode "title_bar_only".
- Turning window dragging OFF -> window_drag mode "off".
- Turning ON *camera/hand-pinch* window dragging specifically ("start window drag mode", "let me drag windows with my hand", "camera window drag on", "drag windows with a pinch") -> camera_window_drag mode "on". This is different from window_drag: it's driven by the webcam pinch gesture instead of the physical mouse/touch, and it defaults to allowing the drag to start from anywhere on the window.
- Restricting camera-driven dragging to a window's title bar only -> camera_window_drag mode "title_bar_only".
- Turning camera-driven window dragging OFF ("stop window drag mode", "stop camera drag") -> camera_window_drag mode "off".
- Anything else needing current/live info (news, prices, recent events, or an explicit "search for..." without wanting a browser tab) -> web_search.
- Everything else -> chat, answered directly and concisely.
- Output raw JSON only. No backticks, no prose before or after.

${
  attachmentContext
    ? `Attached file: "${attachmentName ?? "attachment"}"\n${attachmentContext}\n\n`
    : ""
}${
  history.length
    ? `Conversation so far (oldest to newest):\n${history
        .map((h) => `${h.role === "user" ? "User" : "ULTRON"}: ${h.text}`)
        .join("\n")}\n\n`
    : ""
}Newest user message: ${JSON.stringify(message)}`;

function parseAction(raw: string): Action | null {
  const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed.action === "string") return parsed as Action;
  } catch {
    // fall through
  }
  return null;
}

function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins
    ? `${hrs} hour${hrs === 1 ? "" : "s"} ${remMins} minute${remMins === 1 ? "" : "s"}`
    : `${hrs} hour${hrs === 1 ? "" : "s"}`;
}

async function runAction(
  apiKey: string,
  action: Action,
  emailConfig?: EmailConfig,
): Promise<{
  text: string;
  sources?: SearchResult[];
  cameraDragMode?: boolean;
  reminder?: { task: string; delaySeconds: number };
  effect?: "barrel_roll";
}> {
  switch (action.action) {
    case "chat":
      return { text: action.reply };

    case "barrel_roll":
      return { text: "Doing a barrel roll! 🌀", effect: "barrel_roll" };

    case "web_search": {
      const sources = await webSearch(action.query);
      const context = sources.length
        ? sources.map((s, i) => `${i + 1}. ${s.title} — ${s.snippet} (${s.url})`).join("\n")
        : "(No search results found.)";
      const prompt =
        `You are ULTRON, a concise voice assistant. Use these live web search ` +
        `results to answer the user's question. Mention key facts and cite ` +
        `sources briefly by number.\n\nSearch results:\n${context}\n\n` +
        `User question: ${action.query}`;
      const text = await callGemini(apiKey, prompt);
      return { text, sources };
    }

    case "open_app": {
      await openApp(action.app);
      return { text: `Opening ${action.app}.` };
    }

    case "open_url": {
      await openUrl(action.url, action.label);
      return { text: `Opening ${action.label || action.url}.` };
    }

    case "play_song": {
      await playSongOnYouTube(action.query);
      return { text: `Playing ${action.query} on YouTube.` };
    }

    case "send_whatsapp": {
      await openWhatsAppChat(action.phone, action.message);
      return {
        text: `Opened WhatsApp with ${action.phone} — your message is typed in, press Enter to send it.`,
      };
    }

    case "close_window": {
      const text = await closeLastOpened();
      return { text };
    }

    case "pause_video": {
      const text = await pausePlayLastOpened();
      return { text };
    }

    case "minimize_window": {
      const text = await minimizeLastOpened();
      return { text };
    }

    case "system_status":
      return { text: getSystemStatus() };

    case "weather": {
      const text = await getWeather(action.location);
      return { text };
    }

    case "time":
      return { text: getTimeInfo() };

    case "browser_search": {
      await openBrowserSearch(action.query);
      return { text: `Searching for "${action.query}" in your browser.` };
    }

    case "remember": {
      const text = rememberFact(action.key, action.value);
      return { text };
    }

    case "recall": {
      const text = recallFacts(action.query);
      return { text };
    }

    case "forget": {
      const text = forgetFact(action.key);
      return { text };
    }

    case "window_drag": {
      const text =
        action.mode === "off" ? await stopWindowDrag() : await startWindowDrag(action.mode !== "title_bar_only");
      return { text };
    }

    case "camera_window_drag": {
      if (action.mode === "off") {
        const text = await stopCameraDragSession();
        return { text, cameraDragMode: false };
      }
      const text = await startCameraDragSession(action.mode !== "title_bar_only");
      return { text, cameraDragMode: true };
    }

    case "send_email": {
      const text = await sendEmail(emailConfig, action.to, action.subject ?? "", action.message, action.attachment);
      return { text };
    }

    case "read_screen": {
      const result = await readForegroundWindow();
      if (!result) {
        throw new Error(
          "I couldn't read anything from the current window — make sure it's focused (click into it) and try again.",
        );
      }

      const question = action.question?.trim();
      const prompt = question
        ? `You are ULTRON, a concise voice assistant. The user is looking at a window titled "${result.windowTitle}". Here is the visible text from that window:\n\n${result.text}\n\nUsing that text, answer this question in a short, direct, spoken-style way: ${question}`
        : `You are ULTRON, a concise voice assistant. Here is the visible text from the user's window titled "${result.windowTitle}":\n\n${result.text}\n\nSummarize it in a short, natural, spoken-style way, as if reading/explaining what's on screen to the user.`;

      const answer = await callGemini(apiKey, prompt);
      const text = result.truncated
        ? `${answer} That window had more text than I could take in at once, so this covers what fit.`
        : answer;
      return { text };
    }

    case "write_application": {
      const docType = action.type.trim() || "application";
      const details = action.details?.trim();
      const target: EditorTarget = action.target === "wordpad" ? "wordpad" : "notepad";

      const draftPrompt = `You are ULTRON, drafting a complete, ready-to-submit "${docType}" for the user.
${
  details
    ? `Use these details the user gave, exactly as given: ${details}`
    : "The user didn't give further details. Use sensible bracketed placeholders — [Your Name], [Date], [Reason], [Recipient's Name] — instead of inventing false specifics."
}
Use standard formal-letter formatting: today's date at the top, a "To," / recipient line (a sensible placeholder if unknown), a clear subject line, a polite formal body appropriate to a "${docType}", and a closing with a signature line.
Output ONLY the finished letter text — plain text, no markdown formatting, no asterisks or headers, no backticks, no commentary before or after.`;

      const documentText = await callGemini(apiKey, draftPrompt, 4096);
      if (!documentText.trim() || documentText.trim() === "(No response from Gemini.)") {
        throw new Error("Gemini didn't return any text for that letter — try asking again.");
      }
      await writeIntoEditor(target, documentText);

      const appName = target === "wordpad" ? "WordPad" : "Notepad";
      return { text: `Opened ${appName} and wrote up your ${docType} — take a look and fill in any placeholders.` };
    }

    case "write_code": {
      const desc = action.description.trim() || "the requested code";
      const lang = action.language?.trim();

      const codePrompt = `You are ULTRON, a coding assistant. Write complete, clean, working code for: "${desc}"${lang ? ` using ${lang}` : ""}.
Keep it to ONE self-contained file (e.g. an HTML page with its CSS and JS inline, or a single script) rather than a multi-file project, unless the request is impossible to do that way.
Respond in EXACTLY this format and nothing else — no markdown fences, no explanation before or after:
FILENAME: <a suitable filename with extension, e.g. login.html or rename_files.py>
---CODE---
<the complete file contents, starting on the next line>`;

      const raw = await callGemini(apiKey, codePrompt, 8192);
      const marker = "---CODE---";
      const markerIdx = raw.indexOf(marker);
      if (markerIdx === -1) {
        throw new Error("I couldn't generate that code — try rephrasing what you'd like built.");
      }

      const header = raw.slice(0, markerIdx);
      const codeBody = raw.slice(markerIdx + marker.length).replace(/^\s*\n/, "");
      // The exact bug this guards against: the marker came through but the
      // response was cut off (or the model produced nothing) right after
      // it, which used to silently create an empty file. Fail loudly
      // instead so the user knows to retry rather than finding an empty
      // file in VS Code.
      if (!codeBody.trim()) {
        throw new Error(
          "Gemini didn't return any actual code for that — it may have been too big for one response. Try asking for something more specific, or break it into smaller pieces.",
        );
      }
      const filenameMatch = header.match(/FILENAME:\s*(.+)/i);
      const filename = filenameMatch?.[1]?.trim() || "untitled.txt";

      const written = await writeCodeFile(filename, codeBody.trimEnd() + "\n");
      return { text: `Opened VS Code and wrote ${written.filename} for you — take a look.` };
    }

    case "world_news": {
      const sources = await fetchWorldNews(action.topic);
      const context = sources.length
        ? sources.map((s, i) => `${i + 1}. ${s.title}${s.snippet ? ` (${s.snippet})` : ""} — ${s.url}`).join("\n")
        : "(No fresh results found.)";
      const topic = action.topic?.trim();

      const prompt =
        `You are ULTRON, giving the user a short spoken news briefing${topic ? ` focused on ${topic}` : ""}. ` +
        `Using ONLY these live search results, summarize today's most important, DISTINCT headlines: 4-6 separate ` +
        `items, each just one or two short plain sentences, spoken style (no markdown, no bullet symbols, no headers), ` +
        `mentioning the source briefly by name where it reads naturally. If the results don't actually contain real, ` +
        `current news (e.g. they're generic or clearly outdated), say so honestly instead of inventing headlines.\n\n` +
        `Search results:\n${context}`;

      const text = await callGemini(apiKey, prompt, 2048);
      return { text, sources };
    }

    case "set_reminder": {
      const task = action.task.trim() || "your reminder";
      // Clamp to a sane range: at least 1 second (a "delaySeconds": 0 from
      // a slightly-off model response shouldn't fire instantly with no
      // warning) and at most 24 hours (this is an in-memory browser timer,
      // not a persisted OS-level scheduled task — see useAssistant.ts — so
      // it can't reliably outlive a day-long wait anyway).
      const delaySeconds = Math.min(Math.max(1, Math.round(action.delaySeconds || 0)), 86400);
      const text = `Got it — I'll remind you to ${task} in ${formatDuration(delaySeconds)}.`;
      return { text, reminder: { task, delaySeconds } };
    }

    case "copy_files": {
      const fileSpec = action.file.trim();
      const to = action.to?.trim();
      if (!to) {
        throw new Error("Which folder should I copy it to?");
      }

      const isBulk = /^(all( the)? files|everything)$/i.test(fileSpec);

      if (isBulk) {
        const from = action.from?.trim();
        if (!from) {
          throw new Error("Which folder's files should I copy — e.g. Desktop or Downloads?");
        }
        const result = await copyAllFiles(from, to);
        return {
          text: `Copied ${result.copied.length} file${result.copied.length === 1 ? "" : "s"} from ${from} to ${result.destinationLabel}.`,
        };
      }

      const result = await copySingleFile(fileSpec, to);
      return { text: `Copied ${result.copied[0]} to ${result.destinationLabel}.` };
    }

    case "history_report": {
      const requestedDate = action.date?.trim();
      const dateStr = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : todayDateString();
      const log = readHistoryLog(dateStr);

      if (!log || !log.content.trim()) {
        return {
          text:
            dateStr === todayDateString()
              ? "There's nothing logged for today yet — once you give me a few commands I'll have something to report."
              : `I don't have any saved activity for ${dateStr}.`,
        };
      }

      const prompt =
        `You are ULTRON. Below is the raw, timestamped log of every command the user gave you on ` +
        `${log.date} and how you replied. Write a clear, well-organized overview of that day: what ` +
        `the user asked for and what you actually did (apps opened, emails sent, code written, things ` +
        `searched, files copied, etc.) — grouped naturally by topic/activity rather than a flat ` +
        `timestamp list, spoken/conversational style, as if briefing the user on their own day. Match ` +
        `the user's own language and tone from the log (e.g. reply in Roman Urdu/Hinglish if that's ` +
        `what they were writing in). Skip minor filler exchanges if the log has any; focus on what was ` +
        `actually accomplished.\n\nRaw log for ${log.date}:\n${log.content}`;

      const overview = await callGemini(apiKey, prompt, 4096);
      appendOverviewToLog(log.date, overview);
      return { text: overview };
    }

    default:
      return { text: "I'm not sure how to do that yet." };
  }
}

export async function POST(req: NextRequest) {
  let body: {
    message?: string;
    apiKey?: string;
    emailConfig?: EmailConfig;
    history?: HistoryTurn[];
    attachment?: { name: string; mimeType: string; data: string };
  };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { message, apiKey, emailConfig, history, attachment } = body;

  if ((!message || !message.trim()) && !attachment) {
    return NextResponse.json({ error: "Empty message." }, { status: 400 });
  }
  if (!apiKey || !apiKey.trim()) {
    return NextResponse.json(
      { error: "Missing Gemini API key. Add it in Settings first." },
      { status: 400 },
    );
  }

  try {
    let attachmentContext: string | undefined;
    if (attachment?.data && attachment?.mimeType) {
      attachmentContext = await describeAttachment(
        apiKey,
        attachment.name || "attachment",
        attachment.mimeType,
        attachment.data,
      );

      // Also drop a copy into data/shared so a later "email this to X" can
      // find it the same way any other locally-saved file is found (see
      // emailActions.ts's attachmentRoots) — the upload wasn't otherwise
      // saved anywhere on disk. Best-effort: a failure here (e.g. a name
      // with no safe characters left) shouldn't break the analysis itself.
      try {
        const safeName = (attachment.name || "attachment")
          .replace(/[/\\]/g, "_")
          .replace(/\.\./g, "_")
          .trim();
        if (safeName) {
          const sharedDir = path.join(process.cwd(), "data", "shared");
          fs.mkdirSync(sharedDir, { recursive: true });
          fs.writeFileSync(path.join(sharedDir, safeName), Buffer.from(attachment.data, "base64"));
        }
      } catch {
        // non-fatal — analysis still proceeds
      }
    }

    const raw = await callGemini(
      apiKey,
      CLASSIFY_PROMPT(
        message?.trim() || "Take a look at this file and tell me about it.",
        Array.isArray(history) ? history : [],
        attachment?.name,
        attachmentContext,
      ),
    );
    const action = parseAction(raw);

    // Every exchange gets logged to today's history/<date>.txt (see
    // lib/historyLog.ts) so "give me history of today" always has real
    // data, no matter how many times the app's been restarted since.
    const loggedUserText = attachment?.name
      ? `${message?.trim() ? `${message.trim()} ` : ""}[attached: ${attachment.name}]`
      : message?.trim() || "";

    // If classification failed to parse for any reason, just answer as chat
    // using the raw text so the user still gets a response.
    if (!action) {
      appendHistoryEntry(loggedUserText, raw);
      return NextResponse.json({ text: raw });
    }

    const result = await runAction(apiKey, action, emailConfig);
    // Skip re-logging a history_report's own reply — it's already written
    // into the day's file as a dedicated OVERVIEW block, and logging the
    // full overview text again here would just duplicate it on every ask.
    if (action.action !== "history_report") {
      appendHistoryEntry(loggedUserText, result.text);
    }
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
