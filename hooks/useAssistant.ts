"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "error";
  text: string;
}

export interface PendingAttachment {
  name: string;
  mimeType: string;
  /** Base64 payload, no "data:...;base64," prefix. */
  data: string;
  /** Data URL for rendering a thumbnail — images only. */
  previewUrl?: string;
  sizeBytes: number;
}

const API_KEY_STORAGE = "ultron_gemini_api_key";
const EMAIL_CONFIG_STORAGE = "ultron_email_config";

export interface EmailConfig {
  user: string;
  pass: string;
  host?: string;
  port?: number;
  secure?: boolean;
}

const EMPTY_EMAIL_CONFIG: EmailConfig = { user: "", pass: "" };

// Minimal typing for the Web Speech API — not in default TS lib.dom yet.
interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

// Spoken phrases that explicitly stop the continuous loop, so "listen until
// I tell you to stop" has a real voice-driven off-switch instead of only a
// button click. Matched as a whole trimmed utterance (case-insensitive) so
// it doesn't accidentally trigger mid-sentence ("...that will stop the...").
const STOP_LISTENING_PHRASES = [
  "stop listening",
  "stop listening ultron",
  "ultron stop listening",
  "mute yourself",
  "mute mic",
  "mute the mic",
  "go to sleep",
  "ultron go to sleep",
  "ultron mute",
];

function isStopListeningCommand(transcript: string): boolean {
  const normalized = transcript.trim().toLowerCase().replace(/[.!?]+$/, "");
  return STOP_LISTENING_PHRASES.includes(normalized);
}

/**
 * Owns the assistant's entire lifecycle — API key, chat history, and
 * continuous voice listening. Call this ONCE at the top of the app (in
 * JarvisOrb) so listening keeps running no matter which tab is showing,
 * instead of stopping/restarting every time the COMMAND tab is opened.
 */
export function useAssistant() {
  const [apiKey, setApiKeyState] = useState("");
  const [emailConfig, setEmailConfigState] = useState<EmailConfig>(EMPTY_EMAIL_CONFIG);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [micOn, setMicOn] = useState(true);
  const [listening, setListening] = useState(false);
  const [voiceOut, setVoiceOut] = useState(true);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [lastReply, setLastReply] = useState<string | null>(null);
  // Whether "start window drag mode" is currently active — the hand's
  // pinch gesture is repurposed from spinning the orb to dragging whatever
  // real OS window it's pointing at (see JarvisOrb + lib/windowDragControl).
  const [cameraDragMode, setCameraDragMode] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const micOnRef = useRef(micOn);
  const speakingRef = useRef(false);
  const armRef = useRef<() => void>(() => {});
  const messagesRef = useRef<ChatMessage[]>([]);
  const reminderTimersRef = useRef<number[]>([]);

  // Reminders live only in this tab's memory — a plain setTimeout, not a
  // persisted OS-level scheduled task — so they're lost if the page
  // reloads or the app is closed. Fine for "remind me in 8 minutes" while
  // ULTRON stays open, not a substitute for a real calendar/reminder app
  // for anything that has to survive a restart.
  useEffect(() => {
    return () => {
      reminderTimersRef.current.forEach((id) => window.clearTimeout(id));
      reminderTimersRef.current = [];
    };
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

  useEffect(() => {
    const saved = window.localStorage.getItem(API_KEY_STORAGE);
    if (saved) setApiKeyState(saved);

    const savedEmail = window.localStorage.getItem(EMAIL_CONFIG_STORAGE);
    if (savedEmail) {
      try {
        setEmailConfigState({ ...EMPTY_EMAIL_CONFIG, ...JSON.parse(savedEmail) });
      } catch {
        // corrupt/old value — ignore, keep defaults
      }
    }

    setSpeechSupported(!!getSpeechRecognition());
  }, []);

  const setApiKey = useCallback((key: string) => {
    setApiKeyState(key);
    window.localStorage.setItem(API_KEY_STORAGE, key);
  }, []);

  // Stored only in this browser, exactly like the Gemini key — never
  // committed, never sent anywhere but this app's own /api/assistant route,
  // which uses it purely to authenticate to the SMTP server.
  const setEmailConfig = useCallback((config: EmailConfig) => {
    setEmailConfigState(config);
    window.localStorage.setItem(EMAIL_CONFIG_STORAGE, JSON.stringify(config));
  }, []);

  const speak = useCallback(
    (text: string) => {
      // Even with voice OUTPUT off, the voice INPUT loop must still
      // re-arm itself here — otherwise a muted-voice-out user who was
      // mid-utterance when speak() was skipped would never get restarted,
      // breaking "keep listening until I say stop". So the re-arm always
      // happens; only the actual TTS call is gated on voiceOut.
      if (!voiceOut || typeof window === "undefined" || !("speechSynthesis" in window)) {
        setTimeout(() => armRef.current(), 150);
        return;
      }
      speakingRef.current = true;
      recognitionRef.current?.stop();

      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.02;
      utter.pitch = 0.85;
      utter.onend = () => {
        speakingRef.current = false;
        setTimeout(() => armRef.current(), 150);
      };
      utter.onerror = () => {
        speakingRef.current = false;
        setTimeout(() => armRef.current(), 150);
      };
      window.speechSynthesis.speak(utter);
    },
    [voiceOut],
  );

  const scheduleReminder = useCallback(
    (task: string, delaySeconds: number) => {
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "default"
      ) {
        // Best-effort ask — some browsers only honor this from a direct
        // click gesture, in which case it silently stays "default" and the
        // reminder still works fine via the spoken/chat message alone.
        Notification.requestPermission().catch(() => {});
      }

      const id = window.setTimeout(() => {
        const text = `⏰ Reminder: ${task}`;
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text }]);
        setLastReply(text);
        speak(text);

        if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
          try {
            new Notification("ULTRON Reminder", { body: task });
          } catch {
            // Notification construction can throw in some embedded/Electron
            // contexts — the spoken + in-chat reminder above already
            // covers it, so this is just a bonus, not required.
          }
        }

        reminderTimersRef.current = reminderTimersRef.current.filter((t) => t !== id);
      }, delaySeconds * 1000);

      reminderTimersRef.current.push(id);
    },
    [speak],
  );

  const send = useCallback(
    async (text: string, attachment?: PendingAttachment, apiKeyOverride?: string) => {
      const trimmed = text.trim();
      const key = apiKeyOverride ?? apiKey;
      // An attachment on its own (no typed/spoken text) is still a valid
      // send — "here, look at this" — so only bail out when BOTH are empty.
      if ((!trimmed && !attachment) || busy) return;

      if (!key) {
        setLastReply("Add your Gemini API key in Settings first.");
        return;
      }

      const userLabel = trimmed || (attachment ? `Attached: ${attachment.name}` : "");
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        text: attachment && trimmed ? `📎 ${attachment.name}\n${trimmed}` : attachment ? `📎 ${userLabel}` : trimmed,
      };
      // Grab history BEFORE this new message is added, so it's just the
      // prior back-and-forth — the classifier gets this plus `message`
      // separately, so it can fill in a recipient/body/attachment given
      // across several turns instead of treating every message as a fresh,
      // context-free request (e.g. "send an email" -> "to X" -> "saying Y"
      // now resolves into one send_email action instead of three dead ends).
      const history = messagesRef.current
        .slice(-10)
        .filter((m) => m.role !== "error")
        .map((m) => ({ role: m.role, text: m.text }));

      setMessages((m) => [...m, userMsg]);
      setBusy(true);

      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed || "Take a look at this file and tell me about it.",
            apiKey: key,
            emailConfig,
            history,
            attachment: attachment
              ? { name: attachment.name, mimeType: attachment.mimeType, data: attachment.data }
              : undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Request failed.");

        if (typeof data.cameraDragMode === "boolean") {
          setCameraDragMode(data.cameraDragMode);
        }

        if (data.effect === "barrel_roll" && typeof document !== "undefined") {
          const el = document.body;
          // In case a second barrel roll lands mid-animation: drop the
          // class, force a reflow so the browser "forgets" the animation
          // ran, then re-add it — otherwise the animation wouldn't restart.
          el.classList.remove("ultron-barrel-roll");
          void el.offsetWidth;
          el.classList.add("ultron-barrel-roll");
          el.addEventListener(
            "animationend",
            () => el.classList.remove("ultron-barrel-roll"),
            { once: true },
          );
        }

        if (data.reminder?.task && typeof data.reminder.delaySeconds === "number") {
          scheduleReminder(data.reminder.task, data.reminder.delaySeconds);
        }

        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: data.text }]);
        setLastReply(data.text);
        speak(data.text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error.";
        setMessages((m) => [...m, { id: crypto.randomUUID(), role: "error", text: msg }]);
        setLastReply(msg);
        speak(msg);
      } finally {
        setBusy(false);
      }
    },
    [apiKey, busy, emailConfig, scheduleReminder, speak],
  );

  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);

  // Continuous, always-on voice input. Mounted once at the top of the app
  // so it keeps listening no matter which tab (ORB or COMMAND) is active —
  // no need to open COMMAND for each command. The loop never stops on its
  // own: every exit path (result captured, recognition ended, recognition
  // errored) re-arms itself. The only ways it stops are (1) the user mutes
  // the mic button/toggleMic, or (2) the user says a stop-listening phrase.
  useEffect(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;

    let stopped = false;
    let armPending = false; // guards against double rec.start() when two
    // exit paths (e.g. onend + a manual stop()) both try to re-arm at once.

    const arm = () => {
      if (stopped || !micOnRef.current || speakingRef.current || armPending) return;
      armPending = true;

      const rec = new Recognition();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.continuous = false;

      rec.onresult = (e) => {
        const transcript = e.results[e.results.length - 1]?.[0]?.transcript ?? "";
        const trimmed = transcript.trim();
        if (!trimmed) return;

        if (isStopListeningCommand(trimmed)) {
          // Explicit "stop" — mute instead of sending it as a command.
          // The mic stays off until the user re-enables it (button, or
          // toggleMic from elsewhere) — this is the one real exit from
          // the otherwise-infinite loop.
          setMicOn(false);
          return;
        }

        void sendRef.current(trimmed);
      };
      rec.onend = () => {
        armPending = false;
        setListening(false);
        setTimeout(arm, 250);
      };
      rec.onerror = () => {
        armPending = false;
        setListening(false);
        setTimeout(arm, 800);
      };

      recognitionRef.current = rec;
      try {
        rec.start();
        setListening(true);
      } catch {
        armPending = false;
        setTimeout(arm, 800);
      }
    };

    armRef.current = arm;
    arm();

    return () => {
      stopped = true;
      recognitionRef.current?.stop();
      recognitionRef.current = null;
    };
  }, []);

  const toggleMic = useCallback(() => {
    setMicOn((on) => {
      const next = !on;
      if (!next) {
        recognitionRef.current?.stop();
      } else {
        setTimeout(() => armRef.current(), 100);
      }
      return next;
    });
  }, []);

  return {
    apiKey,
    setApiKey,
    emailConfig,
    setEmailConfig,
    messages,
    busy,
    micOn,
    toggleMic,
    listening,
    voiceOut,
    setVoiceOut,
    speechSupported,
    lastReply,
    cameraDragMode,
    send,
  };
}
