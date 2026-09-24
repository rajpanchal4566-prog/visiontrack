import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Shield, Camera, Route, BarChart3, Bell, ArrowRight,
  Zap, Cpu, Eye, Radio, ShieldAlert, Sparkles, MapPin,
  CheckCircle2, Users, Compass, Scan, ExternalLink, Activity
} from 'lucide-react';
import { detectionsApi, camerasApi } from '../services/api';
import './LandingPage.css';

const features = [
  {
    icon: Camera,
    title: 'Real-Time Edge ANPR',
    desc: 'High-speed license plate detection using YOLOv8 & dual-pass OCR preprocessors running at sub-20ms inference latency.',
    tag: 'YOLOv8 + OCR'
  },
  {
    icon: Route,
    title: 'GIS Trajectory Reconstruction',
    desc: 'Chronological route mapping across multi-camera intersections with interactive entry/exit pins, path polylines, and waypoint tracking.',
    tag: 'LEAFLET GIS'
  },
  {
    icon: ShieldAlert,
    title: 'Travel Time & Speed Validation',
    desc: 'Inter-camera speed calculation with automated anomaly detection for speeding, overspeeding, and impossible spoofed travel times.',
    tag: 'ALGORITHM ENGINE'
  },
  {
    icon: Bell,
    title: 'Hotlist & Watchlist Alerts',
    desc: 'Instant Socket.IO security alerts when blacklisted, stolen, or flagged vehicles are observed, paired with real-time audio dispatch alerts.',
    tag: 'REAL-TIME PUSH'
  },
  {
    icon: BarChart3,
    title: 'Macro Traffic Flow & Density',
    desc: 'City-wide traffic throughput analytics, peak-hour curves, congestion bottlenecks, and dynamic leaflet.heat density overlays.',
    tag: 'FLOW METRICS'
  },
  {
    icon: Cpu,
    title: 'Multi-Camera Topology Manager',
    desc: 'Unified ingest console supporting live RTSP, ONVIF, and video file processing with automated frame rate and stream health diagnostics.',
    tag: 'STREAM INGEST'
  },
];

const workingSteps = [
  {
    step: '01',
    title: 'Multi-Camera Stream Ingest',
    desc: 'Live RTSP and ONVIF video streams from highway corridors, city gates, and toll gantries are decoded at calibrated sampling intervals.',
    icon: VideoIcon
  },
  {
    step: '02',
    title: 'YOLOv8 Vehicle & Plate Localization',
    desc: 'Pretrained neural networks isolate vehicle bounding boxes, verify rider helmet compliance, and crop license plate coordinates with adaptive padding.',
    icon: Scan
  },
  {
    step: '03',
    title: 'Optical Character Recognition & Scoring',
    desc: 'Cropped plates pass through grayscale contrast enhancement and local Tesseract OCR with regex state-code format validation.',
    icon: Cpu
  },
  {
    step: '04',
    title: 'GIS Trajectory & Anomaly Dispatch',
    desc: 'Consecutive sightings are correlated across time and distance to reconstruct vehicle journeys, detect speed violations, and push instant alerts.',
    icon: Route
  },
];

function VideoIcon(props) {
  return <Camera {...props} />;
}

const operatorRoles = [
  {
    name: 'Police Dispatch & Enforcement',
    badge: 'TACTICAL COMMAND',
    avatar: '👮‍♂️',
    desc: 'Receives instant audible hotlist alerts for blacklisted, stolen, or court-warranted vehicles with camera coordinate stamps.',
    focus: 'Watchlist Interception'
  },
  {
    name: 'Traffic Operations Commander',
    badge: 'URBAN MOBILITY',
    avatar: '🚦',
    desc: 'Monitors real-time intersection throughput, manages bottleneck congestion zones, and reviews live video feeds.',
    focus: 'Corridor Optimization'
  },
  {
    name: 'Forensic Investigation Analyst',
    badge: 'CRIME FORENSICS',
    avatar: '🔍',
    desc: 'Executes regex plate wildcard queries, reconstructs full multi-day vehicle travel trajectories on GIS maps, and validates inter-camera speeds.',
    focus: 'Historical Sighting Search'
  },
  {
    name: 'Edge Systems Administrator',
    badge: 'TELEMETRY & NODES',
    avatar: '⚡',
    desc: 'Supervises edge inference hardware, RTSP streaming health, server RAM/CPU loads, and automated route recalculation.',
    focus: 'Node Infrastructure'
  },
];

export default function LandingPage() {
  const navigate = useNavigate();

  const [statsData, setStatsData] = useState({
    indexedDetections: '—',
    cameraNodes: '—',
    ocrAccuracy: '>94.2%',
    latency: '~10ms OCR',
  });

  const [scannerData, setScannerData] = useState({
    cameraName: 'CAM-01: HIGHWAY CORRIDOR',
    fps: '15.4 FPS // LIVE',
    plate: 'KA 03 MG 4521',
    confidence: '98.5% CONF',
    speed: '48 KM/H',
    vehicleType: 'SEDAN [FOUR-WHEELER]',
    route: 'INTERSECTION CORRIDOR VALIDATED'
  });

  useEffect(() => {
    async function loadLandingData() {
      try {
        const [detStats, cams, latestDets] = await Promise.all([
          detectionsApi.getStats().catch(() => null),
          camerasApi.getAll().catch(() => []),
          detectionsApi.getLatest(1).catch(() => []),
        ]);

        if (detStats) {
          const totalCount = detStats.totalAllTime || detStats.totalToday || 0;
          setStatsData(prev => ({
            ...prev,
            indexedDetections: totalCount > 0 ? `${totalCount.toLocaleString()}` : '0',
            ocrAccuracy: detStats.avgConfidence > 0 ? `${(detStats.avgConfidence * 100).toFixed(1)}%` : '>94.2%',
          }));
        }

        if (cams && cams.length > 0) {
          setStatsData(prev => ({
            ...prev,
            cameraNodes: String(cams.length),
          }));
        }

        if (latestDets && latestDets.length > 0) {
          const latest = latestDets[0];
          setScannerData(prev => ({
            ...prev,
            cameraName: latest.camera_name ? `${latest.camera_name.toUpperCase()}` : prev.cameraName,
            plate: latest.plate || prev.plate,
            confidence: latest.confidence ? `${(latest.confidence > 1 ? latest.confidence : latest.confidence * 100).toFixed(1)}% CONF` : prev.confidence,
            speed: latest.speed ? `${Math.round(latest.speed)} KM/H` : prev.speed,
            vehicleType: latest.vehicle_type ? `${latest.vehicle_type.toUpperCase()}` : prev.vehicleType,
          }));
        } else if (cams && cams.length > 0) {
          setScannerData(prev => ({
            ...prev,
            cameraName: cams[0].name.toUpperCase(),
          }));
        }
      } catch (e) {
        console.error('Failed to load landing data:', e);
      }
    }
    loadLandingData();
  }, []);

  return (
    <div className="landing-page">
      {/* Background Grid Ambience */}
      <div className="landing-bg">
        <div className="landing-grid-lines" />
      </div>

      {/* Top Navigation */}
      <header className="landing-nav">
        <div className="landing-nav__brand">
          <span className="tactical-diode tactical-diode--green"></span>
          <span className="landing-nav__logo-text font-mono">VISIONTRACK ANPR</span>
        </div>

        <nav className="landing-nav__menu font-mono">
          <a href="#how-it-works">ARCHITECTURE</a>
          <a href="#features">CAPABILITIES</a>
          <a href="#operators">OPERATORS</a>
        </nav>

        <div className="landing-nav__actions">
          <button
            type="button"
            className="btn btn-primary btn-sm font-mono"
            onClick={() => navigate('/login')}
          >
            <span>GET STARTED</span>
            <ArrowRight size={13} />
          </button>
        </div>
      </header>

      {/* Hero Section */}
      <section className="landing-hero">
        <div className="landing-hero__content">
          {/* Badge */}
          <div className="landing-hero__badge font-mono">
            <span className="tactical-ping-dot"></span>
            <span>CITY-WIDE MULTI-CAMERA VEHICLE INTELLIGENCE</span>
          </div>

          {/* Heading */}
          <h1 className="landing-hero__title font-display">
            Automated License Plate Recognition & <span className="text-primary">Trajectory Tracking</span> System
          </h1>

          {/* Descriptive Text */}
          <p className="landing-hero__desc">
            VisionTrack connects urban CCTV camera networks to a high-speed computer vision engine.
            It performs real-time vehicle detection, license plate OCR, full inter-camera trajectory reconstruction,
            and automated travel time anomaly validation across the entire city.
          </p>

          {/* Action CTAs */}
          <div className="landing-hero__ctas">
            <button
              type="button"
              className="btn btn-primary btn-lg font-mono"
              onClick={() => navigate('/login')}
            >
              <span>GET STARTED // SIGN IN</span>
              <ArrowRight size={16} />
            </button>
            <a href="#how-it-works" className="btn btn-secondary btn-lg font-mono">
              <span>EXPLORE SYSTEM FLOW</span>
            </a>
          </div>

          {/* Live Dynamic Telemetry Strip */}
          <div className="landing-hero__stats font-mono">
            <div className="landing-stat">
              <span className="landing-stat__val text-primary">{statsData.indexedDetections}</span>
              <span className="landing-stat__lbl">INDEXED DETECTIONS</span>
            </div>
            <div className="landing-stat__sep">|</div>
            <div className="landing-stat">
              <span className="landing-stat__val text-nominal">{statsData.cameraNodes}</span>
              <span className="landing-stat__lbl">CAMERA NODES</span>
            </div>
            <div className="landing-stat__sep">|</div>
            <div className="landing-stat">
              <span className="landing-stat__val text-primary">{statsData.ocrAccuracy}</span>
              <span className="landing-stat__lbl">OCR ACCURACY</span>
            </div>
            <div className="landing-stat__sep">|</div>
            <div className="landing-stat">
              <span className="landing-stat__val text-on-surface">{statsData.latency}</span>
              <span className="landing-stat__lbl">OCR LATENCY</span>
            </div>
          </div>
        </div>

        {/* Hero Visual: Live Optical Scanner */}
        <div className="landing-hero__visual">
          <div className="tactical-scanner card tactical-border-cross">
            {/* Header Telemetry */}
            <div className="tactical-scanner__top font-mono">
              <span className="tactical-scanner__channel text-primary">{scannerData.cameraName}</span>
              <span className="tactical-scanner__fps text-nominal">{scannerData.fps}</span>
            </div>

            {/* Video Viewport Area */}
            <div className="tactical-scanner__viewport hud-bracket">
              {/* Vehicle Bounding Box */}
              <div className="tactical-scanner__bbox">
                <div className="tactical-bbox-reticle -top-1 -left-1"></div>
                <div className="tactical-bbox-reticle -top-1 -right-1"></div>
                <div className="tactical-bbox-reticle -bottom-1 -left-1"></div>
                <div className="tactical-bbox-reticle -bottom-1 -right-1"></div>
                <span className="tactical-bbox-label font-mono">YOLOv8 // VEHICLE DETECTED</span>
              </div>

              {/* License Plate Readout */}
              <div className="tactical-scanner__plate-box">
                <div className="tactical-scanner__plate-flag">
                  <span className="font-mono text-xs">IND</span>
                </div>
                <span className="telemetry-plate text-xl text-primary">{scannerData.plate}</span>
              </div>

              {/* Detection Metadata Tag */}
              <div className="tactical-scanner__meta-pill font-mono">
                <span className="text-nominal font-bold">{scannerData.confidence}</span>
                <span className="text-outline">|</span>
                <span className="text-primary font-bold">{scannerData.speed}</span>
                <span className="text-outline">|</span>
                <span className="text-on-surface">VALIDATED</span>
              </div>
            </div>

            {/* Bottom Status Ribbon */}
            <div className="tactical-scanner__bottom font-mono">
              <span className="text-outline">TARGET: {scannerData.vehicleType}</span>
              <span className="text-primary font-bold">{scannerData.route}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Architecture & Working Steps Section */}
      <section id="how-it-works" className="landing-section">
        <div className="landing-section__header">
          <span className="landing-section__tag font-mono text-primary">PIPELINE ARCHITECTURE</span>
          <h2 className="landing-section__title font-display">How VisionTrack Works</h2>
          <p className="landing-section__subtitle">
            From raw RTSP sensor video ingest to GIS trajectory reconstruction in milliseconds.
          </p>
        </div>

        <div className="working-steps-grid">
          {workingSteps.map((ws, i) => (
            <div key={i} className="working-step-card card tactical-border-cross">
              <div className="working-step-card__top font-mono">
                <span className="working-step-num text-primary font-bold">STEP // {ws.step}</span>
                <ws.icon size={18} className="text-outline" />
              </div>
              <h3 className="working-step-title font-display">{ws.title}</h3>
              <p className="working-step-desc">{ws.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Operator Character Roles */}
      <section id="operators" className="landing-section">
        <div className="landing-section__header">
          <span className="landing-section__tag font-mono text-primary">ROLE-BASED WORKSPACES</span>
          <h2 className="landing-section__title font-display">Built for City Operations Teams</h2>
          <p className="landing-section__subtitle">
            Tailored interfaces designed for field commanders, mobility planners, and forensic analysts.
          </p>
        </div>

        <div className="operator-roles-grid">
          {operatorRoles.map((role, i) => (
            <div key={i} className="operator-role-card card hud-bracket">
              <div className="operator-role-avatar">{role.avatar}</div>
              <span className="operator-role-badge font-mono">{role.badge}</span>
              <h3 className="operator-role-name font-display">{role.name}</h3>
              <p className="operator-role-desc">{role.desc}</p>
              <div className="operator-role-focus font-mono">
                <span className="text-outline">PRIMARY FOCUS:</span>
                <span className="text-primary font-bold">{role.focus}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Features & Capabilities Matrix */}
      <section id="features" className="landing-section">
        <div className="landing-section__header">
          <span className="landing-section__tag font-mono text-primary">CORE ENGINE CAPABILITIES</span>
          <h2 className="landing-section__title font-display">Engineered for High-Velocity Triage</h2>
          <p className="landing-section__subtitle">
            Comprehensive feature matrix designed to satisfy BEL requirements for municipal surveillance.
          </p>
        </div>

        <div className="capabilities-grid">
          {features.map((feat, i) => (
            <div key={i} className="capability-card card">
              <div className="capability-card__header">
                <div className="capability-card__icon">
                  <feat.icon size={20} className="text-primary" />
                </div>
                <span className="capability-card__tag font-mono">{feat.tag}</span>
              </div>
              <h3 className="capability-card__title font-display">{feat.title}</h3>
              <p className="capability-card__desc">{feat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Call to Action Banner */}
      <section className="landing-cta-section">
        <div className="landing-cta-box card tactical-border-cross">
          <div className="landing-cta-content">
            <span className="landing-cta-badge font-mono text-primary">OPERATIONS CONSOLE</span>
            <h2 className="landing-cta-title font-display">
              Ready to Access the Operations Console?
            </h2>
            <p className="landing-cta-desc font-mono">
              Sign in with your operator credentials to monitor live feeds, search vehicle sightings, and review GIS trajectories.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-lg font-mono"
              onClick={() => navigate('/login')}
            >
              <span>OPERATOR SIGN IN</span>
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </section>

      {/* Minimal Footer */}
      <footer className="landing-footer font-mono">
        <div className="landing-footer__brand">
          <span className="tactical-diode tactical-diode--green"></span>
          <span>VISIONTRACK // CITY-WIDE TRAFFIC INTELLIGENCE PLATFORM</span>
        </div>
        <div className="landing-footer__meta">
          <span>EDGE BUILD v1.0.0</span>
          <span>|</span>
          <span>LOCAL ONNX / WASM ENGINE</span>
          <span>|</span>
          <button type="button" className="text-primary" onClick={() => navigate('/login')}>
            SIGN IN
          </button>
        </div>
      </footer>
    </div>
  );
}
