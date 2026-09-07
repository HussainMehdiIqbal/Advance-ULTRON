# ULTRON Orb UI

An Iron Man–inspired holographic orb built with **Next.js**, **Three.js**, and **MediaPipe** hand tracking — control it with your bare hands through your webcam.

> 🔮 This is the open-source **interface** of [ULTRON](https://sagartamang.com/projects/ultron) — my AI that talks in real time and controls Android devices by itself. **[Read the write-up](https://sagartamang.com/projects/ultron)** or **[the X post](https://x.com/sagar_builds/status/2077277583646101921)**

> 📱 **[Watch the demo on Instagram](https://www.instagram.com/p/DayJ17OTwvx/)**

![ULTRON orb UI](docs/screenshot.png)

https://github.com/user-attachments/assets/91578a83-9a27-44e8-84b0-96defcfd7366

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Controls

### Mouse / touch

| Input | Action |
| --- | --- |
| Drag | Spin the orb |
| Scroll / pinch | Zoom in & out |

### Hand gestures (webcam)

Click **GESTURES OFF** (or press `G`) and allow camera access, then:

| Gesture | Action |
| --- | --- |
| Pinch (thumb + index) one hand and move it | Spin the orb |
| Pinch with **both** hands, spread apart / bring together | Zoom in / out |

### Keyboard

| Key | Action |
| --- | --- |
| `G` | Toggle hand gestures |
| `R` | Reset the view |
| `+` / `−` | Zoom in / out |

## Running it as a desktop app (Windows)

Double-click **`start-ultron.bat`**. On first run it installs everything
(Node.js must already be installed — get it from https://nodejs.org if you
don't have it), then opens ULTRON in its own app window instead of a browser
tab. Later runs skip straight to launching.

Under the hood, `main.js` (Electron) starts the Next.js server for you and
loads it into a native window — closing the window shuts the server down too.

## COMMAND tab: typed + voice AI assistant

Click the **COMMAND** tab (top-right) to open a chat panel next to the orb:

- **Voice starts automatically** — no click needed. As soon as the tab
  mounts, the mic listens continuously, pauses itself while ULTRON is
  speaking (so it doesn't hear itself), and re-arms right after. Click the
  🎙/🔇 button to mute/unmute it. You can also just type and hit SEND.
- Every message — typed or spoken — is automatically classified by Gemini
  into one of: plain **chat**, **web search**, **open an app**, **open a
  website**, **play a song on YouTube**, or **draft a WhatsApp message**.
  You don't need to pick a mode; just say what you want:
  - "open notepad" / "open calculator" / "open file explorer"
  - "open youtube" / "open gmail"
  - "play shape of you"
  - "search latest tech news"
  - "send whatsapp message to 923001234567 saying I'm on my way"
- WhatsApp messages are **pre-filled but never auto-sent** — ULTRON opens
  the chat with your text typed in, you press Enter yourself. This is
  intentional so a misheard command or AI mistake can never send a message
  on its own.
- **Email actually sends**, unlike WhatsApp — say "send email to
  someone@example.com saying hi how are you" and it goes out for real over
  SMTP. Add a file too: "send index.html to someone@example.com" attaches
  it. ULTRON only looks for the bare filename you give it — it never
  accepts a path — and only inside the project's `data/shared` folder, the
  project itself, or your Desktop/Downloads/Documents, so it can't be made
  to read arbitrary files off your machine. Set it up once in Settings ⚙:
  - Your email address and a Gmail **App Password** (not your normal
    password — enable 2-Step Verification, then create one at
    myaccount.google.com/apppasswords). Other SMTP providers work too if
    you're comfortable editing `lib/emailActions.ts`'s default host/port.
  - Like the Gemini key, this is saved only in your browser's local
    storage and used from `app/api/assistant/route.ts` purely to log in to
    the SMTP server — it's never committed or sent anywhere else.
- **Reads whatever's on your screen** — say "read the current window" or
  ask something specific like "what does this page say about pricing"
  while a browser tab (Google results, a ChatGPT/Claude reply, an article)
  or any app is focused, and ULTRON reads its visible text and
  answers/summarizes it out loud. On Windows this uses UI Automation — the
  same accessibility layer screen readers use — so it reads real rendered
  text, no screenshot or OCR involved. It only ever reads the window that
  currently has OS focus, the same target as "close it"/"minimize it".
  macOS and Linux support is best-effort (see `lib/screenReader.ts`) since
  neither has as complete an accessibility API as Windows' UIA.
- **Writes applications/letters for you** — say "write a medical leave
  application, I'm Hussain, reason is fever, for tomorrow" or "write me a
  leave request for 2 days" and ULTRON drafts a complete, formally
  formatted letter and opens it straight into Notepad, pasted in and ready
  to read/edit — no typing needed. It never stops to ask for missing
  details; anything you didn't specify (your name, exact dates, recipient)
  comes back as a `[bracketed placeholder]` you fill in yourself, so the
  request never stalls waiting for information. Say "in WordPad" if you'd
  rather it opened there instead of Notepad. Text is inserted via a
  clipboard paste rather than simulated typing, which is instant and
  handles any punctuation in the letter correctly — note this does
  overwrite whatever was on your clipboard.
- **Writes code for you** — say "write a code of login page" or "write a
  python script to rename files in a folder" and ULTRON generates a
  complete, working file and opens it directly in VS Code. It picks a
  sensible filename/extension itself (or follows the language you named)
  and saves it to an `ULTRON Code` folder in your home directory — kept
  separate from ULTRON's own project source so it's easy to find and never
  collides with this codebase. If a file called that already exists, it
  saves as `name (2).ext` instead of overwriting it. Requires VS Code's
  `code` CLI to be on your PATH (VS Code's Command Palette →
  `Shell Command: Install 'code' command in PATH` sets this up in one
  click) — if that's missing, the file is still generated and saved, you'd
  just need to open it manually.
- **World news briefing** — say "give me the latest world news" or narrow
  it down with "news about Pakistan" / "any tech news today" and ULTRON
  pulls several fresh, deduplicated search results (biased toward the last
  day) and has Gemini turn them into a short spoken briefing of 4-6
  distinct headlines — not just one answer to one question, which is what
  the general web-search action gives you. If the live results genuinely
  don't contain real current news, it says so rather than inventing
  headlines. General knowledge questions (facts, history, "how does X
  work") are answered directly and confidently without needing a search at
  all — search is reserved for things that actually change over time.
- **Reminders** — say "after 8 min remember me to eat burger" or "remind
  me to call mom in 20 minutes" and ULTRON works out the delay (Gemini is
  given the current date/time so it can also handle "remind me at 5pm to
  X") and confirms it back to you immediately. When it fires, you get a
  spoken reminder, a message in the chat log, and — if you've allowed
  notifications for the app — a desktop notification too. This is a
  plain in-tab timer, not an OS-level scheduled task, so it only fires
  while ULTRON is open and is lost if you close or reload the app; it's
  also capped at 24 hours out.
- **Copy/paste files between folders** — "copy index.html to desktop" finds
  that file (same search locations as the email-attachment feature — the
  project, Desktop, Downloads, Documents) and copies it there; "copy all
  files from downloads to a folder called Backup" copies every top-level
  file from Downloads into `Documents/Backup` (created if it doesn't
  exist). Destinations resolve only to Desktop/Downloads/Documents/
  Pictures/Music/Videos, or a new subfolder inside Documents if you name
  something else — never an arbitrary path. A same-named file at the
  destination is never overwritten; it's saved as `name (2).ext` instead.
  Bulk copies only touch files, never subfolders, and are capped at 200
  files per request. Either side can also be "the current window" — "select
  all files in this window and paste them on desktop" — which asks
  whatever File Explorer (or Finder on macOS) window currently has focus
  what folder it's showing, the same target every other "current window"
  feature in ULTRON uses. Not supported on Linux, where there's no single
  reliable API for this across desktop environments.
- Replies are **spoken aloud** (toggle this in Settings ⚙).
- The first time you open it, paste your **Gemini API key** into Settings
  (get one free at aistudio.google.com/apikey). It's saved only in your
  browser's local storage and is used from `app/api/assistant/route.ts` —
  it never gets committed to the repo or sent anywhere but Google's API.
- App-opening and URL-opening happen on your own machine via the Next.js
  server process (`lib/systemActions.ts`) — apps are launched from a fixed
  allowlist (notepad, calculator, paint, explorer, cmd, task manager,
  wordpad), and any URL is validated as http/https before being opened, so
  a bad AI guess can't run arbitrary commands.

## How it works

- **`lib/orbScene.ts`** — the Three.js scene: layered wireframe shells, a spiral
  inner core, floating code-text sprites, orbiting debris, dust particles, scan
  rings, and a bloom + chromatic-aberration post-processing stack.
- **`lib/handTracker.ts`** — MediaPipe HandLandmarker running on the webcam
  feed. Pinch detection with hysteresis: one pinched hand spins the orb, two
  pinched hands zoom by spreading apart or together.
- **`components/JarvisOrb.tsx`** — the HUD and glue between the scene, the
  tracker, and your inputs.

## License

MIT
