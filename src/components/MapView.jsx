import { useEffect, useRef, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.heat';
import 'leaflet/dist/leaflet.css';
import './MapView.css';

// Custom marker icons
function createIcon(color, isChild = false) {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div class="marker-pin marker-pin--${color}${isChild ? ' marker-pin--network-child' : ''}"><div class="marker-dot"></div></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12],
  });
}

function createNumberedIcon(color, number, label = '') {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div class="marker-pin marker-pin--${color}"><span class="marker-number">${label || number}</span></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14],
  });
}

const icons = {
  online: createIcon('green'),
  offline: createIcon('red'),
  degraded: createIcon('yellow'),
};

// ─── Auto-fit map to camera/trajectory bounds ───
function MapBoundsUpdater({ cameras, trajectory }) {
  const map = useMap();

  useEffect(() => {
    const points = [];

    // Collect camera points
    if (cameras && cameras.length > 0) {
      cameras.forEach(cam => {
        if (cam.lat && cam.lng) points.push([cam.lat, cam.lng]);
      });
    }

    // Collect trajectory points
    if (trajectory && trajectory.length > 0) {
      trajectory.forEach(p => {
        const lat = p.lat || p.camera?.lat;
        const lng = p.lng || p.camera?.lng;
        if (lat && lng) points.push([lat, lng]);
      });
    }

    // Fit bounds to all points
    if (points.length > 1) {
      const bounds = L.latLngBounds(points);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    } else if (points.length === 1) {
      map.setView(points[0], 14);
    }
    // If no points, don't change view (will use fallback center)
  }, [cameras, trajectory, map]);

  return null;
}

function MapAttribution() {
  const map = useMap();

  useEffect(() => {
    const attribution = L.control({ position: 'bottomright' });
    attribution.onAdd = () => {
      const element = L.DomUtil.create('div', 'visiontrack-map-attribution');
      element.innerHTML = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>';
      return element;
    };
    attribution.addTo(map);
    return () => attribution.remove();
  }, [map]);

  return null;
}

function HeatLayer({ data, visible }) {
  const map = useMap();

  useEffect(() => {
    if (!visible || !Array.isArray(data) || data.length === 0) return undefined;

    const points = data
      .map(point => [Number(point.lat), Number(point.lng), Number(point.vehicle_count) || 0])
      .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (points.length === 0) return undefined;

    const maximum = Math.max(...points.map(([, , intensity]) => intensity), 1);
    const heatLayer = L.heatLayer(
      points.map(([lat, lng, intensity]) => [lat, lng, intensity / maximum]),
      {
        radius: 34,
        blur: 26,
        maxZoom: 16,
        minOpacity: 0.42,
        gradient: {
          0.15: '#155eef',
          0.4: '#00f0ff',
          0.65: '#f59e0b',
          0.85: '#f97316',
          1: '#ef4444',
        },
      },
    ).addTo(map);

    return () => map.removeLayer(heatLayer);
  }, [data, map, visible]);

  return null;
}

export default function MapView({
  cameras = [],
  height = '400px',
  trajectory = null,
  onCameraClick = null,
  className = '',
  currentOrgId = null,
  showEntryExit = false,
  heatmapData = [],
  showLayerToggle = false,
}) {
  const [showMarkers, setShowMarkers] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(true);
  // Compute the initial center from camera data (first camera, or world center)
  const initialCenter = useMemo(() => {
    if (cameras.length > 0 && cameras[0].lat && cameras[0].lng) {
      return [cameras[0].lat, cameras[0].lng];
    }
    if (trajectory && trajectory.length > 0) {
      const p = trajectory[0];
      return [p.lat || p.camera?.lat || 20.5937, p.lng || p.camera?.lng || 78.9629];
    }
    return [20.5937, 78.9629]; // India center as fallback
  }, [cameras, trajectory]);

  // Build trajectory polyline coordinates
  const trajectoryCoords = useMemo(() => {
    if (!trajectory || trajectory.length === 0) return [];
    return trajectory
      .map(p => {
        const lat = p.lat || p.camera?.lat;
        const lng = p.lng || p.camera?.lng;
        return lat && lng ? [lat, lng] : null;
      })
      .filter(Boolean);
  }, [trajectory]);

  return (
    <div className={`map-view ${className}`} style={{ height }}>
      <MapContainer
        center={initialCenter}
        zoom={12}
        style={{ height: '100%', width: '100%', borderRadius: 'var(--radius-lg)' }}
        zoomControl={true}
        attributionControl={false}
      >
        {showLayerToggle && (
          <div style={{ position: 'absolute', zIndex: 1000, top: 12, right: 12, display: 'flex', gap: 4, padding: 4, background: 'rgba(10, 14, 26, 0.88)', border: '1px solid rgba(148, 163, 184, 0.25)', borderRadius: 6 }}>
            <button type="button" onClick={() => setShowMarkers(value => !value)} style={{ border: 0, borderRadius: 4, padding: '5px 8px', color: showMarkers ? '#0a0e1a' : '#94a3b8', background: showMarkers ? '#00f0ff' : 'transparent', cursor: 'pointer', fontSize: 11 }}>Cameras</button>
            <button type="button" onClick={() => setShowHeatmap(value => !value)} style={{ border: 0, borderRadius: 4, padding: '5px 8px', color: showHeatmap ? '#0a0e1a' : '#94a3b8', background: showHeatmap ? '#00f0ff' : 'transparent', cursor: 'pointer', fontSize: 11 }}>Heatmap</button>
          </div>
        )}
        <MapBoundsUpdater cameras={cameras} trajectory={trajectory} />
        <MapAttribution />
        <HeatLayer data={heatmapData} visible={showHeatmap} />
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Camera markers */}
        {showMarkers && cameras.map(cam => (
          <Marker
            key={cam.id}
            position={[cam.lat, cam.lng]}
            icon={currentOrgId && cam.organization_id && cam.organization_id !== currentOrgId
              ? createIcon(cam.status === 'offline' ? 'red' : cam.status === 'degraded' ? 'yellow' : 'green', true)
              : icons[cam.status] || icons.online}
            eventHandlers={{
              click: () => onCameraClick && onCameraClick(cam),
            }}
          >
            <Popup>
              <div className="map-popup">
                <strong>{cam.name}</strong>
                <div className="map-popup__info">
                  <span>ID: {cam.id}</span>
                  {cam.city && <span>City: {cam.city}</span>}
                  {cam.organization_name && <span>Organization: {cam.organization_name}</span>}
                  <span>Zone: {cam.zone}</span>
                  <span className={`map-popup__status map-popup__status--${cam.status}`}>
                    ● {cam.status?.charAt(0).toUpperCase() + cam.status?.slice(1)}
                  </span>
                  {cam.uptime !== undefined && <span>Uptime: {cam.uptime}%</span>}
                  {cam.detections_today !== undefined && (
                    <span className="map-popup__detections">
                      Detections today: <strong>{cam.detections_today}</strong>
                    </span>
                  )}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}

        {/* Trajectory polyline — connecting cameras in order */}
        {trajectoryCoords.length > 1 && (
          <Polyline
            positions={trajectoryCoords}
            pathOptions={{
              color: '#00f0ff',
              weight: 3,
              opacity: 0.85,
              dashArray: '8, 6',
            }}
          />
        )}

        {/* Trajectory sighting markers — numbered */}
        {trajectory && trajectory.map((point, i) => {
          const lat = point.lat || point.camera?.lat;
          const lng = point.lng || point.camera?.lng;
          if (!lat || !lng) return null;
          const name = point.camera_name || point.camera?.name || 'Unknown';
          const city = point.camera_city || point.camera?.city || '';
          const zone = point.zone || point.camera?.zone || '';
          const confidence = point.confidence;
          const organizationName = point.organization_name || point.camera?.organization_name;

          return (
            <Marker
              key={`traj-${i}`}
              position={[lat, lng]}
              icon={createNumberedIcon(i === 0 ? 'green' : i === trajectory.length - 1 && trajectory.length > 1 ? 'red' : 'cyan', i + 1, showEntryExit && i === 0 ? 'IN' : showEntryExit && i === trajectory.length - 1 && trajectory.length > 1 ? 'OUT' : '')}
            >
              <Popup>
                <div className="map-popup">
                    <strong>{showEntryExit && i === 0 ? 'Entry point' : showEntryExit && i === trajectory.length - 1 && trajectory.length > 1 ? 'Exit point' : `Sighting #${i + 1}`}</strong>
                  <div className="map-popup__info">
                    <span>{name}</span>
                    {city && <span>City: {city}</span>}
                    {organizationName && <span>Organization: {organizationName}</span>}
                    {zone && <span>Zone: {zone}</span>}
                    <span>{new Date(point.timestamp).toLocaleString()}</span>
                    {confidence && <span>Confidence: {(confidence <= 1 ? confidence * 100 : confidence).toFixed(1)}%</span>}
                    {point.speed && <span>Speed: {point.speed} km/h</span>}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
