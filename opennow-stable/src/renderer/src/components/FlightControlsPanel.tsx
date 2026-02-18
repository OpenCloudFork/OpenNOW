import { useState, useEffect, useCallback, useRef } from "react";
import type { JSX } from "react";
import { Save, Trash2, RotateCcw, Check, Joystick, Eye, Plus } from "lucide-react";
import type {
  Settings,
  FlightProfile,
  FlightControlsState,
  FlightAxisTarget,
  FlightSensitivityCurve,
} from "@shared/gfn";
import { makeVidPid } from "@shared/flightDefaults";
import { FlightHidService, getFlightHidService, isFlightDevice } from "../flight/FlightHidService";

interface FlightControlsPanelProps {
  settings: Settings;
  onSettingChange: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const AXIS_TARGETS: { value: FlightAxisTarget; label: string }[] = [
  { value: "leftStickX", label: "Left Stick X (Roll)" },
  { value: "leftStickY", label: "Left Stick Y (Pitch)" },
  { value: "rightStickX", label: "Right Stick X (Yaw)" },
  { value: "rightStickY", label: "Right Stick Y" },
  { value: "leftTrigger", label: "Left Trigger" },
  { value: "rightTrigger", label: "Right Trigger" },
];

const CURVE_OPTIONS: { value: FlightSensitivityCurve; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "expo", label: "Exponential" },
];

interface DeviceEntry {
  device: HIDDevice;
  vidPid: string;
  label: string;
  isFlight: boolean;
}

function toEntry(d: HIDDevice): DeviceEntry {
  return {
    device: d,
    vidPid: makeVidPid(d.vendorId, d.productId),
    label: d.productName || makeVidPid(d.vendorId, d.productId),
    isFlight: isFlightDevice(d),
  };
}

export function FlightControlsPanel({ settings, onSettingChange }: FlightControlsPanelProps): JSX.Element {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [isCapturing, setIsCapturing] = useState(false);
  const [flightState, setFlightState] = useState<FlightControlsState | null>(null);
  const [profile, setProfile] = useState<FlightProfile | null>(null);
  const [allProfiles, setAllProfiles] = useState<FlightProfile[]>([]);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [showAllDevices, setShowAllDevices] = useState(false);
  const stateUnsubRef = useRef<(() => void) | null>(null);
  const webHidSupported = FlightHidService.isSupported();
  const profileLoadEpoch = useRef(0);

  const enabled = settings.flightControlsEnabled;
  const slot = settings.flightControlsSlot;

  const refreshDevices = useCallback(async (showAll: boolean): Promise<DeviceEntry[]> => {
    const devs = await getFlightHidService().getDevices(showAll);
    const entries = devs.map(toEntry);
    setDevices(entries);
    return entries;
  }, []);

  const loadAllProfiles = useCallback(async () => {
    setAllProfiles(await window.openNow.flightGetAllProfiles());
  }, []);

  const loadProfileForDevice = useCallback(async (vidPid: string) => {
    const epoch = ++profileLoadEpoch.current;
    let p = await window.openNow.flightGetProfile(vidPid);
    if (!p) p = await window.openNow.flightResetProfile(vidPid);
    if (profileLoadEpoch.current === epoch) {
      setProfile(p ? { ...p } : null);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !webHidSupported) return;
    void (async () => {
      const entries = await refreshDevices(showAllDevices);
      await loadAllProfiles();
      if (entries.length === 1) {
        setSelectedIdx(0);
        void loadProfileForDevice(entries[0]!.vidPid);
      }
    })();
  }, [enabled, webHidSupported]);

  useEffect(() => {
    getFlightHidService().controllerSlot = slot;
  }, [slot]);

  useEffect(() => {
    if (selectedIdx >= 0 && selectedIdx < devices.length) {
      void loadProfileForDevice(devices[selectedIdx]!.vidPid);
    } else {
      setProfile(null);
    }
  }, [selectedIdx, devices.length]);

  useEffect(() => {
    return () => {
      if (stateUnsubRef.current) {
        stateUnsubRef.current();
        stateUnsubRef.current = null;
      }
    };
  }, []);

  const handlePairDevice = useCallback(async () => {
    const newDevices = await getFlightHidService().requestDevice();
    if (newDevices.length === 0) return;
    const entries = await refreshDevices(showAllDevices);
    const added = newDevices[0]!;
    const idx = entries.findIndex(
      (e) => e.device.vendorId === added.vendorId && e.device.productId === added.productId && e.device.productName === added.productName,
    );
    if (idx >= 0) setSelectedIdx(idx);
  }, [refreshDevices, showAllDevices]);

  const handleStartCapture = useCallback(async () => {
    if (selectedIdx < 0 || selectedIdx >= devices.length || !profile) return;
    const entry = devices[selectedIdx]!;
    const service = getFlightHidService();
    service.controllerSlot = slot;

    if (stateUnsubRef.current) stateUnsubRef.current();
    stateUnsubRef.current = service.onStateUpdate((s) => setFlightState(s));

    const ok = await service.startCapture(entry.device, profile);
    setIsCapturing(ok);
  }, [selectedIdx, devices, slot, profile]);

  const handleStopCapture = useCallback(() => {
    getFlightHidService().stopCapture();
    setIsCapturing(false);
    setFlightState(null);
    if (stateUnsubRef.current) {
      stateUnsubRef.current();
      stateUnsubRef.current = null;
    }
  }, []);

  const handleAxisMappingChange = useCallback(
    (index: number, field: string, value: unknown) => {
      setProfile((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          axisMappings: prev.axisMappings.map((m, i) =>
            i !== index ? m : { ...m, [field]: value },
          ),
        };
      });
    },
    [],
  );

  const handleButtonMappingChange = useCallback(
    (index: number, field: string, value: unknown) => {
      setProfile((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          buttonMappings: prev.buttonMappings.map((m, i) =>
            i !== index ? m : { ...m, [field]: value },
          ),
        };
      });
    },
    [],
  );

  const handleAddButtonMapping = useCallback(() => {
    setProfile((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        buttonMappings: [
          ...prev.buttonMappings,
          { sourceIndex: prev.buttonMappings.length, targetButton: 0x1000 },
        ],
      };
    });
  }, []);

  const handleRemoveButtonMapping = useCallback((removeIdx: number) => {
    setProfile((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        buttonMappings: prev.buttonMappings.filter((_, i) => i !== removeIdx),
      };
    });
  }, []);

  const handleSaveProfile = useCallback(async () => {
    if (!profile) return;
    await window.openNow.flightSetProfile(profile);
    setSavedIndicator(true);
    setTimeout(() => setSavedIndicator(false), 1500);
    await loadAllProfiles();
    if (isCapturing) {
      const dev = getFlightHidService().getActiveDevice();
      if (dev) await getFlightHidService().startCapture(dev, profile);
    }
  }, [profile, isCapturing, loadAllProfiles]);

  const handleResetProfile = useCallback(async () => {
    if (selectedIdx < 0 || selectedIdx >= devices.length) return;
    const entry = devices[selectedIdx]!;
    const p = await window.openNow.flightResetProfile(entry.vidPid);
    if (p) {
      setProfile({ ...p });
      if (isCapturing) {
        const dev = getFlightHidService().getActiveDevice();
        if (dev) await getFlightHidService().startCapture(dev, p);
      }
    }
    await loadAllProfiles();
  }, [selectedIdx, devices, isCapturing, loadAllProfiles]);

  const handleDeleteProfile = useCallback(
    async (vidPid: string, gameId?: string) => {
      await window.openNow.flightDeleteProfile(vidPid, gameId);
      await loadAllProfiles();
    },
    [loadAllProfiles],
  );

  const selectedVidPid = selectedIdx >= 0 && selectedIdx < devices.length ? devices[selectedIdx]!.vidPid : "";
  const mappingKey = `${selectedVidPid}:${slot}`;

  return (
    <>
      {/* Enable toggle */}
      <div className="settings-row">
        <label className="settings-label">Enable Flight Controls</label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onSettingChange("flightControlsEnabled", e.target.checked)}
          />
          <span className="settings-toggle-track" />
        </label>
      </div>

      {enabled && !webHidSupported && (
        <div className="settings-row">
          <span className="settings-subtle-hint" style={{ color: "var(--error)" }}>
            WebHID is not available in this browser / Electron version.
          </span>
        </div>
      )}

      {enabled && webHidSupported && (
        <>
          {/* Controller slot */}
          <div className="settings-row">
            <label className="settings-label">Controller Slot</label>
            <select
              className="settings-text-input"
              style={{ minWidth: 90, maxWidth: 110 }}
              value={slot}
              onChange={(e) => onSettingChange("flightControlsSlot", Number(e.target.value))}
            >
              {[0, 1, 2, 3].map((s) => (
                <option key={s} value={s}>Slot {s}</option>
              ))}
            </select>
          </div>

          {/* Show all devices toggle */}
          <div className="settings-row">
            <label className="settings-label">
              <Eye size={14} style={{ verticalAlign: "-2px", marginRight: 6, opacity: 0.5 }} />
              Show All HID Devices
            </label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={showAllDevices}
                onChange={(e) => {
                  setShowAllDevices(e.target.checked);
                  void refreshDevices(e.target.checked);
                }}
              />
              <span className="settings-toggle-track" />
            </label>
          </div>

          {/* Device selection or pair prompt */}
          {devices.length === 0 ? (
            <>
              <div className="settings-row settings-row--column">
                <button
                  type="button"
                  className="settings-shortcut-reset-btn"
                  style={{ color: "var(--accent)", borderColor: "rgba(88,217,138,0.35)", alignSelf: "flex-start" }}
                  onClick={() => void handlePairDevice()}
                >
                  <Plus size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                  Pair Flight Device
                </button>
                <span className="settings-subtle-hint" style={{ marginTop: 4 }}>
                  Devices must be paired once. They remain available after pairing.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="settings-row settings-row--column">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                  <label className="settings-label">Device</label>
                  <button
                    type="button"
                    className="settings-shortcut-reset-btn"
                    onClick={() => void handlePairDevice()}
                    style={{ fontSize: "0.72rem", padding: "3px 8px" }}
                  >
                    <Plus size={11} style={{ verticalAlign: "-1px", marginRight: 3 }} />
                    Pair New
                  </button>
                </div>
                <select
                  className="settings-text-input"
                  style={{ width: "100%" }}
                  value={selectedIdx}
                  onChange={(e) => {
                    const idx = Number(e.target.value);
                    setSelectedIdx(idx);
                  }}
                  disabled={isCapturing}
                >
                  <option value={-1}>Select device…</option>
                  {devices.map((entry, i) => (
                    <option key={`${entry.vidPid}-${i}`} value={i}>
                      {entry.label}  ({entry.vidPid}){!entry.isFlight ? "  [other]" : ""}
                    </option>
                  ))}
                </select>
                <span className="settings-subtle-hint">
                  Devices must be paired once. They remain available after pairing.
                </span>
              </div>

              {/* Start / Stop capture */}
              {selectedIdx >= 0 && (
                <div className="settings-row">
                  <label className="settings-label">Capture</label>
                  {!isCapturing ? (
                    <button
                      type="button"
                      className="settings-shortcut-reset-btn"
                      style={{ color: "var(--accent)", borderColor: "rgba(88,217,138,0.35)" }}
                      onClick={() => void handleStartCapture()}
                      disabled={!profile}
                    >
                      <Joystick size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                      Start Capture
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="settings-shortcut-reset-btn"
                      style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.35)" }}
                      onClick={handleStopCapture}
                    >
                      Stop Capture
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Live tester ──────────────────────────────── */}
          {isCapturing && flightState && (
            <div className="flight-tester">
              <div className="flight-tester-status">
                <span className={`flight-status-dot${flightState.connected ? " connected" : ""}`} />
                <span>{flightState.deviceName || "Device"}</span>
              </div>

              {flightState.axes.length > 0 && (
                <div className="flight-axes-grid">
                  {flightState.axes.map((val, i) => (
                    <div key={i} className="flight-axis-bar">
                      <span className="flight-axis-label">A{i}</span>
                      <div className="flight-axis-track">
                        <div className="flight-axis-fill" style={{ width: `${(val * 100).toFixed(1)}%` }} />
                      </div>
                      <span className="flight-axis-value">{val.toFixed(3)}</span>
                    </div>
                  ))}
                </div>
              )}

              {flightState.buttons.length > 0 && (
                <div className="flight-buttons-grid">
                  {flightState.buttons.map((pressed, i) => (
                    <span key={i} className={`flight-button-indicator${pressed ? " pressed" : ""}`} title={`B${i}`}>
                      {i}
                    </span>
                  ))}
                </div>
              )}

              {flightState.hatSwitch >= 0 && (
                <div className="flight-hat-indicator">Hat: {flightState.hatSwitch}</div>
              )}

              {flightState.rawBytes.length > 0 && (
                <details className="flight-raw-bytes">
                  <summary>Raw Bytes ({flightState.rawBytes.length})</summary>
                  <code className="flight-raw-bytes-data">
                    {flightState.rawBytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")}
                  </code>
                </details>
              )}
            </div>
          )}

          {/* ── Axis + Button mappings (keyed to force remount) ─ */}
          {profile && (
            <div className="flight-mapping-section" key={mappingKey}>
              <div className="flight-mapping-header">
                <h3>Axis Mappings</h3>
              </div>
              <div className="flight-mappings-list">
                {profile.axisMappings.map((m, i) => (
                  <div key={i} className="flight-mapping-row">
                    <span className="flight-mapping-source">Axis {m.sourceIndex}</span>
                    <div className="flight-mapping-fields">
                      <div className="flight-mapping-field">
                        <span>Target</span>
                        <select
                          className="settings-text-input"
                          style={{ minWidth: 140, fontSize: "0.78rem", padding: "4px 8px" }}
                          value={m.target}
                          onChange={(e) => handleAxisMappingChange(i, "target", e.target.value)}
                        >
                          {AXIS_TARGETS.map((t) => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flight-mapping-field flight-mapping-field--checkbox">
                        <input
                          type="checkbox"
                          checked={m.inverted}
                          onChange={(e) => handleAxisMappingChange(i, "inverted", e.target.checked)}
                        />
                        <span>Invert</span>
                      </div>
                      <div className="flight-mapping-field">
                        <span>Deadzone</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="range"
                            min={0} max={0.5} step={0.01}
                            value={m.deadzone}
                            onChange={(e) => handleAxisMappingChange(i, "deadzone", parseFloat(e.target.value) || 0)}
                            style={{ width: 80 }}
                          />
                          <span className="flight-mapping-value">{m.deadzone.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="flight-mapping-field">
                        <span>Sensitivity</span>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input
                            type="range"
                            min={0.1} max={3} step={0.1}
                            value={m.sensitivity}
                            onChange={(e) => handleAxisMappingChange(i, "sensitivity", parseFloat(e.target.value) || 1)}
                            style={{ width: 80 }}
                          />
                          <span className="flight-mapping-value">{m.sensitivity.toFixed(1)}</span>
                        </div>
                      </div>
                      <div className="flight-mapping-field">
                        <span>Curve</span>
                        <select
                          className="settings-text-input"
                          style={{ minWidth: 90, fontSize: "0.78rem", padding: "4px 8px" }}
                          value={m.curve}
                          onChange={(e) => handleAxisMappingChange(i, "curve", e.target.value)}
                        >
                          {CURVE_OPTIONS.map((c) => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* ── Button mappings ──────────────────────── */}
              <div className="flight-mapping-header" style={{ marginTop: 12 }}>
                <h3>Button Mappings</h3>
                <button
                  type="button"
                  className="settings-shortcut-reset-btn"
                  onClick={handleAddButtonMapping}
                >
                  <Plus size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                  Add
                </button>
              </div>
              <div className="flight-mappings-list">
                {profile.buttonMappings.map((m, i) => (
                  <div key={i} className="flight-mapping-row" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <div className="flight-mapping-fields">
                      <div className="flight-mapping-field">
                        <span>Source</span>
                        <input
                          type="number"
                          className="settings-text-input settings-text-input--narrow"
                          style={{ fontSize: "0.78rem", padding: "4px 8px" }}
                          value={m.sourceIndex}
                          min={0}
                          onChange={(e) => handleButtonMappingChange(i, "sourceIndex", parseInt(e.target.value, 10) || 0)}
                        />
                      </div>
                      <div className="flight-mapping-field">
                        <span>Target (XInput)</span>
                        <input
                          type="text"
                          className="settings-text-input settings-text-input--narrow"
                          style={{ fontSize: "0.78rem", padding: "4px 8px", fontFamily: "var(--font-mono, monospace)" }}
                          value={`0x${m.targetButton.toString(16).toUpperCase().padStart(4, "0")}`}
                          onChange={(e) => {
                            const val = parseInt(e.target.value.replace(/^0x/i, ""), 16);
                            if (!Number.isNaN(val)) handleButtonMappingChange(i, "targetButton", val);
                          }}
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      className="settings-shortcut-reset-btn"
                      style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.25)", padding: "4px 8px" }}
                      onClick={() => handleRemoveButtonMapping(i)}
                      title="Remove"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Save / Reset */}
              <div className="settings-row" style={{ marginTop: 12, justifyContent: "flex-start", gap: 8 }}>
                <button
                  type="button"
                  className="settings-shortcut-reset-btn"
                  style={{ color: "var(--accent)", borderColor: "rgba(88,217,138,0.35)" }}
                  onClick={() => void handleSaveProfile()}
                >
                  {savedIndicator ? <Check size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} /> : <Save size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />}
                  {savedIndicator ? "Saved" : "Save Profile"}
                </button>
                <button
                  type="button"
                  className="settings-shortcut-reset-btn"
                  onClick={() => void handleResetProfile()}
                >
                  <RotateCcw size={12} style={{ verticalAlign: "-1px", marginRight: 4 }} />
                  Reset to Default
                </button>
              </div>
            </div>
          )}

          {/* ── Saved profiles ───────────────────────────── */}
          {allProfiles.length > 0 && (
            <div className="flight-profiles-section">
              <h3>Saved Profiles</h3>
              <div className="flight-profiles-list">
                {allProfiles.map((p, i) => (
                  <div key={`${p.vidPid}-${p.gameId ?? "global"}-${i}`} className="flight-profile-row">
                    <div className="flight-profile-info">
                      <span className="flight-profile-name">{p.name}</span>
                      <span className="flight-profile-meta">
                        {p.vidPid}
                        {p.gameId ? ` · Game: ${p.gameId}` : " · Global"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="settings-shortcut-reset-btn"
                      style={{ color: "#ef4444", borderColor: "rgba(239,68,68,0.25)", padding: "4px 8px" }}
                      onClick={() => void handleDeleteProfile(p.vidPid, p.gameId)}
                      title="Delete profile"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
