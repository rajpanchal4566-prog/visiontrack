import { useState, useEffect } from 'react';
import {
  X, Camera, MapPin, Navigation, Video, RefreshCw, Play, Square,
  CheckCircle2, XCircle, ShieldCheck, AlertCircle, Radio, Compass,
} from 'lucide-react';
import { camerasApi } from '../services/api';
import { resolveRtspUrl } from '../utils/rtspUrlResolver';
import './CameraRegistrationModal.css';

const DEFAULT_PRESETS = [
  { id: 'generic', name: 'Generic RTSP / ONVIF', template: 'rtsp://[username]:[password]@[ip]:554/live/ch0', port: 554, defaultTransport: 'tcp' },
  { id: 'hikvision', name: 'Hikvision', template: 'rtsp://[username]:[password]@[ip]:554/Streaming/Channels/101', port: 554, defaultTransport: 'tcp' },
  { id: 'dahua', name: 'Dahua / CP PLUS', template: 'rtsp://[username]:[password]@[ip]:554/cam/realmonitor?channel=1&subtype=0', port: 554, defaultTransport: 'tcp' },
  { id: 'uniview', name: 'Uniview (UNV)', template: 'rtsp://[username]:[password]@[ip]:554/media/video1', port: 554, defaultTransport: 'tcp' },
  { id: 'axis', name: 'Axis Communications', template: 'rtsp://[username]:[password]@[ip]:554/axis-media/media.amp', port: 554, defaultTransport: 'tcp' },
  { id: 'hanwha', name: 'Hanwha / Samsung', template: 'rtsp://[username]:[password]@[ip]:554/profile2/media.smp', port: 554, defaultTransport: 'tcp' },
  { id: 'tapo', name: 'TP-Link Tapo', template: 'rtsp://[username]:[password]@[ip]:554/stream1', port: 554, defaultTransport: 'tcp' },
  { id: 'reolink', name: 'Reolink', template: 'rtsp://[username]:[password]@[ip]:554/h264Preview_01_main', port: 554, defaultTransport: 'tcp' },
  { id: 'mobile_ipwebcam', name: 'Mobile (IP Webcam)', template: 'http://[ip]:8080/video', port: 8080, defaultTransport: 'tcp' },
  { id: 'mobile_droidcam', name: 'Mobile (DroidCam)', template: 'http://[ip]:4747/mjpegfeed', port: 4747, defaultTransport: 'tcp' },
  { id: 'custom', name: 'Custom RTSP URL', template: '', port: 554, defaultTransport: 'tcp' },
];

export default function CameraRegistrationModal({
  isOpen,
  onClose,
  camera = null,
  onSuccess,
  presets: propPresets = null,
}) {
  const presets = propPresets && propPresets.length > 0 ? propPresets : DEFAULT_PRESETS;

  // Form states
  const [name, setName] = useState('');
  const [zone, setZone] = useState('');
  const [city, setCity] = useState('Hyderabad');
  const [road, setRoad] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [speedLimit, setSpeedLimit] = useState(50);

  // RTSP builder states
  const [selectedPreset, setSelectedPreset] = useState('generic');
  const [ip, setIp] = useState('192.168.1.100');
  const [port, setPort] = useState('554');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [path, setPath] = useState('live/ch0');
  const [customUrl, setCustomUrl] = useState('');
  const [transport, setTransport] = useState('tcp');
  const [sampleFps, setSampleFps] = useState(8);

  // Violation detection toggles
  const [detectHelmet, setDetectHelmet] = useState(true);
  const [detectSeatbelt, setDetectSeatbelt] = useState(true);
  const [detectSpeeding, setDetectSpeeding] = useState(true);

  // Status & action states
  const [isLocating, setIsLocating] = useState(false);
  const [geoStatus, setGeoStatus] = useState(null);
  const [testStatus, setTestStatus] = useState({ loading: false, result: null });
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    if (!isOpen) return;

    setValidationError('');
    setGeoStatus(null);
    setTestStatus({ loading: false, result: null });

    if (camera) {
      setName(camera.name || '');
      setZone(camera.zone || '');
      setCity(camera.city || 'Hyderabad');
      setRoad(camera.road || camera.address || '');
      setLat(camera.lat !== undefined && camera.lat !== null ? String(camera.lat) : '');
      setLng(camera.lng !== undefined && camera.lng !== null ? String(camera.lng) : '');
      setSpeedLimit(camera.speed_limit_kmh || 50);
      setTransport(camera.rtsp_transport || 'tcp');
      setSampleFps(camera.sample_fps || 8);
      setDetectHelmet(camera.detect_helmet !== 0);
      setDetectSeatbelt(camera.detect_seatbelt !== 0);
      setDetectSpeeding(camera.detect_speeding !== 0);

      if (camera.rtsp_url) {
        setSelectedPreset('custom');
        setCustomUrl(camera.rtsp_url);
      } else {
        setSelectedPreset('generic');
        setCustomUrl('');
      }
    } else {
      setName('Traffic ANPR Node');
      setZone('Zone-1');
      setCity('Hyderabad');
      setRoad('');
      setLat('');
      setLng('');
      setSpeedLimit(60);
      setSelectedPreset('generic');
      setIp('192.168.1.100');
      setPort('554');
      setUsername('admin');
      setPassword('');
      setPath('live/ch0');
      setCustomUrl('');
      setTransport('tcp');
      setSampleFps(8);
      setDetectHelmet(true);
      setDetectSeatbelt(true);
      setDetectSpeeding(true);
    }
  }, [isOpen, camera]);

  if (!isOpen) return null;

  // Resolve RTSP stream URL
  function computeRtspUrl() {
    return resolveRtspUrl(
      {
        selectedPreset,
        customUrl,
        ip,
        port,
        username,
        password,
        path,
      },
      { presets }
    );
  }

  // Handle Preset Selection
  function handlePresetSelect(presetId) {
    setSelectedPreset(presetId);
    setTestStatus({ loading: false, result: null });
    const p = presets.find(item => item.id === presetId);
    if (!p) return;
    if (p.port) setPort(String(p.port));
    if (p.defaultTransport) setTransport(p.defaultTransport);
  }

  // "Use My Current Location" via Browser Geolocation API
  function handleUseCurrentLocation() {
    if (!navigator.geolocation) {
      setGeoStatus({
        success: false,
        message: 'Geolocation is not supported by your browser.',
      });
      return;
    }

    setIsLocating(true);
    setGeoStatus({ success: null, message: 'Acquiring GPS fix from device...' });

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;
        const accuracy = Math.round(position.coords.accuracy || 0);

        setLat(userLat.toFixed(6));
        setLng(userLng.toFixed(6));
        setIsLocating(false);
        setGeoStatus({
          success: true,
          message: `GPS Coordinates acquired: ${userLat.toFixed(6)}, ${userLng.toFixed(6)} (±${accuracy}m accuracy)`,
        });
        setValidationError('');
      },
      (error) => {
        setIsLocating(false);
        let errorMsg = 'Unable to retrieve location.';
        if (error.code === error.PERMISSION_DENIED) {
          errorMsg = 'Location access permission was denied. Please allow location access or enter coordinates manually.';
        } else if (error.code === error.POSITION_UNAVAILABLE) {
          errorMsg = 'Location information is currently unavailable.';
        } else if (error.code === error.TIMEOUT) {
          errorMsg = 'Location request timed out. Please enter coordinates manually.';
        }
        setGeoStatus({ success: false, message: errorMsg });
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );
  }

  // Test RTSP Connection
  async function handleTestStream() {
    const url = computeRtspUrl();
    if (!url) {
      setTestStatus({ loading: false, result: { success: false, error: 'Please enter a valid RTSP stream URL or IP configuration.' } });
      return;
    }
    setTestStatus({ loading: true, result: null });
    try {
      const res = await camerasApi.testStream(url, transport);
      setTestStatus({ loading: false, result: res });
    } catch (err) {
      setTestStatus({ loading: false, result: { success: false, error: err.message } });
    }
  }

  // Validate and Save
  async function handleSave(andConnect = false) {
    setValidationError('');

    const trimmedName = name.trim();
    const trimmedZone = zone.trim();
    const trimmedCity = city.trim();
    const parsedLat = parseFloat(lat);
    const parsedLng = parseFloat(lng);

    // Identity and Coordinate validation (Required for ALL cameras)
    if (!trimmedName) {
      setValidationError('Camera Name is required.');
      return;
    }
    if (!trimmedZone) {
      setValidationError('Zone / Location Tag is required.');
      return;
    }
    if (lat === '' || isNaN(parsedLat) || parsedLat < -90 || parsedLat > 90) {
      setValidationError('A valid Latitude between -90 and 90 is required.');
      return;
    }
    if (lng === '' || isNaN(parsedLng) || parsedLng < -180 || parsedLng > 180) {
      setValidationError('A valid Longitude between -180 and 180 is required.');
      return;
    }

    const streamUrl = computeRtspUrl();
    if (andConnect && !streamUrl) {
      setValidationError('An RTSP or HTTP stream URL is required to initiate live connection.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        zone: trimmedZone,
        city: trimmedCity || 'Hyderabad',
        road: road.trim() || null,
        lat: parsedLat,
        lng: parsedLng,
        speed_limit_kmh: Number(speedLimit) || 50,
        rtsp_url: streamUrl || null,
        rtsp_transport: transport,
        sample_fps: Number(sampleFps) || 8.0,
        detect_helmet: detectHelmet ? 1 : 0,
        detect_seatbelt: detectSeatbelt ? 1 : 0,
        detect_speeding: detectSpeeding ? 1 : 0,
      };

      let savedRecord = null;
      if (camera?.id) {
        savedRecord = await camerasApi.updateConfig(camera.id, payload);
        if (andConnect && streamUrl) {
          await camerasApi.connectStream(camera.id, streamUrl, {
            transport,
            sample_fps: Number(sampleFps) || 8.0,
          });
        }
      } else {
        savedRecord = await camerasApi.create(payload);
        if (savedRecord?.id && andConnect && streamUrl) {
          await camerasApi.connectStream(savedRecord.id, streamUrl, {
            transport,
            sample_fps: Number(sampleFps) || 8.0,
          });
        }
      }

      if (onSuccess) onSuccess(savedRecord);
      onClose();
    } catch (err) {
      setValidationError(`Failed to save camera: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Disconnect stream for an existing camera
  async function handleDisconnect() {
    if (!camera?.id) return;
    setSaving(true);
    try {
      await camerasApi.disconnectStream(camera.id);
      if (onSuccess) onSuccess(camera);
      onClose();
    } catch (err) {
      setValidationError(`Failed to disconnect stream: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  const isStreamActive = camera && ['starting', 'running', 'reconnecting'].includes(camera.stream_status);

  return (
    <div className="cam-modal-backdrop animate-fade-in" onClick={onClose}>
      <div className="cam-modal-card card tactical-border-cross animate-scale-in" onClick={e => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="cam-modal-header">
          <div className="cam-modal-title-group">
            <div className="cam-modal-tag font-mono">
              <Camera size={14} className="text-cyan" />
              <span>{camera ? `NODE CONFIGURATION // ${camera.id}` : 'NEW SENSOR REGISTRATION // RTSP & EDGE'}</span>
            </div>
            <h2 className="cam-modal-title font-display">
              {camera ? `Edit Camera Node (${camera.name})` : 'Register ANPR Camera'}
            </h2>
          </div>
          <button className="cam-modal-close-btn" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="cam-modal-body">
          {/* Validation Alert */}
          {validationError && (
            <div className="cam-modal-alert cam-modal-alert--error font-mono">
              <AlertCircle size={16} />
              <span>{validationError}</span>
            </div>
          )}

          {/* Section 1: Camera Identity & Geographic Positioning */}
          <div className="cam-modal-section">
            <div className="cam-modal-section-header">
              <div className="cam-modal-section-title font-mono text-cyan">
                <MapPin size={15} />
                <span>1. CAMERA IDENTITY & GEOGRAPHIC COORDINATES</span>
              </div>
              <span className="text-outline font-mono text-xs">* REQUIRED FOR GIS MAPPING</span>
            </div>

            <div className="cam-modal-grid-3">
              <div className="cam-form-group">
                <label className="cam-form-label font-mono">Camera Name *</label>
                <input
                  className="cam-form-input font-mono"
                  placeholder="e.g. Hitec City Junction North"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  required
                />
              </div>

              <div className="cam-form-group">
                <label className="cam-form-label font-mono">Zone / Location Tag *</label>
                <input
                  className="cam-form-input font-mono"
                  placeholder="e.g. Cyberabad-Sector-1"
                  value={zone}
                  onChange={e => setZone(e.target.value)}
                  required
                />
              </div>

              <div className="cam-form-group">
                <label className="cam-form-label font-mono">City / District</label>
                <input
                  className="cam-form-input font-mono"
                  placeholder="e.g. Hyderabad"
                  value={city}
                  onChange={e => setCity(e.target.value)}
                />
              </div>
            </div>

            {/* Coordinates & Geolocation Toolbar */}
            <div className="cam-coords-card card">
              <div className="cam-coords-header">
                <div className="cam-coords-tag font-mono">
                  <Compass size={14} className="text-cyan" />
                  <span>GPS COORDINATES (WGS-84 LAT / LNG)</span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary cam-geo-btn font-mono"
                  onClick={handleUseCurrentLocation}
                  disabled={isLocating}
                  title="Auto-fill coordinates using browser GPS (useful if configuring physically on-site)"
                >
                  <Navigation size={13} className={isLocating ? 'animate-spin text-cyan' : 'text-cyan'} />
                  <span>{isLocating ? 'ACQUIRING GPS...' : 'USE MY CURRENT LOCATION'}</span>
                </button>
              </div>

              <div className="cam-modal-grid-2">
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Latitude (°N/S) *</label>
                  <input
                    type="number"
                    step="any"
                    className="cam-form-input font-mono"
                    placeholder="e.g. 17.448500"
                    value={lat}
                    onChange={e => setLat(e.target.value)}
                    required
                  />
                </div>

                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Longitude (°E/W) *</label>
                  <input
                    type="number"
                    step="any"
                    className="cam-form-input font-mono"
                    placeholder="e.g. 78.374200"
                    value={lng}
                    onChange={e => setLng(e.target.value)}
                    required
                  />
                </div>
              </div>

              {/* Geolocation Status Feedback */}
              {geoStatus && (
                <div className={`cam-geo-status font-mono ${geoStatus.success ? 'cam-geo-status--success' : geoStatus.success === false ? 'cam-geo-status--error' : 'cam-geo-status--loading'}`}>
                  {geoStatus.success ? <CheckCircle2 size={14} /> : geoStatus.success === false ? <XCircle size={14} /> : <RefreshCw size={14} className="animate-spin" />}
                  <span>{geoStatus.message}</span>
                </div>
              )}

              <div className="cam-coords-footer font-mono text-xs text-outline">
                Coordinates are directly plotted onto the GIS topology map and used for haversine travel validation.
              </div>
            </div>

            <div className="cam-modal-grid-2" style={{ marginTop: '12px' }}>
              <div className="cam-form-group">
                <label className="cam-form-label font-mono">Road / Junction / Address (Optional)</label>
                <input
                  className="cam-form-input font-mono"
                  placeholder="e.g. Inorbit Mall Road Gate 2"
                  value={road}
                  onChange={e => setRoad(e.target.value)}
                />
              </div>

              <div className="cam-form-group">
                <label className="cam-form-label font-mono">Speed Limit (km/h)</label>
                <input
                  type="number"
                  min="10"
                  max="160"
                  className="cam-form-input font-mono"
                  value={speedLimit}
                  onChange={e => setSpeedLimit(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Section 2: RTSP Video Stream Ingestion */}
          <div className="cam-modal-section">
            <div className="cam-modal-section-header">
              <div className="cam-modal-section-title font-mono text-cyan">
                <Video size={15} />
                <span>2. RTSP STREAM CONFIGURATION & CONNECTIVITY</span>
              </div>
              <span className="text-outline font-mono text-xs">H.264 / H.265 / MJPEG</span>
            </div>

            {/* Manufacturer Presets */}
            <div className="cam-presets-container">
              <span className="cam-presets-label font-mono text-xs text-outline">MANUFACTURER PRESET:</span>
              <div className="cam-presets-pills">
                {presets.map(p => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cam-preset-pill font-mono ${selectedPreset === p.id ? 'cam-preset-pill--active' : ''}`}
                    onClick={() => handlePresetSelect(p.id)}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {selectedPreset !== 'custom' ? (
              <div className="cam-modal-grid-4">
                <div className="cam-form-group" style={{ gridColumn: 'span 2' }}>
                  <label className="cam-form-label font-mono">Camera IP / Hostname</label>
                  <input
                    className="cam-form-input font-mono"
                    placeholder="192.168.1.100"
                    value={ip}
                    onChange={e => setIp(e.target.value)}
                  />
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Port</label>
                  <input
                    className="cam-form-input font-mono"
                    placeholder="554"
                    value={port}
                    onChange={e => setPort(e.target.value)}
                  />
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Stream Path</label>
                  <input
                    className="cam-form-input font-mono"
                    placeholder="live/ch0"
                    value={path}
                    onChange={e => setPath(e.target.value)}
                  />
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Username</label>
                  <input
                    className="cam-form-input font-mono"
                    placeholder="admin"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                  />
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Password</label>
                  <input
                    type="password"
                    className="cam-form-input font-mono"
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                  />
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Transport</label>
                  <select
                    className="cam-form-select font-mono"
                    value={transport}
                    onChange={e => setTransport(e.target.value)}
                  >
                    <option value="tcp">TCP (Stable)</option>
                    <option value="udp">UDP (Low Latency)</option>
                  </select>
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Sample FPS</label>
                  <input
                    type="number"
                    min="0.5"
                    max="10"
                    step="0.5"
                    className="cam-form-input font-mono"
                    value={sampleFps}
                    onChange={e => setSampleFps(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="cam-modal-grid-2">
                <div className="cam-form-group" style={{ gridColumn: 'span 2' }}>
                  <label className="cam-form-label font-mono">Full RTSP / Stream URL</label>
                  <input
                    className="cam-form-input font-mono"
                    placeholder="rtsp://admin:pass@192.168.1.50:554/Streaming/Channels/101"
                    value={customUrl}
                    onChange={e => setCustomUrl(e.target.value)}
                  />
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Transport Protocol</label>
                  <select
                    className="cam-form-select font-mono"
                    value={transport}
                    onChange={e => setTransport(e.target.value)}
                  >
                    <option value="tcp">TCP (Interleaved / Reliable)</option>
                    <option value="udp">UDP (Direct)</option>
                  </select>
                </div>
                <div className="cam-form-group">
                  <label className="cam-form-label font-mono">Sampling FPS (0.5 - 10)</label>
                  <input
                    type="number"
                    min="0.5"
                    max="10"
                    step="0.5"
                    className="cam-form-input font-mono"
                    value={sampleFps}
                    onChange={e => setSampleFps(e.target.value)}
                  />
                </div>
              </div>
            )}

            {/* Resolved Preview URL & Connection Test */}
            <div className="cam-stream-test-card card">
              <div className="cam-stream-test-bar font-mono">
                <span className="text-outline text-xs">RESOLVED PIPELINE:</span>
                <code className="text-cyan cam-resolved-url">{computeRtspUrl() || '(No stream configured)'}</code>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary font-mono cam-test-btn"
                  onClick={handleTestStream}
                  disabled={testStatus.loading || !computeRtspUrl()}
                >
                  {testStatus.loading ? <RefreshCw size={13} className="animate-spin text-cyan" /> : <Play size={13} className="text-cyan" />}
                  <span>{testStatus.loading ? 'TESTING...' : 'TEST CONNECTION'}</span>
                </button>
              </div>

              {testStatus.result && (
                <div className={`cam-test-banner font-mono ${testStatus.result.success ? 'cam-test-banner--success' : 'cam-test-banner--error'}`}>
                  {testStatus.result.success ? (
                    <div className="cam-test-success-content">
                      <CheckCircle2 size={16} />
                      <span>RTSP Stream Reachable! Resolution verified.</span>
                      {testStatus.result.preview && (
                        <img src={testStatus.result.preview} alt="Frame snapshot" className="cam-test-thumb" />
                      )}
                    </div>
                  ) : (
                    <div className="cam-test-error-content">
                      <XCircle size={16} />
                      <span>Connection Failed: {testStatus.result.error || 'Network timeout or invalid RTSP credentials'}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Section 3: AI Multi-Violation Detection Policies */}
          <div className="cam-modal-section">
            <div className="cam-modal-section-header">
              <div className="cam-modal-section-title font-mono text-cyan">
                <ShieldCheck size={15} />
                <span>3. AI ENFORCEMENT & VIOLATION POLICIES</span>
              </div>
            </div>

            <div className="cam-toggles-grid">
              <label className="cam-toggle-card card">
                <input
                  type="checkbox"
                  checked={detectHelmet}
                  onChange={e => setDetectHelmet(e.target.checked)}
                />
                <div className="cam-toggle-info font-mono">
                  <span className="cam-toggle-title">HELMET ENFORCEMENT</span>
                  <span className="text-outline text-xs">Flag two-wheelers with missing rider/pillion helmets</span>
                </div>
              </label>

              <label className="cam-toggle-card card">
                <input
                  type="checkbox"
                  checked={detectSeatbelt}
                  onChange={e => setDetectSeatbelt(e.target.checked)}
                />
                <div className="cam-toggle-info font-mono">
                  <span className="cam-toggle-title">SEATBELT ENFORCEMENT</span>
                  <span className="text-outline text-xs">Flag four-wheelers with unfastened driver seatbelts</span>
                </div>
              </label>

              <label className="cam-toggle-card card">
                <input
                  type="checkbox"
                  checked={detectSpeeding}
                  onChange={e => setDetectSpeeding(e.target.checked)}
                />
                <div className="cam-toggle-info font-mono">
                  <span className="cam-toggle-title">SPEED LIMIT VIOLATIONS</span>
                  <span className="text-outline text-xs">Calculate radar/haversine speed vs. {speedLimit} km/h limit</span>
                </div>
              </label>
            </div>
          </div>
        </div>

        {/* Modal Footer Actions */}
        <div className="cam-modal-footer">
          <div className="cam-modal-footer-left">
            {isStreamActive && (
              <button
                type="button"
                className="btn btn-sm btn-danger font-mono"
                onClick={handleDisconnect}
                disabled={saving}
              >
                <Square size={13} />
                <span>DISCONNECT ACTIVE STREAM</span>
              </button>
            )}
          </div>

          <div className="cam-modal-footer-right">
            <button
              type="button"
              className="btn btn-secondary font-mono"
              onClick={onClose}
              disabled={saving}
            >
              CANCEL
            </button>

            <button
              type="button"
              className="btn btn-secondary font-mono"
              onClick={() => handleSave(false)}
              disabled={saving}
            >
              {saving ? 'SAVING...' : 'SAVE CAMERA NODE'}
            </button>

            <button
              type="button"
              className="btn btn-primary hud-glow-cyan font-mono"
              onClick={() => handleSave(true)}
              disabled={saving}
            >
              <Radio size={14} />
              <span>{saving ? 'CONNECTING...' : 'SAVE & CONNECT STREAM'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
