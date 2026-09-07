import { spawn, type ChildProcess } from "child_process";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const IS_WIN = process.platform === "win32";

/**
 * One-finger window dragging. Touchscreens promote single-finger touch to
 * standard left-mouse-button events on Windows (legacy touch-to-mouse
 * promotion), so this is implemented as "press-and-slide with the left
 * mouse button moves whatever window is under the initial press point" —
 * that covers touch AND mouse/trackpad with one implementation.
 *
 * Runs as a single long-lived background PowerShell process (via
 * GetAsyncKeyState polling — works globally, no focus needed) rather than
 * per-gesture spawns, since a drag needs continuous, low-latency tracking
 * for the whole press-move-release sequence.
 *
 * Tap vs. drag: a press is only treated as a drag once the finger has
 * moved past a small threshold (see DRAG_THRESHOLD_PX below). Below that,
 * nothing is touched, so a plain tap/click, a double-tap/double-click, and
 * any native scroll or drag gesture *inside* an app all pass through
 * completely untouched — this script never sees them as anything other
 * than "button not held past threshold". Only once a real drag starts does
 * it take over positioning, and it releases the instant the button/finger
 * lifts, from either state.
 *
 * Windows-only for now: this needs a global input hook, which on macOS
 * requires Accessibility permissions + a compiled helper, and on Linux
 * needs X11/Wayland-specific tooling. Both are real projects on their own,
 * not something to fake with a partial implementation.
 */

let dragProcess: ChildProcess | null = null;
let dragMode: "off" | "title_bar_only" | "body" = "off";

// Height of the band from the top of a window (in px) treated as its
// title bar when dragging is restricted to "title_bar_only" mode.
const TITLE_BAR_HEIGHT = 40;

// How far (in px) the finger/cursor has to move past the initial press
// point before a press is treated as a drag rather than a tap. Below this,
// nothing about the window is touched at all — the underlying app sees a
// completely normal click, so single-click, double-click, and any native
// drag/scroll gesture inside the app work exactly as if this script wasn't
// running. This mirrors how Windows' own native window-drag threshold
// works (a plain click never nudges the window).
const DRAG_THRESHOLD_PX = 6;

function buildWindowsDragScript(allowBodyDrag: boolean): string {
  const inZoneExpr = allowBodyDrag
    ? "$true"
    : `(($pt.Y -ge $rect.Top) -and ($pt.Y -le ($rect.Top + ${TITLE_BAR_HEIGHT})))`;

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UltronDrag {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT Point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -AssemblyName System.Windows.Forms

$VK_LBUTTON = 0x01
$GA_ROOT = 2
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$DRAG_THRESHOLD = ${DRAG_THRESHOLD_PX}

# Three states, so a tap and a drag are never confused:
#  idle    - button up, nothing tracked
#  pending - button down, in the draggable zone, but hasn't moved past the
#            threshold yet -> a plain click/tap, window is NOT touched
#  dragging- moved past the threshold -> now actively following the finger
$state = "idle"
$hwnd = [IntPtr]::Zero
$startCursorX = 0
$startCursorY = 0
$startWinX = 0
$startWinY = 0

while ($true) {
  $keyState = [UltronDrag]::GetAsyncKeyState($VK_LBUTTON)
  $isDown = ($keyState -band 0x8000) -ne 0

  $pt = New-Object UltronDrag+POINT
  [UltronDrag]::GetCursorPos([ref]$pt) | Out-Null

  if ($isDown -and $state -eq "idle") {
    $target = [UltronDrag]::WindowFromPoint($pt)
    if ($target -ne [IntPtr]::Zero) {
      $root = [UltronDrag]::GetAncestor($target, $GA_ROOT)
      if ($root -ne [IntPtr]::Zero) {
        $rect = New-Object UltronDrag+RECT
        [UltronDrag]::GetWindowRect($root, [ref]$rect) | Out-Null
        $inZone = ${inZoneExpr}
        if ($inZone) {
          # Press landed in the draggable zone — start tracking as
          # "pending" only. No window API call yet, so a simple click
          # here (e.g. on a title-bar button, or just to focus the
          # window) behaves completely normally.
          $state = "pending"
          $hwnd = $root
          $startCursorX = $pt.X
          $startCursorY = $pt.Y
          $startWinX = $rect.Left
          $startWinY = $rect.Top
        }
      }
    }
  } elseif ($isDown -and $state -eq "pending") {
    $dx = $pt.X - $startCursorX
    $dy = $pt.Y - $startCursorY
    if (([Math]::Abs($dx) -gt $DRAG_THRESHOLD) -or ([Math]::Abs($dy) -gt $DRAG_THRESHOLD)) {
      $state = "dragging"
    }
  } elseif ($isDown -and $state -eq "dragging") {
    $dx = $pt.X - $startCursorX
    $dy = $pt.Y - $startCursorY
    $targetY = $startWinY + $dy
    # Same top-edge guard as the camera-drag session below: stops the
    # window from crossing above the screen top, which is what triggers
    # Windows' snap-to-maximize mid-drag.
    $screenTop = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Y
    if ($targetY -lt $screenTop) { $targetY = $screenTop }
    [UltronDrag]::SetWindowPos($hwnd, [IntPtr]::Zero, ($startWinX + $dx), $targetY, 0, 0, ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE)) | Out-Null
  } elseif ((-not $isDown) -and ($state -ne "idle")) {
    # Finger lifted — release cleanly and immediately, from either
    # "pending" (was just a tap) or "dragging" (was an active move).
    $state = "idle"
    $hwnd = [IntPtr]::Zero
  }

  # ~120Hz poll rate. Each iteration is a handful of P/Invoke calls, so the
  # real loop period runs a little over the sleep value due to PowerShell's
  # own interpreter overhead — still well under the ~16ms (60fps) frame
  # budget, so the window tracks the finger without visible lag or jumps.
  Start-Sleep -Milliseconds 8
}
`;
}

/**
 * Starts (or, if already running in a different mode, restarts) the
 * background drag-tracking process.
 *
 * Note: SetWindowPos will silently fail against a window running at a
 * HIGHER integrity level than this server — e.g. Task Manager or any app
 * launched "Run as administrator" — if ULTRON itself isn't elevated too.
 * That's Windows' UIPI security boundary, not a bug here; ordinary apps
 * (Chrome, Notepad, File Explorer) run at the same level as a normal
 * ULTRON session and drag fine.
 */
export async function startWindowDrag(allowBodyDrag: boolean): Promise<string> {
  if (!IS_WIN) {
    throw new Error(
      "One-finger window dragging is only supported on Windows right now — macOS and Linux would need a native global-input helper this project doesn't ship yet.",
    );
  }

  const wantedMode: "title_bar_only" | "body" = allowBodyDrag ? "body" : "title_bar_only";
  if (dragProcess && dragMode === wantedMode) {
    return allowBodyDrag
      ? "Window dragging is already on — press anywhere on a window with one finger and slide to move it."
      : "Window dragging is already on — press a window's title bar with one finger and slide to move it.";
  }

  if (dragProcess) {
    await stopWindowDrag();
  }

  const script = buildWindowsDragScript(allowBodyDrag);
  const proc = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
  });
  dragProcess = proc;
  dragMode = wantedMode;

  proc.on("exit", () => {
    if (dragProcess === proc) {
      dragProcess = null;
      dragMode = "off";
    }
  });

  return allowBodyDrag
    ? 'Window dragging is on. Press anywhere on a window with one finger and slide to move it — say "drag only from the title bar" if that starts interfering with normal clicking and dragging inside apps.'
    : "Window dragging is on. Press a window's title bar with one finger and slide to move it.";
}

export async function stopWindowDrag(): Promise<string> {
  if (!dragProcess) {
    dragMode = "off";
    return "Window dragging is already off.";
  }
  const proc = dragProcess;
  dragProcess = null;
  dragMode = "off";

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    proc.once("exit", finish);
    proc.kill();
    // child.kill() can be unreliable against a PowerShell host process on
    // Windows — force-kill by PID as a fallback so the loop definitely stops.
    if (IS_WIN && proc.pid) {
      spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"]).on("error", () => {});
    }
    setTimeout(finish, 500);
  });

  return "Window dragging is off.";
}

// ——— Camera-driven ("hand pinch") window dragging ——————————————————————
//
// This is a *separate* mode from the mouse/touch drag above — it's driven
// entirely by normalized hand-pinch coordinates the browser sends up from
// MediaPipe (see lib/handTracker.ts + components/JarvisOrb.tsx), not by a
// real mouse button. It only turns on when the user explicitly asks for it
// ("start window drag mode"), so it never competes with the pinch gesture
// that spins the orb — the frontend is responsible for routing pinch
// events to one or the other, never both at once.
//
// Unlike the polling loop above (which has to watch GetAsyncKeyState
// because nothing else tells it when a real mouse button goes down), this
// session is event-driven: the script is written to a temp .ps1 file (so
// stdin is free for data) and spawned once, then it blocks on
// `[Console]::In.ReadLine()` in a loop, executing one command per line we
// write to its stdin:
//   START <xNorm> <yNorm>  — pinch just started; grab whatever window is
//                            under that normalized point, if any
//   MOVE  <xNorm> <yNorm>  — pinch is still held and the hand moved;
//                            reposition the grabbed window, keeping the
//                            same offset between the hand and the window
//   END                    — pinch released; stop tracking (next START is
//                            a fresh grab)
//   STOP                   — tear the whole session down
//
// Coordinates are normalized [0,1] (mirrored, same convention as the orb's
// pinch tracking) rather than raw pixels, because the browser's notion of
// screen size (window.screen) can disagree with the OS's real pixel grid
// under display scaling — the PowerShell side maps normalized coordinates
// onto the *actual* primary-screen bounds it queries for itself, so the
// two always agree.

let cameraDragProcess: ChildProcess | null = null;
let cameraDragAllowBody = false;

function buildCameraDragScript(allowBodyDrag: boolean): string {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UltronCamDrag {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT Point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public struct POINT { public int X; public int Y; }
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
Add-Type -AssemblyName System.Windows.Forms

$GA_ROOT = 2
$SWP_NOSIZE = 0x0001
$SWP_NOZORDER = 0x0004
$SWP_NOACTIVATE = 0x0010
$TITLE_BAR_HEIGHT = ${TITLE_BAR_HEIGHT}
$allowBodyDrag = ${allowBodyDrag ? "$true" : "$false"}
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

# Caps how far the window is allowed to jump in a single MOVE update.
# Noisy hand-tracking frames can otherwise report a wildly different pinch
# point from one frame to the next, snapping the window there instantly —
# which is jarring on its own, and violent enough repeated motion is also
# what triggers Windows' "shake a window to minimize everything else"
# (Aero Shake) gesture, which looks like ULTRON randomly minimized other
# windows. Clamping each step to a fixed max distance turns any such
# spikes into a fast-but-smooth glide instead.
$MAX_STEP_PX = 60

$hwnd = [IntPtr]::Zero
$offsetX = 0
$offsetY = 0

function ToScreenPoint([double]$xNorm, [double]$yNorm) {
  $clampedX = [Math]::Min(1, [Math]::Max(0, $xNorm))
  $clampedY = [Math]::Min(1, [Math]::Max(0, $yNorm))
  $pt = New-Object UltronCamDrag+POINT
  $pt.X = $bounds.X + [int]($clampedX * $bounds.Width)
  $pt.Y = $bounds.Y + [int]($clampedY * $bounds.Height)
  return $pt
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim() -split '\\s+'
  if ($parts.Length -lt 1 -or $parts[0] -eq "") { continue }
  $cmd = $parts[0]

  if ($cmd -eq "STOP") {
    break
  } elseif ($cmd -eq "END") {
    $hwnd = [IntPtr]::Zero
  } elseif ($cmd -eq "START" -and $parts.Length -ge 3) {
    $pt = ToScreenPoint ([double]$parts[1]) ([double]$parts[2])
    $target = [UltronCamDrag]::WindowFromPoint($pt)
    if ($target -ne [IntPtr]::Zero) {
      $root = [UltronCamDrag]::GetAncestor($target, $GA_ROOT)
      if ($root -ne [IntPtr]::Zero) {
        $rect = New-Object UltronCamDrag+RECT
        [UltronCamDrag]::GetWindowRect($root, [ref]$rect) | Out-Null
        $inZone = $allowBodyDrag -or (($pt.Y -ge $rect.Top) -and ($pt.Y -le ($rect.Top + $TITLE_BAR_HEIGHT)))
        if ($inZone) {
          $hwnd = $root
          $offsetX = $rect.Left - $pt.X
          $offsetY = $rect.Top - $pt.Y
        } else {
          $hwnd = [IntPtr]::Zero
        }
      }
    } else {
      $hwnd = [IntPtr]::Zero
    }
  } elseif ($cmd -eq "MOVE" -and $parts.Length -ge 3 -and $hwnd -ne [IntPtr]::Zero) {
    $pt = ToScreenPoint ([double]$parts[1]) ([double]$parts[2])
    $targetX = $pt.X + $offsetX
    $targetY = $pt.Y + $offsetY

    $curRect = New-Object UltronCamDrag+RECT
    if ([UltronCamDrag]::GetWindowRect($hwnd, [ref]$curRect)) {
      $dx = $targetX - $curRect.Left
      $dy = $targetY - $curRect.Top
      $dist = [Math]::Sqrt(($dx * $dx) + ($dy * $dy))
      if ($dist -gt $MAX_STEP_PX) {
        # Same direction, capped magnitude — glides smoothly toward the
        # hand instead of teleporting to it.
        $scale = $MAX_STEP_PX / $dist
        $targetX = $curRect.Left + [int]($dx * $scale)
        $targetY = $curRect.Top + [int]($dy * $scale)
      }
    }

    # Keep the title bar from crossing above the screen's top edge —
    # that's what makes Windows snap the window to maximized, which can
    # look like the window "closed" since it suddenly fills the screen
    # or the drag appears to stop responding.
    if ($targetY -lt $bounds.Y) { $targetY = $bounds.Y }

    [UltronCamDrag]::SetWindowPos($hwnd, [IntPtr]::Zero, $targetX, $targetY, 0, 0, ($SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_NOACTIVATE)) | Out-Null
  }
}
`;
}

/**
 * Turns on camera/pinch-driven window dragging. Call sendCameraDragEvent()
 * as the hand-pinch state changes (start/move/end) to actually move a
 * window; this function only spins up the listener process.
 */
export async function startCameraDragSession(allowBodyDrag: boolean): Promise<string> {
  if (!IS_WIN) {
    throw new Error(
      "Camera-driven window dragging is only supported on Windows right now — macOS and Linux would need a native global-window helper this project doesn't ship yet.",
    );
  }

  if (cameraDragProcess && cameraDragAllowBody === allowBodyDrag) {
    return allowBodyDrag
      ? "Window drag mode is already on — pinch anywhere over a window and move your hand to drag it."
      : "Window drag mode is already on — pinch over a window's title bar and move your hand to drag it.";
  }
  if (cameraDragProcess) {
    await stopCameraDragSession();
  }

  const dir = mkdtempSync(join(tmpdir(), "ultron-camdrag-"));
  const scriptPath = join(dir, "camdrag.ps1");
  writeFileSync(scriptPath, buildCameraDragScript(allowBodyDrag), "utf8");

  const proc = spawn(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  cameraDragProcess = proc;
  cameraDragAllowBody = allowBodyDrag;

  proc.on("exit", () => {
    if (cameraDragProcess === proc) {
      cameraDragProcess = null;
    }
  });

  return allowBodyDrag
    ? 'Window drag mode is on. Pinch anywhere over a window with one hand and move it to drag — say "drag only from the title bar" if that starts interfering with clicking inside apps.'
    : "Window drag mode is on. Pinch over a window's title bar with one hand and move it to drag.";
}

export async function stopCameraDragSession(): Promise<string> {
  if (!cameraDragProcess) {
    return "Window drag mode is already off.";
  }
  const proc = cameraDragProcess;
  cameraDragProcess = null;

  try {
    proc.stdin?.write("STOP\n");
  } catch {
    // process may already be gone
  }

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    proc.once("exit", finish);
    setTimeout(() => {
      // STOP should make it exit on its own; force-kill as a fallback so
      // this never hangs the request.
      proc.kill();
      if (IS_WIN && proc.pid) {
        spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"]).on("error", () => {});
      }
    }, 400);
    setTimeout(finish, 900);
  });

  return "Window drag mode is off.";
}

export function isCameraDragActive(): boolean {
  return cameraDragProcess !== null;
}

/**
 * Feeds one hand-pinch update into the active camera-drag session. Silently
 * a no-op if the session isn't running (e.g. a stray event arrives right
 * after the user turned the mode off) — this is fire-and-forget by design
 * since it's called once per animation frame from the browser.
 */
export function sendCameraDragEvent(
  event: "start" | "move" | "end",
  xNorm: number,
  yNorm: number,
): void {
  if (!cameraDragProcess?.stdin) return;
  const line =
    event === "end" ? "END" : `${event === "start" ? "START" : "MOVE"} ${xNorm.toFixed(4)} ${yNorm.toFixed(4)}`;
  try {
    cameraDragProcess.stdin.write(line + "\n");
  } catch {
    // best-effort — if the pipe is gone the session is dead anyway
  }
}
