import { useState, useEffect } from 'react';
import { Camera, Wifi, Copy, X } from 'lucide-react';
import { camerasApi, healthApi } from '../../services/api';
import './SystemHealth.css';

function GaugeChart({ value, label, color = 'primary', max = 100 }) {
  const percentage = (value / max) * 100;
  const circumference = 2 * Math.PI * 45;
  const offset = circumference - (percentage / 100) * circumference;
  const colorMap = { primary: '#00f0ff', success: '#10b981', warning: '#f59e0b', danger: '#ef4444', secondary: '#7c3aed' };
  const actualColor = value > 90 ? colorMap.danger : value > 75 ? colorMap.warning : colorMap[color];

  return (
    <div className="gauge">
      <svg className="gauge__svg" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="45" fill="none" stroke="var(--border-default)" strokeWidth="6" />
        <circle cx="50" cy="50" r="45" fill="none" stroke={actualColor} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 50 50)"
          style={{ transition: 'stroke-dashoffset 1s ease', filter: `drop-shadow(0 0 6px ${actualColor}40)` }} />
      </svg>
      <div className="gauge__content">
        <span className="gauge__value" style={{ color: actualColor }}>{value}%</span>
        <span className="gauge__label">{label}</span>
      </div>
    </div>
  );
}

export default function SystemHealth() {
  const [cameras, setCameras] = useState([]);
  const [serverHealth, setServerHealth] = useState(null);
  const [registrationError, setRegistrationError] = useState('');
  const [selectedConnection, setSelectedConnection] = useState(null);

  async function showCameraConnection(cameraId) {
    try {
      const camera = await camerasApi.getById(cameraId);
      setSelectedConnection(camera.connection);
      setRegistrationError('');
    } catch (error) {
      setRegistrationError(error.message);
    }
  }

  async function copyValue(value) {
    await navigator.clipboard.writeText(value);
  }


  useEffect(() => {
    async function fetchData() {
      try {
        const [cams, health] = await Promise.all([camerasApi.getAll(), healthApi.check()]);
        setCameras(cams);
        setServerHealth(health);
      } catch (err) { console.error('Failed to fetch health:', err); }
    }
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, []);

  const onlineCams = cameras.filter(c => c.status === 'online').length;
  const offlineCams = cameras.filter(c => c.status === 'offline').length;
  const degradedCams = cameras.filter(c => c.status === 'degraded').length;

  return (
    <div className="health animate-fade-in">
      {/* Server Status */}
      {serverHealth && (
        <div className="health__server card">
          <h4 className="health__section-title"><Wifi size={18} /> Server Status</h4>
          <div className="health__server-info">
            <div className="health__ai-item">
              <span className="health__ai-value" style={{ color: 'var(--success)' }}>● ONLINE</span>
              <span className="health__ai-label">Status</span>
            </div>
            <div className="health__ai-item">
              <span className="health__ai-value mono" style={{ fontSize: '0.85rem' }}>{Math.floor(serverHealth.uptime)}s</span>
              <span className="health__ai-label">Uptime</span>
            </div>
            <div className="health__ai-item">
              <span className="health__ai-value mono" style={{ fontSize: '0.85rem' }}>{serverHealth.version}</span>
              <span className="health__ai-label">Version</span>
            </div>
          </div>
        </div>
      )}

      {selectedConnection && (
        <div className="health__server card" style={{ position: 'relative' }}>
          <button className="btn btn-icon" type="button" onClick={() => setSelectedConnection(null)} aria-label="Close connection details">
            <X size={16} />
          </button>
          <h4 className="health__section-title"><Wifi size={18} /> Camera Connection Details</h4>
          <div style={{ display: 'grid', gap: '8px' }}>
            {[
              ['Camera ID', selectedConnection.camera_id],
              ['API Key', selectedConnection.api_key],
              ['Server URL', selectedConnection.server_url],
              ['Ingest Endpoint', `${selectedConnection.server_url}${selectedConnection.ingest_endpoint}`],
            ].map(([label, value]) => (
              <div key={label} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <strong style={{ minWidth: '130px' }}>{label}</strong>
                <code style={{ flex: 1, overflowWrap: 'anywhere' }}>{value}</code>
                <button className="btn btn-icon" type="button" onClick={() => copyValue(value)} aria-label={`Copy ${label}`}>
                  <Copy size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Camera Status Grid */}
      <div className="health__cameras card">
        <h4 className="health__section-title">
          <Camera size={18} /> Camera Status
          <span className="health__camera-summary">
            <span className="badge badge-success">{onlineCams} Online</span>
            <span className="badge badge-warning">{degradedCams} Degraded</span>
            <span className="badge badge-danger">{offlineCams} Offline</span>
          </span>
        </h4>
        <div className="health__cameras-grid">
          {cameras.map(cam => (
            <button key={cam.id} type="button" onClick={() => showCameraConnection(cam.id)} className={`health__camera-card health__camera-card--${cam.status}`} style={{ textAlign: 'left', width: '100%' }}>
              <div className="health__camera-top">
                <span className={`status-dot status-${cam.status}`}></span>
                <span className="health__camera-id mono">{cam.id}</span>
              </div>
              <h5 className="health__camera-name">{cam.name}</h5>
              <div className="health__camera-meta"><span>{cam.zone}</span><span>Uptime: {cam.uptime}%</span></div>
              <div className="health__camera-meta"><span>Type: {cam.type}</span><span>{cam.detections_today || 0} today</span></div>
              <div className="progress-bar" style={{ height: '4px', marginTop: '8px' }}><div className="progress-fill" style={{ width: `${cam.uptime}%` }}></div></div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
