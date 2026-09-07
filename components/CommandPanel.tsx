"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage, EmailConfig, PendingAttachment } from "@/hooks/useAssistant";

const EXAMPLE_COMMANDS = [
  "enable window dragging",
  "drag only from the title bar",
  "stop window dragging",
  "open youtube",
  "play shape of you",
  "pause the video",
  "minimize it",
  "close youtube",
  "remember my wifi password is Sagar123",
  "what's my wifi password",
  "search cheap laptops in the browser",
  "what's the weather",
  "what time is it",
  "system status",
  "send whatsapp message to 923001234567 saying I'm on my way",
  "send email to hm267510@gmail.com saying hi how are you",
  "send index.html to hm267510@gmail.com",
  "read the current window",
  "what does this page say about pricing",
  "write a medical leave application for tomorrow, I'm Hussain, reason is fever",
  "write a leave request for 2 days",
  "write a code of login page",
  "write a python script to rename files in a folder",
  "give me the latest world news",
  "what's happening in the world today",
  "any tech news today",
  "after 8 min remind me to eat burger",
  "remind me to call mom in 20 minutes",
  "copy index.html to desktop",
  "copy all files from downloads to a folder called Backup",
  "select all files in this window and paste them on desktop",
  "(attach a file or image, then) what is this",
  "(attach a file or image, then) search the web about this",
];

// Files larger than this aren't sent — keeps the request small enough for
// Gemini's inline-data limit and avoids hanging the browser on a huge
// base64 read.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // 15MB

function readFileAsAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.onload = () => {
      const result = reader.result as string; // "data:<mime>;base64,<data>"
      const commaIdx = result.indexOf(",");
      const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      resolve({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        data,
        previewUrl: file.type.startsWith("image/") ? result : undefined,
        sizeBytes: file.size,
      });
    };
    reader.readAsDataURL(file);
  });
}

interface CommandPanelProps {
  apiKey: string;
  setApiKey: (key: string) => void;
  emailConfig: EmailConfig;
  setEmailConfig: (config: EmailConfig) => void;
  messages: ChatMessage[];
  busy: boolean;
  micOn: boolean;
  toggleMic: () => void;
  listening: boolean;
  voiceOut: boolean;
  setVoiceOut: (on: boolean) => void;
  speechSupported: boolean;
  send: (text: string, attachment?: PendingAttachment) => void;
}

export default function CommandPanel({
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
  send,
}: CommandPanelProps) {
  const [showSettings, setShowSettings] = useState(!apiKey);
  const [input, setInput] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const autoClosedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  // apiKey starts empty and is filled in asynchronously (loaded from
  // localStorage after mount), so the initial `useState(!apiKey)` above is
  // always true on first render even when a key was already saved from a
  // previous session. Once that saved key arrives, auto-hide Settings ONE
  // time so a returning user lands straight on the command panel instead
  // of seeing Settings again — but only that first time, so manually
  // reopening Settings later (e.g. to change the key) is never fought.
  useEffect(() => {
    if (apiKey && !autoClosedRef.current) {
      setShowSettings(false);
      autoClosedRef.current = true;
    }
  }, [apiKey]);

  const handleFilePicked = async (file: File | undefined) => {
    setAttachError(null);
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setAttachError(`"${file.name}" is over the 15MB limit — pick a smaller file.`);
      return;
    }
    try {
      const picked = await readFileAsAttachment(file);
      setAttachment(picked);
    } catch {
      setAttachError(`Couldn't read "${file.name}".`);
    }
  };

  return (
    <div className="cmd-panel">
      <div className="cmd-header">
        <div className="cmd-title-row">
          <span className="cmd-title">ULTRON ASSISTANT</span>
          {speechSupported && (
            <span className={`cmd-mic-dot${listening ? " live" : ""}${micOn ? "" : " off"}`}>
              {micOn ? (listening ? "● LISTENING" : "… WAITING") : "MIC MUTED"}
            </span>
          )}
        </div>
        <button
          type="button"
          className="cmd-icon-btn"
          onClick={() => setShowSettings((s) => !s)}
          aria-label="Settings"
          title="Gemini API key settings"
        >
          ⚙
        </button>
      </div>

      {showSettings && (
        <div className="cmd-settings">
          <label htmlFor="gemini-key">GEMINI API KEY</label>
          <input
            id="gemini-key"
            type="password"
            placeholder="Paste your Gemini API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div className="cmd-settings-row">
            <label className="cmd-checkbox">
              <input type="checkbox" checked={voiceOut} onChange={(e) => setVoiceOut(e.target.checked)} />
              Speak responses aloud
            </label>
          </div>
          <p className="cmd-settings-hint">
            Stored only in this browser (localStorage). Get a free key at{" "}
            <span>aistudio.google.com/apikey</span>.
          </p>

          <label htmlFor="email-user">EMAIL ADDRESS (for sending)</label>
          <input
            id="email-user"
            type="email"
            placeholder="you@gmail.com"
            value={emailConfig.user}
            onChange={(e) => setEmailConfig({ ...emailConfig, user: e.target.value })}
          />
          <label htmlFor="email-pass">APP PASSWORD</label>
          <input
            id="email-pass"
            type="password"
            placeholder="16-character Gmail app password"
            value={emailConfig.pass}
            onChange={(e) => setEmailConfig({ ...emailConfig, pass: e.target.value })}
          />
          <p className="cmd-settings-hint">
            Stored only in this browser. For Gmail, turn on 2-Step Verification then create an
            app password at <span>myaccount.google.com/apppasswords</span> — your normal
            password won&apos;t work. To email a file, drop it in the project&apos;s
            <span> data/shared</span> folder, or say its name if it&apos;s already on your
            Desktop, in Downloads, Documents, or the project itself.
          </p>

          <p className="cmd-settings-hint">
            ULTRON is always listening — even on the ORB screen, not just here.
          </p>
          <p className="cmd-settings-hint">
            Try: {EXAMPLE_COMMANDS.map((c, i) => (
              <span key={c}>
                &ldquo;{c}&rdquo;{i < EXAMPLE_COMMANDS.length - 1 ? ", " : ""}
              </span>
            ))}
          </p>
        </div>
      )}

      <div className="cmd-log" ref={logRef}>
        {messages.length === 0 && (
          <div className="cmd-log-empty">
            Type or just speak — from any screen — and ULTRON figures out chat, web
            search, a live world news briefing, opening apps/sites, playing songs,
            sending an email (with an attachment if you name one), reading whatever's
            on your screen, drafting an application/letter into Notepad, writing code
            straight into VS Code, setting a reminder, copying files between folders,
            or a WhatsApp message. You can also attach a file or image below — ULTRON
            reads it and can answer questions about it, or open a browser and search
            the web about it if you ask.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`cmd-msg cmd-msg-${m.role}`}>
            <span className="cmd-msg-role">
              {m.role === "user" ? "YOU" : m.role === "assistant" ? "ULTRON" : "ERROR"}
            </span>
            <span className="cmd-msg-text">{m.text}</span>
          </div>
        ))}
        {busy && <div className="cmd-msg cmd-msg-assistant cmd-thinking">ULTRON is thinking…</div>}
      </div>

      {attachError && <div className="cmd-attach-error">{attachError}</div>}

      {attachment && (
        <div className="cmd-attach-chip">
          {attachment.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={attachment.previewUrl} alt="" className="cmd-attach-thumb" />
          ) : (
            <span className="cmd-attach-icon">📄</span>
          )}
          <span className="cmd-attach-name" title={attachment.name}>
            {attachment.name}
          </span>
          <button
            type="button"
            className="cmd-attach-remove"
            onClick={() => setAttachment(null)}
            aria-label="Remove attachment"
            title="Remove attachment"
          >
            ✕
          </button>
        </div>
      )}

      <form
        className="cmd-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          send(input, attachment ?? undefined);
          setInput("");
          setAttachment(null);
          setAttachError(null);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="cmd-file-input-hidden"
          onChange={(e) => {
            void handleFilePicked(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="cmd-file-input-hidden"
          onChange={(e) => {
            void handleFilePicked(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className="cmd-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          title="Attach a file"
          aria-label="Attach a file"
        >
          📎
        </button>
        <button
          type="button"
          className="cmd-attach-btn"
          onClick={() => imageInputRef.current?.click()}
          disabled={busy}
          title="Upload an image"
          aria-label="Upload an image"
        >
          🖼
        </button>
        {speechSupported && (
          <button
            type="button"
            className={`cmd-mic-btn${listening ? " listening" : ""}${micOn ? "" : " muted"}`}
            onClick={toggleMic}
            aria-pressed={micOn}
            title={micOn ? "Mute mic" : "Unmute mic"}
          >
            {micOn ? "🎙" : "🔇"}
          </button>
        )}
        <input
          className="cmd-text-input"
          placeholder={attachment ? "Ask about this file, or say “search the web about this”…" : "Type a command…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="cmd-send-btn" disabled={busy || (!input.trim() && !attachment)}>
          SEND
        </button>
      </form>
    </div>
  );
}
