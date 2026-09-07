"use client";

import { useEffect, useState } from "react";
import type { IpLookupResult } from "@/lib/ipTracker";

const IPSTACK_KEY_STORAGE = "ultron_ipstack_api_key";

export default function IpTrackerPanel() {
  const [apiKey, setApiKeyState] = useState("");
  const [showSettings, setShowSettings] = useState(true);
  const [ip, setIp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IpLookupResult | null>(null);

  useEffect(() => {
    const saved = window.localStorage.getItem(IPSTACK_KEY_STORAGE);
    if (saved) {
      setApiKeyState(saved);
      setShowSettings(false);
    }
  }, []);

  const setApiKey = (key: string) => {
    setApiKeyState(key);
    window.localStorage.setItem(IPSTACK_KEY_STORAGE, key);
  };

  const track = async () => {
    setError(null);
    if (!apiKey.trim()) {
      setError("Add your IPStack API key first.");
      setShowSettings(true);
      return;
    }
    if (!ip.trim()) {
      setError("Enter an IP address to track.");
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/iptrack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ip: ip.trim(), apiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "IP lookup failed.");
      setResult(data as IpLookupResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "IP lookup failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cmd-panel">
      <div className="cmd-header">
        <div className="cmd-title-row">
          <span className="cmd-title">IP TRACKING</span>
        </div>
        <button
          type="button"
          className="cmd-icon-btn"
          onClick={() => setShowSettings((s) => !s)}
          aria-label="Settings"
          title="IPStack API key settings"
        >
          ⚙
        </button>
      </div>

      {showSettings && (
        <div className="cmd-settings">
          <label htmlFor="ipstack-key">IPSTACK API KEY</label>
          <input
            id="ipstack-key"
            type="password"
            placeholder="Paste your IPStack API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <p className="cmd-settings-hint">
            Stored only in this browser (localStorage). Get a free key at{" "}
            <span>ipstack.com</span> (Signup → Free Plan).
          </p>
        </div>
      )}

      <div className="ip-track-form">
        <input
          className="cmd-text-input"
          placeholder="Enter an IP address (e.g. 8.8.8.8)"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void track();
            }
          }}
          disabled={busy}
        />
        <button type="button" className="cmd-send-btn" onClick={() => void track()} disabled={busy}>
          {busy ? "TRACKING…" : "TRACK"}
        </button>
      </div>

      {error && <div className="cmd-attach-error">{error}</div>}

      <div className="ip-track-results">
        {!result && !busy && !error && (
          <div className="cmd-log-empty">
            Enter an IP address above and ULTRON will pull its country, region, city,
            coordinates, and more via IPStack.
          </div>
        )}

        {result && (
          <div className="ip-track-card">
            <div className="ip-track-headline">
              {result.countryFlagEmoji ? `${result.countryFlagEmoji} ` : ""}
              {result.ip}
            </div>
            <div className="ip-track-grid">
              <IpField label="Country" value={result.countryName} />
              <IpField label="Country Code" value={result.countryCode} />
              <IpField label="Region" value={result.regionName} />
              <IpField label="City" value={result.city} />
              <IpField label="Zip / Postal" value={result.zip} />
              <IpField label="Continent" value={result.continentName} />
              <IpField label="Capital" value={result.capital} />
              <IpField label="Calling Code" value={result.callingCode ? `+${result.callingCode}` : undefined} />
              <IpField
                label="Coordinates"
                value={
                  result.latitude != null && result.longitude != null
                    ? `${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}`
                    : undefined
                }
              />
              <IpField label="Languages" value={result.languages?.join(", ")} />
              <IpField label="IP Type" value={result.type} />
              <IpField label="In EU" value={result.isEu === undefined ? undefined : result.isEu ? "Yes" : "No"} />
            </div>
            {result.latitude != null && result.longitude != null && (
              <a
                className="ip-track-map-link"
                href={`https://www.google.com/maps?q=${result.latitude},${result.longitude}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                VIEW ON MAP →
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function IpField({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="ip-track-field">
      <span className="ip-track-field-label">{label}</span>
      <span className="ip-track-field-value">{value}</span>
    </div>
  );
}
