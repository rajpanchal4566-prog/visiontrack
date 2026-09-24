import { useState, useEffect, useRef } from 'react';
import {
  Camera, MapPin, Clock, Gauge, Maximize2, ShieldAlert, AlertTriangle,
  Play, Square, Settings, Upload, CheckCircle2, XCircle, RefreshCw,
  X, Radio, Video, Sliders, Eye, Sparkles, AlertOctagon, Car, Disc
} from 'lucide-react';
import { camerasApi, detectionsApi, mediaApi } from '../../services/api';
import { onStreamFrame, onNewDetection, onNewAlert } from '../../services/socket';
import { API_ORIGIN } from '../../services/config';
import CameraRegistrationModal from '../../components/CameraRegistrationModal';
import './LiveMonitoring.css';

export default function LiveMonitoring() {
  const [activeTab, setActiveTab] = useState('cameras'); // 'cameras' | 'studio'
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [cameraDetections, setCameraDetections] = useState({});
  const [zoneFilter, setZoneFilter] = useState('all');
  const [presets, setPresets] = useState([]);

  // Multi-Camera Live Stream HUD State
  const [hudModalCamera, setHudModalCamera] = useState(null);
  const [liveOverlay, setLiveOverlay] = useState(null); // Active stream overlay (for Studio or selected cam)
  const [liveFps, setLiveFps] = useState(0);
  const [liveOverlays, setLiveOverlays] = useState({}); // cameraId -> frameData
  const [cameraFps, setCameraFps] = useState({}); // cameraId -> live FPS
  const lastCameraFrameTimesRef = useRef({});
  const lastGlobalFrameTimeRef = useRef(Date.now());
  const [capacityInfo, setCapacityInfo] = useState(null);
  const [isBulkOperating, setIsBulkOperating] = useState(false);
  const [recentLiveDetections, setRecentLiveDetections] = useState([]);

  // Camera Setup / Config Modal State
  const [configModalCamera, setConfigModalCamera] = useState(null);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);

  // Video File ANPR Studio State
  const [videoFile, setVideoFile] = useState(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const [videoJob, setVideoJob] = useState(null);
  const [studioDetections, setStudioDetections] = useState([]);
  const [studioCameraId, setStudioCameraId] = useState('');

  // Fetch initial cameras and presets
  async function fetchCameras() {
    try {
      const cams = await camerasApi.getAll();
      setCameras(cams);
      const detsMap = {};
      for (const cam of cams.slice(0, 12)) {
        try {
          const data = await detectionsApi.getAll({ camera: cam.id, limit: 5 });
          detsMap[cam.id] = data.detections || [];
        } catch { detsMap[cam.id] = []; }
      }
      setCameraDetections(detsMap);
    } catch (err) {
      console.error('Failed to fetch cameras:', err);
    }
  }

  async function fetchPresets() {
    try {
      const p = await camerasApi.getPresets();
      setPresets(p || []);
    } catch {
      setPresets([]);
    }
  }

  async function fetchCapacity() {
    try {
      const cap = await camerasApi.getStreamsStatus();
      setCapacityInfo(cap);
    } catch (_) {}
  }

  useEffect(() => {
    fetchCameras();
    fetchPresets();
    fetchCapacity();

    // Periodic status refresh for background streams & capacity
    const interval = setInterval(() => {
      fetchCapacity();
    }, 6000);

    return () => clearInterval(interval);
  }, []);

  // Listen to Socket.IO real-time stream frames and new detections
  useEffect(() => {
    const unsubFrame = onStreamFrame((frameData) => {
      const now = Date.now();
      const globalDt = (now - lastGlobalFrameTimeRef.current) / 1000;
      lastGlobalFrameTimeRef.current = now;
      if (globalDt > 0 && globalDt < 10) setLiveFps(Math.round(1 / globalDt));

      // Always update liveOverlay for Studio viewer
      setLiveOverlay(frameData);

      const camId = frameData.cameraId;
      if (camId) {
        const prevTime = lastCameraFrameTimesRef.current[camId] || now;
        const dt = (now - prevTime) / 1000;
        lastCameraFrameTimesRef.current[camId] = now;

        if (dt > 0 && dt < 10) {
          const instFps = Math.round(1 / dt);
          setCameraFps(prev => ({
            ...prev,
            [camId]: prev[camId] ? Math.round(prev[camId] * 0.7 + instFps * 0.3) : instFps,
          }));
        }

        setLiveOverlays(prev => ({
          ...prev,
          [camId]: frameData,
        }));
      }

      // If active in studio mode or live camera matches
      if (frameData.plate) {
        const detItem = {
          plate: frameData.plate.plate,
          confidence: frameData.plate.confidence,
          speed: frameData.speed,
          violations: frameData.violations || [],
          timestamp: frameData.timestamp,
          vehicle_type: frameData.vehicles?.[0]?.type || 'vehicle',
          camera_id: camId || 'studio',
        };
        setRecentLiveDetections(prev => [detItem, ...prev.slice(0, 19)]);
        setStudioDetections(prev => [detItem, ...prev.slice(0, 29)]);
      }
    });

    const unsubDet = onNewDetection((det) => {
      setCameraDetections(prev => ({
        ...prev,
        [det.camera_id]: [det, ...(prev[det.camera_id] || []).slice(0, 4)],
      }));
      if (det.plate) {
        setRecentLiveDetections(prev => {
          if (prev.some(d => d.plate === det.plate && Math.abs(new Date(d.timestamp || 0) - new Date(det.timestamp || 0)) < 3000)) return prev;
          let viols = [];
          try {
            viols = typeof det.violations === 'string' ? JSON.parse(det.violations || '[]') : (det.violations || []);
          } catch (_) {}
          return [
            {
              plate: det.plate,
              confidence: det.confidence,
              speed: det.speed,
              violations: viols,
              timestamp: det.timestamp,
              vehicle_type: det.vehicle_type || 'vehicle',
              camera_id: det.camera_id,
            },
            ...prev.slice(0, 19),
          ];
        });
      }
    });

    return () => {
      unsubFrame();
      unsubDet();
    };
  }, []);

  // Open Camera Registration / Config Modal
  function openConfigModal(camera = null) {
    setConfigModalCamera(camera);
    setIsConfigModalOpen(true);
  }

  function closeConfigModal() {
    setIsConfigModalOpen(false);
    setConfigModalCamera(null);
  }

  async function handleModalSuccess() {
    await fetchCameras();
    await fetchCapacity();
  }

  // Toggle stream for a single camera tile
  async function toggleStream(cam, e) {
    if (e) e.stopPropagation();
    const isConnected = ['starting', 'running', 'reconnecting'].includes(cam.stream_status);
    try {
      if (isConnected) {
        await camerasApi.disconnectStream(cam.id);
        setLiveOverlays(prev => {
          const next = { ...prev };
          delete next[cam.id];
          return next;
        });
      } else {
        const streamUrl = cam.rtsp_url || prompt('Enter RTSP Stream URL (e.g. rtsp://host:554/stream):');
        if (!streamUrl) return;
        await camerasApi.connectStream(cam.id, streamUrl, {
          transport: cam.rtsp_transport || 'tcp',
          sample_fps: cam.sample_fps || null,
        });
      }
      await fetchCameras();
      await fetchCapacity();
    } catch (err) {
      alert(`Stream toggle error: ${err.message}`);
    }
  }

  // Bulk Stream Controls
  async function handleConnectAll() {
    setIsBulkOperating(true);
    try {
      await camerasApi.connectAllStreams();
      await fetchCameras();
      await fetchCapacity();
    } catch (err) {
      alert(`Connect all streams failed: ${err.message}`);
    } finally {
      setIsBulkOperating(false);
    }
  }

  async function handleDisconnectAll() {
    setIsBulkOperating(true);
    try {
      await camerasApi.disconnectAllStreams();
      setLiveOverlays({});
      await fetchCameras();
      await fetchCapacity();
    } catch (err) {
      alert(`Disconnect all streams failed: ${err.message}`);
    } finally {
      setIsBulkOperating(false);
    }
  }

  // Launch Video File Upload in Studio
  async function handleVideoUpload(e) {
    e.preventDefault();
    if (!videoFile) return;
    setVideoUploading(true);
    setStudioDetections([]);
    try {
      const formData = new FormData();
      formData.append('video', videoFile);
      const camId = studioCameraId || (cameras.length > 0 ? cameras[0].id : 'CAM-001');
      formData.append('camera_id', camId);
      formData.append('start', 'true');
      formData.append('sample_fps', '2');

      const res = await mediaApi.uploadVideoJob(formData);
      setVideoJob(res.job);
      setActiveTab('studio');
    } catch (err) {
      alert(`Video processing failed: ${err.message}`);
    } finally {
      setVideoUploading(false);
    }
  }

  // Quick One-Click Demo with sample video
  async function handleRunSampleDemo() {
    setVideoUploading(true);
    setStudioDetections([]);
    try {
      let response;
      try {
        response = await fetch(`${API_ORIGIN}/uploads/media/demo_traffic.mp4`);
        if (!response.ok) throw new Error('API static not available');
      } catch {
        response = await fetch('/uploads/media/demo_traffic.mp4');
      }
      const blob = await response.blob();
      const file = new File([blob], 'demo_traffic.mp4', { type: 'video/mp4' });
      setVideoFile(file);

      const formData = new FormData();
      formData.append('video', file);
      const camId = studioCameraId || (cameras.length > 0 ? cameras[0].id : 'CAM-001');
      formData.append('camera_id', camId);
      formData.append('start', 'true');
      formData.append('sample_fps', '2');

      const res = await mediaApi.uploadVideoJob(formData);
      setVideoJob(res.job);
      setActiveTab('studio');
    } catch (err) {
      alert(`Demo failed: ${err.message}`);
    } finally {
      setVideoUploading(false);
    }
  }

  const zones = [...new Set(cameras.map(c => c.zone))];
  const filtered = zoneFilter === 'all' ? cameras : cameras.filter(c => c.zone === zoneFilter);

  return (
    <div className="live animate-fade-in">
      {/* Top Banner & Mode Toggle */}
      <div className="live__header">
        <div>
          <h2 className="live__title">
            <Radio className="pulse-indicator" size={20} /> Smart ANPR Live Command Center
          </h2>
          <p className="live__subtitle">
            Real-life RTSP camera streaming, YOLOv8 vehicle & plate detection, and AI multi-violation recognition
          </p>
        </div>

        <div className="live__top-actions">
          <div className="live__tabs">
            <button
              className={`live__tab ${activeTab === 'cameras' ? 'live__tab--active' : ''}`}
              onClick={() => setActiveTab('cameras')}
            >
              <Camera size={15} /> Camera Grid ({cameras.length})
            </button>
            <button
              className={`live__tab ${activeTab === 'studio' ? 'live__tab--active' : ''}`}
              onClick={() => setActiveTab('studio')}
            >
              <Video size={15} /> Video ANPR Studio
            </button>
          </div>

          {activeTab === 'cameras' && (
            <>
              <select className="live__select" value={zoneFilter} onChange={e => setZoneFilter(e.target.value)}>
                <option value="all">All Zones</option>
                {zones.map(z => <option key={z} value={z}>{z}</option>)}
              </select>
              <button className="btn btn-primary" onClick={() => openConfigModal(null)}>
                <Settings size={15} /> Add RTSP Camera
              </button>
            </>
          )}
        </div>
      </div>

      {/* Multi-Camera Stream Manager & System Capacity HUD */}
      {activeTab === 'cameras' && (
        <div className="live__capacity-bar animate-fade-in">
          <div className="live__capacity-stats">
            <div className="live__capacity-item">
              <Radio size={14} className="pulse-indicator" />
              <span>Active Streams:</span>
              <strong>{capacityInfo?.activeStreams ?? cameras.filter(c => ['running', 'starting'].includes(c.stream_status)).length}</strong>
              <span className="live__capacity-badge live__capacity-badge--optimal">
                Max Rec: {capacityInfo?.maxRecommended ?? 4}
              </span>
            </div>

            <div className="live__capacity-item">
              <Gauge size={14} />
              <span>Pipeline Throughput:</span>
              <strong>{capacityInfo?.currentTotalFps ?? Object.values(cameraFps).reduce((a, b) => a + b, 0)} FPS</strong>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                (Target ~{capacityInfo?.targetSystemFps ?? 8} FPS max)
              </span>
            </div>

            <div className="live__capacity-item">
              <span className={`live__capacity-badge live__capacity-badge--${(capacityInfo?.activeStreams || 0) === 0 ? 'idle' : (capacityInfo?.activeStreams || 0) <= 4 ? 'optimal' : 'heavy'}`}>
                {(capacityInfo?.activeStreams || 0) === 0 ? 'IDLE' : (capacityInfo?.activeStreams || 0) <= 4 ? 'OPTIMAL' : 'HEAVY LOAD'}
              </span>
            </div>
          </div>

          <div className="live__capacity-actions">
            <button
              className="live__btn-compact"
              onClick={handleConnectAll}
              disabled={isBulkOperating}
              title="Connect all cameras with saved RTSP URLs"
            >
              <Play size={12} /> Connect All
            </button>
            <button
              className="live__btn-compact live__btn-compact--danger"
              onClick={handleDisconnectAll}
              disabled={isBulkOperating}
              title="Disconnect all active streams"
            >
              <Square size={12} /> Stop All
            </button>
            <button
              className="live__btn-compact"
              onClick={() => { fetchCameras(); fetchCapacity(); }}
              title="Refresh stream status"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>
      )}

      {/* MODE 1: Camera Grid */}
      {activeTab === 'cameras' && (
        <div className="live__grid stagger-children">
          {filtered.map(cam => {
            const dets = cameraDetections[cam.id] || [];
            const isStreaming = cam.stream_status === 'running' || cam.stream_status === 'starting';
            const latestDet = dets[0];
            const camOverlay = liveOverlays[cam.id];
            const liveCamFps = cameraFps[cam.id] || 0;

            return (
              <div
                key={cam.id}
                className={`camera-tile ${cam.status === 'offline' ? 'camera-tile--offline' : ''} ${selectedCamera === cam.id ? 'camera-tile--selected' : ''}`}
                onClick={() => setSelectedCamera(selectedCamera === cam.id ? null : cam.id)}
              >
                <div className="camera-tile__feed">
                  {/* Live HUD Preview if this tile is streaming */}
                  {isStreaming && camOverlay?.preview ? (
                    <img src={camOverlay.preview} alt={cam.name} className="camera-tile__live-img" />
                  ) : (
                    <div className="camera-tile__static"></div>
                  )}

                  {cam.status !== 'offline' && (
                    <>
                      <div className="camera-tile__scan-line"></div>
                      <div className="camera-tile__overlay">
                        {latestDet && (
                          <div className={`camera-tile__detected ${latestDet.flagged ? 'camera-tile__detected--flagged' : ''}`}>
                            <span className="camera-tile__detected-plate mono">{latestDet.plate}</span>
                            {latestDet.flagged && <span className="camera-tile__violation-tag">VIOLATION</span>}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {cam.status === 'offline' && (
                    <div className="camera-tile__offline-msg">
                      <Camera size={24} /><span>Feed Offline</span>
                    </div>
                  )}

                  {/* RTSP Stream Status Badge */}
                  <div className="camera-tile__rec">
                    {isStreaming ? (
                      <><span className="camera-tile__rec-dot camera-tile__rec-dot--streaming"></span><span>RTSP LIVE</span></>
                    ) : (
                      <><span className="camera-tile__rec-dot"></span><span>OFFLINE</span></>
                    )}
                  </div>

                  {/* Quick Action Overlay Buttons */}
                  <div className="camera-tile__actions">
                    <button
                      className="camera-tile__action-btn"
                      title="Open Live HUD Monitor"
                      onClick={(e) => { e.stopPropagation(); setHudModalCamera(cam); }}
                    >
                      <Eye size={14} />
                    </button>
                    <button
                      className="camera-tile__action-btn"
                      title="Configure RTSP / Violations"
                      onClick={(e) => { e.stopPropagation(); openConfigModal(cam); }}
                    >
                      <Settings size={14} />
                    </button>
                    <button
                      className={`camera-tile__action-btn ${isStreaming ? 'camera-tile__action-btn--active' : ''}`}
                      title={isStreaming ? 'Stop Stream' : 'Start Stream'}
                      onClick={(e) => toggleStream(cam, e)}
                    >
                      {isStreaming ? <Square size={13} /> : <Play size={13} />}
                    </button>
                  </div>
                </div>

                <div className="camera-tile__info">
                  <div className="camera-tile__top">
                    <div>
                      <h4 className="camera-tile__name">{cam.name}</h4>
                      <div className="camera-tile__location"><MapPin size={12} /><span>{cam.zone} · Speed Limit {cam.speed_limit_kmh || 50} km/h</span></div>
                    </div>
                    <div className={`camera-tile__status-badge camera-tile__status-badge--${cam.stream_status === 'running' ? 'online' : cam.status}`}>
                      <span className={`status-dot status-${cam.stream_status === 'running' ? 'online' : cam.status}`}></span>
                      {cam.stream_status === 'running' ? 'Live RTSP' : cam.status}
                    </div>
                  </div>

                  <div className="camera-tile__meta">
                    <span className="camera-tile__meta-item"><Gauge size={12} />Limit: {cam.speed_limit_kmh || 50} km/h</span>
                    <span className="camera-tile__meta-item">
                      <Clock size={12} />
                      FPS: {isStreaming && liveCamFps > 0 ? `${liveCamFps} live` : (cam.sample_fps ? `${cam.sample_fps}` : 'Auto')}
                    </span>
                    <span className="camera-tile__meta-item">Type: {cam.type || 'ANPR'}</span>
                  </div>
                </div>

                {/* Recent Detections Accordion */}
                {selectedCamera === cam.id && cam.status !== 'offline' && (
                  <div className="camera-tile__history">
                    <h5 className="camera-tile__history-title">Recent Real-Time Detections</h5>
                    {dets.length === 0 && <p className="camera-tile__empty-text">No vehicle detections logged yet.</p>}
                    {dets.map((det, i) => (
                      <div key={i} className="camera-tile__history-item">
                        <span className="mono" style={{ color: 'var(--primary)', fontWeight: 600 }}>{det.plate}</span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {det.vehicle_type} · {new Date(det.timestamp).toLocaleTimeString()}
                        </span>
                        {det.violations && JSON.parse(det.violations || '[]').length > 0 ? (
                          <span className="badge badge-danger" style={{ fontSize: '0.65rem' }}>
                            {JSON.parse(det.violations)[0]}
                          </span>
                        ) : (
                          <span className="badge badge-success" style={{ fontSize: '0.65rem' }}>
                            {(det.confidence * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MODE 2: Video ANPR Studio */}
      {activeTab === 'studio' && (
        <div className="anpr-studio animate-fade-in">
          <div className="anpr-studio__header">
            <div>
              <h3>Traffic Video File Ingestion & Real-Time ANPR Studio</h3>
              <p>Upload a traffic video (.mp4/.mkv) to break it into frames, run YOLO vehicle & plate recognition, and detect multi-violations.</p>
            </div>
          </div>

          <div className="anpr-studio__layout">
            <div className="anpr-studio__upload-card">
              <form onSubmit={handleVideoUpload} className="anpr-studio__form">
                <div className="anpr-studio__dropzone">
                  <Upload size={36} className="anpr-studio__drop-icon" />
                  <h4>Select Traffic Video File</h4>
                  <p>Supports MP4, MKV, AVI, MOV up to 2GB</p>
                  <input
                    type="file"
                    accept="video/*"
                    onChange={(e) => setVideoFile(e.target.files[0])}
                    className="anpr-studio__file-input"
                  />
                  {videoFile && <span className="anpr-studio__filename">{videoFile.name} ({(videoFile.size / (1024 * 1024)).toFixed(1)} MB)</span>}
                </div>

                <div className="anpr-studio__form-row">
                  <label>Assign to Virtual Camera Node:</label>
                  <select
                    className="live__select"
                    value={studioCameraId}
                    onChange={(e) => setStudioCameraId(e.target.value)}
                  >
                    <option value="">Auto (Default Node)</option>
                    {cameras.map(c => <option key={c.id} value={c.id}>{c.id} - {c.name} ({c.zone})</option>)}
                  </select>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <button
                    type="submit"
                    className="btn btn-primary anpr-studio__submit-btn"
                    disabled={!videoFile || videoUploading}
                  >
                    {videoUploading ? (
                      <><RefreshCw size={16} className="spin" /> Ingesting & Running Smart ANPR...</>
                    ) : (
                      <><Sparkles size={16} /> Process Uploaded Video</>
                    )}
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary anpr-studio__submit-btn"
                    onClick={handleRunSampleDemo}
                    disabled={videoUploading}
                    style={{ background: 'rgba(0, 240, 255, 0.08)', borderColor: 'rgba(0, 240, 255, 0.3)', color: 'var(--primary)' }}
                  >
                    <Play size={15} /> Run Demo Traffic Video (Instant)
                  </button>
                </div>
              </form>
            </div>

            {/* Studio Live Feed HUD */}
            <div className="anpr-studio__viewer-card">
              <div className="live-hud">
                <div className="live-hud__screen">
                  {liveOverlay?.preview ? (
                    <div className="live-hud__canvas-wrapper">
                      <img src={liveOverlay.preview} alt="ANPR Stream" className="live-hud__frame-img" />
                      <svg className="live-hud__svg-overlay" viewBox={`0 0 ${liveOverlay.frameWidth || 640} ${liveOverlay.frameHeight || 480}`}>
                        {/* Render Vehicle Bounding Boxes */}
                        {liveOverlay.vehicles?.map((v, idx) => {
                          const box = v.bbox || v.vehicle_bbox || {};
                          const vType = v.type || v.vehicle_type || 'vehicle';
                          const conf = v.confidence ?? v.vehicle_confidence ?? 0;
                          return (
                            <g key={`v-${idx}`}>
                              <rect
                                x={box.x || 0}
                                y={box.y || 0}
                                width={box.width || 0}
                                height={box.height || 0}
                                className="hud-box hud-box--vehicle"
                              />
                              <text
                                x={(box.x || 0) + 4}
                                y={(box.y || 0) + 16}
                                className="hud-label hud-label--vehicle"
                              >
                                {vType.toUpperCase()} {(conf * 100).toFixed(0)}%
                              </text>
                            </g>
                          );
                        })}

                        {/* Render License Plate Bounding Box */}
                        {liveOverlay.plate?.bbox && (
                          <g>
                            <rect
                              x={liveOverlay.plate.bbox.x}
                              y={liveOverlay.plate.bbox.y}
                              width={liveOverlay.plate.bbox.width}
                              height={liveOverlay.plate.bbox.height}
                              className="hud-box hud-box--plate"
                            />
                            <rect
                              x={liveOverlay.plate.bbox.x}
                              y={Math.max(0, liveOverlay.plate.bbox.y - 20)}
                              width={Math.max(100, liveOverlay.plate.bbox.width)}
                              height={18}
                              className="hud-plate-tag-bg"
                            />
                            <text
                              x={liveOverlay.plate.bbox.x + 4}
                              y={Math.max(14, liveOverlay.plate.bbox.y - 6)}
                              className="hud-label hud-label--plate mono"
                            >
                              {liveOverlay.plate.plate}
                            </text>
                          </g>
                        )}

                        {/* Render Violation Badges */}
                        {liveOverlay.violations?.map((viol, vIdx) => (
                          viol.bbox && (
                            <g key={`viol-${vIdx}`}>
                              <rect
                                x={viol.bbox.x}
                                y={viol.bbox.y}
                                width={viol.bbox.width}
                                height={viol.bbox.height}
                                className="hud-box hud-box--violation pulse-danger"
                              />
                              <text
                                x={viol.bbox.x + 4}
                                y={viol.bbox.y + 14}
                                className="hud-label hud-label--violation"
                              >
                                ⚠️ {viol.code?.toUpperCase()}
                              </text>
                            </g>
                          )
                        ))}
                      </svg>
                    </div>
                  ) : (
                    <div className="live-hud__empty">
                      <Disc size={48} className="spin-slow" />
                      <h4>Studio Stream Idle</h4>
                      <p>Upload a video or connect an RTSP camera stream to watch the live bounding boxes & smart OCR HUD.</p>
                    </div>
                  )}

                  {/* Top HUD Telemetry Ribbon */}
                  <div className="live-hud__telemetry">
                    <span className="live-hud__stat"><Radio size={12} className="pulse-indicator" /> LIVE</span>
                    <span className="live-hud__stat">FPS: <strong>{liveFps || 2}</strong></span>
                    <span className="live-hud__stat">Speed: <strong>{liveOverlay?.speed ? `${liveOverlay.speed} km/h` : '—'}</strong></span>
                    <span className="live-hud__stat">Plate: <strong className="mono" style={{ color: 'var(--primary)' }}>{liveOverlay?.plate?.plate || 'Scanning...'}</strong></span>
                    {liveOverlay?.violations?.length > 0 && (
                      <span className="live-hud__stat live-hud__stat--danger">
                        <AlertOctagon size={12} /> {liveOverlay.violations[0].code.toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>

                {/* Studio Live Ticker */}
                {(() => {
                  const displayDets = studioDetections.length > 0 ? studioDetections : recentLiveDetections;
                  return (
                    <div className="live-hud__ticker">
                      <div className="live-hud__ticker-header">
                        <h5>Real-Time Detection Feed</h5>
                        <span>{displayDets.length} captured</span>
                      </div>
                      <div className="live-hud__ticker-list">
                        {displayDets.length === 0 && <p className="live-hud__ticker-empty">Awaiting stream detections...</p>}
                        {displayDets.map((det, idx) => (
                          <div key={idx} className="live-hud__ticker-card">
                            <div className="live-hud__ticker-left">
                              <span className="mono live-hud__ticker-plate">{det.plate}</span>
                              <small>{det.vehicle_type} · {det.speed ? `${det.speed} km/h` : 'Speed tracked'}</small>
                            </div>
                            <div className="live-hud__ticker-right">
                              {det.violations?.length > 0 ? (
                                <span className="badge badge-danger">⚠️ {det.violations[0].label || det.violations[0].code}</span>
                              ) : (
                                <span className="badge badge-success">OK</span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* POPUP MODAL 1: Real-Time Live Stream HUD Modal */}
      {hudModalCamera && (
        <div className="modal-overlay" onClick={() => setHudModalCamera(null)}>
          <div className="live-modal animate-scale-in" onClick={e => e.stopPropagation()}>
            <div className="live-modal__header">
              <div className="live-modal__header-info">
                <h3>{hudModalCamera.name}</h3>
                <p><MapPin size={12} /> {hudModalCamera.zone} · Speed Limit: {hudModalCamera.speed_limit_kmh || 50} km/h · {hudModalCamera.id}</p>
              </div>
              <div className="live-modal__header-actions">
                <button
                  className={`btn ${hudModalCamera.stream_status === 'running' ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => toggleStream(hudModalCamera)}
                >
                  {hudModalCamera.stream_status === 'running' ? <><Square size={14} /> Disconnect</> : <><Play size={14} /> Connect Stream</>}
                </button>
                <button className="btn btn-secondary" onClick={() => setHudModalCamera(null)}>
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="live-modal__body">
              <div className="live-hud__screen live-hud__screen--modal">
                {liveOverlays[hudModalCamera.id]?.preview ? (() => {
                  const modalOverlay = liveOverlays[hudModalCamera.id];
                  const modalFps = cameraFps[hudModalCamera.id] || 0;
                  return (
                    <>
                      <div className="live-hud__canvas-wrapper">
                        <img src={modalOverlay.preview} alt={hudModalCamera.name} className="live-hud__frame-img" />
                        <svg className="live-hud__svg-overlay" viewBox={`0 0 ${modalOverlay.frameWidth || 640} ${modalOverlay.frameHeight || 480}`}>
                          {modalOverlay.vehicles?.map((v, idx) => (
                            <g key={`mv-${idx}`}>
                              <rect x={v.bbox?.x || 0} y={v.bbox?.y || 0} width={v.bbox?.width || 0} height={v.bbox?.height || 0} className="hud-box hud-box--vehicle" />
                              <text x={(v.bbox?.x || 0) + 4} y={(v.bbox?.y || 0) + 16} className="hud-label hud-label--vehicle">
                                {v.type?.toUpperCase()} {(v.confidence * 100).toFixed(0)}%
                              </text>
                            </g>
                          ))}

                          {modalOverlay.plate?.bbox && (
                            <g>
                              <rect x={modalOverlay.plate.bbox.x} y={modalOverlay.plate.bbox.y} width={modalOverlay.plate.bbox.width} height={modalOverlay.plate.bbox.height} className="hud-box hud-box--plate" />
                              <rect x={modalOverlay.plate.bbox.x} y={modalOverlay.plate.bbox.y - 20} width={Math.max(100, modalOverlay.plate.bbox.width)} height={18} className="hud-plate-tag-bg" />
                              <text x={modalOverlay.plate.bbox.x + 4} y={modalOverlay.plate.bbox.y - 6} className="hud-label hud-label--plate mono">
                                {modalOverlay.plate.plate}
                              </text>
                            </g>
                          )}

                          {modalOverlay.violations?.map((viol, vIdx) => (
                            viol.bbox && (
                              <g key={`mviol-${vIdx}`}>
                                <rect x={viol.bbox.x} y={viol.bbox.y} width={viol.bbox.width} height={viol.bbox.height} className="hud-box hud-box--violation pulse-danger" />
                                <text x={viol.bbox.x + 4} y={viol.bbox.y + 14} className="hud-label hud-label--violation">
                                  ⚠️ {viol.label || viol.code}
                                </text>
                              </g>
                            )
                          ))}
                        </svg>
                      </div>

                      {/* Telemetry Bar */}
                      <div className="live-hud__telemetry">
                        <span className="live-hud__stat"><Radio size={12} className="pulse-indicator" /> LIVE HUD</span>
                        <span className="live-hud__stat">FPS: <strong>{modalFps || 2}</strong></span>
                        <span className="live-hud__stat">Speed: <strong>{modalOverlay?.speed ? `${modalOverlay.speed} km/h` : 'Normal'}</strong></span>
                        <span className="live-hud__stat">Plate: <strong className="mono" style={{ color: 'var(--primary)' }}>{modalOverlay?.plate?.plate || 'Scanning...'}</strong></span>
                        {modalOverlay?.violations?.length > 0 && (
                          <span className="live-hud__stat live-hud__stat--danger">
                            <AlertTriangle size={12} /> {modalOverlay.violations[0].code.toUpperCase()}
                          </span>
                        )}
                      </div>
                    </>
                  );
                })() : (
                  <div className="live-hud__empty">
                    <Camera size={48} />
                    <h4>Stream Connecting or Idle</h4>
                    <p>Click "Connect Stream" to initiate the RTSP worker and begin YOLO detection.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* POPUP MODAL 2: Unified Camera Registration / RTSP Config Modal */}
      <CameraRegistrationModal
        isOpen={isConfigModalOpen}
        onClose={closeConfigModal}
        camera={configModalCamera}
        onSuccess={handleModalSuccess}
        presets={presets}
      />
    </div>
  );
}
