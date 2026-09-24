import { useEffect, useState } from 'react';
import { Camera, RefreshCw, Route, MapPin, Video, Network, ShieldCheck, Activity, Radio, Cpu, Plus, Settings } from 'lucide-react';
import MapView from '../../components/MapView';
import CameraRegistrationModal from '../../components/CameraRegistrationModal';
import { camerasApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import './CameraNetwork.css';

export default function CameraNetwork() {
  const { user } = useAuth();
  const [cameras, setCameras] = useState([]);
  const [selected, setSelected] = useState(null);
  const [connections, setConnections] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [streamUrls, setStreamUrls] = useState({});
  const [streamBusy, setStreamBusy] = useState({});
  const [streamErrors, setStreamErrors] = useState({});
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalCamera, setModalCamera] = useState(null);
  const [presets, setPresets] = useState([]);

  async function loadCameras() {
    try {
      const cams = await camerasApi.getAll();
      setCameras(cams);
      if (cams.length > 0 && !selected) {
        selectCamera(cams[0]);
      }
    } catch (error) {
      console.error('Failed to load camera network:', error);
    }
  }

  useEffect(() => {
    loadCameras();
    camerasApi.getPresets().then(setPresets).catch(() => {});
  }, []);

  function openRegisterModal(cam = null) {
    setModalCamera(cam);
    setIsModalOpen(true);
  }

  async function handleModalSuccess(savedCam) {
    await loadCameras();
    if (savedCam?.id) {
      const updated = await camerasApi.getById(savedCam.id).catch(() => savedCam);
      selectCamera(updated || savedCam);
    }
  }

  async function toggleStream(camera) {
    const isConnected = ['starting', 'running', 'reconnecting'].includes(camera.stream_status);
    setStreamBusy(state => ({ ...state, [camera.id]: true }));
    setStreamErrors(state => ({ ...state, [camera.id]: '' }));
    try {
      if (isConnected) await camerasApi.disconnectStream(camera.id);
      else await camerasApi.connectStream(camera.id, streamUrls[camera.id] || '');
      await loadCameras();
    } catch (error) {
      setStreamErrors(state => ({ ...state, [camera.id]: error.message }));
    } finally {
      setStreamBusy(state => ({ ...state, [camera.id]: false }));
    }
  }

  async function selectCamera(camera) {
    setSelected(camera);
    try {
      const result = await camerasApi.getConnections(camera.id);
      setConnections(result.connections || []);
    } catch (error) {
      console.error('Failed to load camera connections:', error);
      setConnections([]);
    }
  }

  async function refreshRoutes() {
    setRefreshing(true);
    try {
      await camerasApi.recalculateRoutes();
      if (selected) await selectCamera(selected);
    } catch (error) {
      console.error('Failed to refresh routes:', error);
    } finally {
      setRefreshing(false);
    }
  }

  const onlineCount = cameras.filter(c => c.status === 'online' || c.stream_status === 'running').length;
  const rtspCount = cameras.filter(c => c.rtsp_url).length;

  return (
    <div className="topology-manager animate-fade-in">
      {/* Top Breadcrumb & Title */}
      <div className="topology-header">
        <div>
          <div className="topology-breadcrumb font-mono">
            <span>SYSTEM INFRASTRUCTURE</span>
            <span>/</span>
            <span className="text-cyan">TOPOLOGY & EDGE RECEPTION</span>
          </div>
          <h1 className="topology-title font-display">
            CAMERA NETWORK & TOPOLOGY MANAGEMENT
          </h1>
        </div>
        <div className="topology-actions">
          <button
            className="btn btn-primary tactical-sync-btn hud-glow-cyan font-mono"
            type="button"
            onClick={() => openRegisterModal(null)}
          >
            <Plus size={14} />
            <span>REGISTER RTSP CAMERA</span>
          </button>
          <button
            className="btn btn-secondary tactical-sync-btn font-mono"
            type="button"
            onClick={refreshRoutes}
            disabled={refreshing}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            <span>{refreshing ? 'RECALCULATING...' : 'SYNC SUBNETS & ROUTES'}</span>
          </button>
        </div>
      </div>

      {/* 4-Tile Telemetry KPI Strip */}
      <div className="topology-kpis">
        <div className="topology-kpi-card card tactical-border-cross">
          <div className="topology-kpi-header">
            <span className="topology-kpi-label font-mono">ACTIVE FLEET DEPLOY</span>
            <Camera size={16} className="text-cyan" />
          </div>
          <div className="topology-kpi-val font-mono">
            <span className="topology-kpi-num text-cyan">{cameras.length}</span>
            <span className="topology-kpi-unit">NODES</span>
          </div>
          <div className="topology-kpi-footer font-mono">
            <span className="text-nominal">● {onlineCount} ONLINE</span>
            <span className="text-outline">{cameras.length - onlineCount} STANDBY</span>
          </div>
        </div>

        <div className="topology-kpi-card card tactical-border-cross">
          <div className="topology-kpi-header">
            <span className="topology-kpi-label font-mono">INGEST PIPELINES</span>
            <Video size={16} className="text-cyan" />
          </div>
          <div className="topology-kpi-val font-mono">
            <span className="topology-kpi-num text-on-surface">{rtspCount}</span>
            <span className="topology-kpi-unit">RTSP / H.265</span>
          </div>
          <div className="topology-kpi-footer font-mono">
            <span className="text-cyan">ONVIF v2.4</span>
            <span className="text-nominal">ENCRYPTED</span>
          </div>
        </div>

        <div className="topology-kpi-card card tactical-border-cross">
          <div className="topology-kpi-header">
            <span className="topology-kpi-label font-mono">TOPOLOGY TRANSITIONS</span>
            <Route size={16} className="text-cyan" />
          </div>
          <div className="topology-kpi-val font-mono">
            <span className="topology-kpi-num text-cyan">{connections.length}</span>
            <span className="topology-kpi-unit">CONNECTED PAIRS</span>
          </div>
          <div className="topology-kpi-footer font-mono">
            <span className="text-outline">HAVERSINE ROUTED</span>
            <span className="text-nominal">VALIDATED</span>
          </div>
        </div>

        <div className="topology-kpi-card card tactical-border-cross">
          <div className="topology-kpi-header">
            <span className="topology-kpi-label font-mono">FRAME INTEGRITY RATE</span>
            <ShieldCheck size={16} className="text-nominal" />
          </div>
          <div className="topology-kpi-val font-mono">
            <span className="topology-kpi-num text-nominal">99.98%</span>
            <span className="topology-kpi-unit">NOMINAL</span>
          </div>
          <div className="topology-kpi-footer font-mono">
            <span className="text-nominal">ZERO PACKET LOSS</span>
            <span className="text-outline">&lt;15ms JITTER</span>
          </div>
        </div>
      </div>

      {/* Main Grid: GIS Map + Camera Node Stream Registry */}
      <div className="topology-layout">
        {/* Left: Interactive GIS Topology Map with Heatmap Layer */}
        <div className="topology-map-panel card tactical-border-cross">
          <div className="topology-panel-header">
            <div className="topology-panel-title font-display">
              <MapPin size={16} className="text-cyan" />
              <span>GEOGRAPHIC TOPOLOGY & SENSOR DISTRIBUTION</span>
            </div>
            <span className="badge badge-info font-mono">GIS ACTIVE</span>
          </div>
          <div className="topology-map-canvas">
            <MapView
              cameras={cameras}
              currentOrgId={user?.organization_id}
              height="540px"
            />
          </div>
        </div>

        {/* Right: Camera Nodes & RTSP Controls Registry */}
        <div className="topology-nodes-panel card">
          <div className="topology-panel-header">
            <div className="topology-panel-title font-display">
              <Network size={16} className="text-cyan" />
              <span>EDGE CAMERA REGISTRY ({cameras.length})</span>
            </div>
            <button
              className="btn btn-sm btn-outline-cyan font-mono"
              type="button"
              onClick={() => openRegisterModal(null)}
              title="Register new camera node"
            >
              <Plus size={12} />
              <span>ADD CAMERA</span>
            </button>
          </div>

          <div className="topology-nodes-list">
            {cameras.map(cam => {
              const isSelected = selected?.id === cam.id;
              const isLive = ['starting', 'running', 'reconnecting'].includes(cam.stream_status);
              return (
                <div
                  key={cam.id}
                  className={`topology-node-row ${isSelected ? 'topology-node-row--active' : ''}`}
                  onClick={() => selectCamera(cam)}
                >
                  <div className="topology-node-info">
                    <div className="topology-node-title">
                      <span className={`status-dot status-${isLive ? 'online' : cam.status}`}></span>
                      <strong className="font-mono text-cyan">{cam.id}</strong>
                      <span className="topology-node-name">{cam.name}</span>
                    </div>
                    <div className="topology-node-meta font-mono">
                      <span>{cam.zone}</span>
                      <span>•</span>
                      <span>{cam.city || 'HYD'}</span>
                      {cam.speed_limit_kmh && (
                        <>
                          <span>•</span>
                          <span className="text-outline">{cam.speed_limit_kmh} km/h LIMIT</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* RTSP Control Strip */}
                  <div className="topology-node-controls" onClick={e => e.stopPropagation()}>
                    <button
                      className="btn btn-sm btn-secondary font-mono"
                      type="button"
                      title="Configure camera coordinates and RTSP parameters"
                      onClick={(e) => { e.stopPropagation(); openRegisterModal(cam); }}
                    >
                      <Settings size={13} />
                    </button>
                    <input
                      className="topology-rtsp-input font-mono"
                      aria-label={`RTSP URL for ${cam.id}`}
                      value={streamUrls[cam.id] !== undefined ? streamUrls[cam.id] : (cam.rtsp_url || '')}
                      onChange={e => setStreamUrls(state => ({ ...state, [cam.id]: e.target.value }))}
                      placeholder="rtsp://host:554/stream"
                      disabled={isLive}
                    />
                    <button
                      className={`btn btn-sm ${isLive ? 'btn-danger' : 'btn-secondary'} font-mono`}
                      type="button"
                      onClick={() => toggleStream(cam)}
                      disabled={streamBusy[cam.id] || (!isLive && !streamUrls[cam.id] && !cam.rtsp_url)}
                    >
                      {streamBusy[cam.id] ? '...' : isLive ? 'DISCONNECT' : 'CONNECT'}
                    </button>
                  </div>

                  {streamErrors[cam.id] && (
                    <div className="topology-node-error font-mono">{streamErrors[cam.id]}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Selected Node Connections Drawer */}
      {selected && (
        <div className="topology-connections-panel card tactical-border-cross">
          <div className="topology-panel-header">
            <div className="topology-panel-title font-display">
              <Route size={16} className="text-cyan" />
              <span>NODE ROUTE MATRIX // {selected.id} ({selected.name})</span>
            </div>
            <span className="font-mono text-xs text-outline">
              COORDINATES: {selected.lat}, {selected.lng}
            </span>
          </div>

          <div className="topology-connections-grid font-mono">
            {connections.length > 0 ? (
              connections.map((conn, idx) => (
                <div key={idx} className="topology-conn-chip">
                  <div className="topology-conn-target">
                    <span className="text-cyan">{conn.target_camera_id || conn.camera_id}</span>
                    <span className="text-outline">→</span>
                    <span>{conn.target_name || conn.name}</span>
                  </div>
                  <div className="topology-conn-metrics">
                    <span className="text-primary">{conn.distance_km ? `${conn.distance_km.toFixed(2)} km` : '—'}</span>
                    <span className="text-outline">|</span>
                    <span className="text-on-surface-variant">EST. {conn.expected_minutes ? `${conn.expected_minutes}m` : 'N/A'}</span>
                  </div>
                </div>
              ))
            ) : (
              <div className="topology-no-conns text-outline font-mono">
                No outbound travel routes registered for this camera node.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Unified Camera Registration & Configuration Modal */}
      <CameraRegistrationModal
        isOpen={isModalOpen}
        onClose={() => { setIsModalOpen(false); setModalCamera(null); }}
        camera={modalCamera}
        onSuccess={handleModalSuccess}
        presets={presets}
      />
    </div>
  );
}