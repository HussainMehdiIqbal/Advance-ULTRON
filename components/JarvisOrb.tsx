"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import CommandPanel from "@/components/CommandPanel";
import IpTrackerPanel from "@/components/IpTrackerPanel";
import { useAssistant } from "@/hooks/useAssistant";

type CameraState = "off" | "starting" | "on" | "error";
type ViewTab = "orb" | "command" | "iptrack";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ViewTab>("orb");

  // Mounted once, here at the top, so voice listening keeps running no
  // matter which tab (ORB or COMMAND) is currently showing.
  const assistant = useAssistant();
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    if (!assistant.lastReply) return;
    setToastVisible(true);
    const t = setTimeout(() => setToastVisible(false), 9000);
    return () => clearTimeout(t);
  }, [assistant.lastReply]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = createOrbScene(container);
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  // Throttles outgoing /api/windowdrag "move" calls to roughly 30/sec —
  // hand tracking runs at the webcam's frame rate (often 60fps), which is
  // more network round-trips than the OS-side window move needs. "start"
  // and "end" always go out immediately since they only fire once per
  // pinch, not once per frame.
  const lastDragSendRef = useRef(0);

  const sendDragEvent = useCallback((event: "start" | "move" | "end", x: number, y: number) => {
    const now = performance.now();
    if (event === "move") {
      if (now - lastDragSendRef.current < 33) return;
    }
    lastDragSendRef.current = now;
    // Fire-and-forget — a dropped frame here just means the window lags
    // one tick behind the hand, never a stuck or crashed drag.
    fetch("/api/windowdrag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, x, y }),
    }).catch(() => {});
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
      onWindowDrag: sendDragEvent,
    });
    tracker.setCameraDragMode(assistant.cameraDragMode);
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, [sendDragEvent, assistant.cameraDragMode]);

  // Keep the already-running tracker's drag mode in sync with voice
  // commands ("start/stop window drag mode") — this is the live toggle;
  // the setCameraDragMode() call inside startGestures above only covers
  // the mode a fresh tracker is created with.
  useEffect(() => {
    trackerRef.current?.setCameraDragMode(assistant.cameraDragMode);
  }, [assistant.cameraDragMode]);

  // "Start window drag mode" implies the user wants their hand tracked
  // right away — auto-start the camera instead of making them also hit
  // the GESTURES button or press G.
  useEffect(() => {
    if (assistant.cameraDragMode && camera === "off") {
      void startGestures();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistant.cameraDragMode]);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const cameraOn = camera === "on";

  return (
    <>
      <div ref={containerRef} className="orb-root" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">
        U.L.T.R.O.N.
        <span className="hud-title-sub">HUSSAIN MEHDI</span>
      </div>

      <div className="hud hud-tabs">
        <button
          type="button"
          className={`hud-tab-btn${tab === "orb" ? " active" : ""}`}
          onClick={() => setTab("orb")}
        >
          ORB
        </button>
        <button
          type="button"
          className={`hud-tab-btn${tab === "command" ? " active" : ""}`}
          onClick={() => setTab("command")}
        >
          COMMAND
        </button>
        <button
          type="button"
          className={`hud-tab-btn${tab === "iptrack" ? " active" : ""}`}
          onClick={() => setTab("iptrack")}
        >
          IP TRACKING
        </button>
      </div>

      {tab === "command" && (
        <CommandPanel
          apiKey={assistant.apiKey}
          setApiKey={assistant.setApiKey}
          emailConfig={assistant.emailConfig}
          setEmailConfig={assistant.setEmailConfig}
          messages={assistant.messages}
          busy={assistant.busy}
          micOn={assistant.micOn}
          toggleMic={assistant.toggleMic}
          listening={assistant.listening}
          voiceOut={assistant.voiceOut}
          setVoiceOut={assistant.setVoiceOut}
          speechSupported={assistant.speechSupported}
          send={assistant.send}
        />
      )}

      {tab === "iptrack" && <IpTrackerPanel />}

      {/* Always-visible assistant status — works from the ORB screen too,
          no need to switch to COMMAND for it to hear you. */}
      {assistant.speechSupported && (
        <div className="hud hud-assistant-status">
          <button
            type="button"
            className={`assistant-mic-pill${assistant.listening ? " live" : ""}${
              assistant.micOn ? "" : " muted"
            }`}
            onClick={assistant.toggleMic}
            title={assistant.micOn ? "Mute mic" : "Unmute mic"}
          >
            {assistant.micOn ? (assistant.listening ? "● LISTENING" : "🎙 READY") : "🔇 MUTED"}
          </button>
          {tab === "orb" && assistant.lastReply && (
            <div className={`assistant-toast${toastVisible ? " visible" : ""}`}>
              {assistant.lastReply}
            </div>
          )}
        </div>
      )}

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn && assistant.cameraDragMode ? (
          <div>
            <span className="key">PINCH + MOVE</span> drag the window under your hand&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          {/* Mirrored preview so it behaves like a mirror */}
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${
                  assistant.cameraDragMode && status.mode === "spin" ? "WINDOW DRAG" : MODE_LABEL[status.mode]
                }`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomIn()} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.zoomOut()} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="hud-btn" onClick={() => sceneRef.current?.resetView()}>
            RESET
          </button>
        </div>
      </div>
    </>
  );
}
