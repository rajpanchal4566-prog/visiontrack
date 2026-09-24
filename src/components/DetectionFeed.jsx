import { useEffect, useState } from 'react';
import { Camera, Clock, FileText, Gauge, ImageOff } from 'lucide-react';
import DetectionDetailModal from './DetectionDetailModal';
import './DetectionFeed.css';

function getImageSrc(value) {
  if (!value) return null;
  if (/^[a-z0-9+/\s]+=*$/i.test(value) && value.length > 100) {
    return `data:image/jpeg;base64,${value.replace(/\s/g, '')}`;
  }
  if (/^(data:|https?:\/\/)/i.test(value)) return value;
  return `http://${window.location.hostname}:3001/${String(value).replace(/^\//, '')}`;
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getConfidence(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return null;
  return confidence <= 1 ? confidence * 100 : confidence;
}

export default function DetectionFeed({ detections: suppliedDetections, maxItems = 15 }) {
  const [detections, setDetections] = useState(() => suppliedDetections || []);
  const [selectedDetectionId, setSelectedDetectionId] = useState(null);

  useEffect(() => {
    if (suppliedDetections) setDetections(suppliedDetections);
  }, [suppliedDetections]);

  return (
    <div className="detection-feed">
      <div className="detection-feed__header">
        <div className="detection-feed__live-dot"></div>
        <span className="detection-feed__title">Live Detections</span>
      </div>
      <div className="detection-feed__list">
        {detections.map((det, i) => {
          const cameraLabel = det.camera?.name || det.camera_name || 'Unknown camera';
          const locationLabel = det.camera?.zone || det.camera_zone || det.location_id || det.camera?.city || 'Location unavailable';
          const sourceLabel = [cameraLabel, locationLabel, det.camera?.city || det.camera_city].filter(Boolean).join(' • ');

          return (
          <article key={`${det.id}-${i}`} className={`detection-item ${i === 0 ? 'detection-item--new' : ''}`} onClick={() => det.id && setSelectedDetectionId(det.id)}>
            <div className="detection-item__content">
              <div className="detection-item__camera">
                <Camera size={12} />
                <span>{cameraLabel}</span>
                {(det.camera?.id || det.camera_id) && <span className="detection-item__camera-id">{det.camera?.id || det.camera_id}</span>}
              </div>
              <div className="detection-item__camera" style={{ marginTop: '4px', opacity: 0.8 }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{sourceLabel}</span>
              </div>
              <div className="detection-item__plate">
                <span className="detection-item__plate-text mono">{det.plate || det.license_plate || 'UNKNOWN'}</span>
                <span className="detection-item__confidence">
                  <Gauge size={12} />
                  {getConfidence(det.confidence)?.toFixed(1) ?? '--'}%
                </span>
                {getConfidence(det.confidence) >= 95 && <span className="badge badge-success">HIGH</span>}
              </div>
              <div className="detection-item__vehicle">
                {[det.vehicle_color || det.vehicleColor, det.vehicle_type || det.vehicleType, det.vehicle_make || det.vehicleMake]
                  .filter(Boolean)
                  .join(' · ') || 'Vehicle details unavailable'}
              </div>
              <div className="detection-item__time">
                <Clock size={12} />
                {formatTime(det.timestamp)}
              </div>
            </div>
            <div className="detection-item__media">
              {getImageSrc(det.image_path || det.image_url) ? (
                <img
                  className="detection-item__thumbnail"
                  src={getImageSrc(det.image_path || det.image_url)}
                  alt={`Capture for ${det.plate || det.license_plate || 'detection'}`}
                  onClick={() => det.id && setSelectedDetectionId(det.id)}
                />
              ) : (
                <div className="detection-item__placeholder" aria-label="No detection image">
                  <ImageOff size={20} />
                </div>
              )}
              <div className="detection-item__actions">
                <button
                  type="button"
                  className="detection-item__action"
                  onClick={(event) => { event.stopPropagation(); det.id && setSelectedDetectionId(det.id); }}
                >
                  <span>View</span>
                </button>
                <button
                  type="button"
                  className="detection-item__action"
                  onClick={(event) => { event.stopPropagation(); det.id && setSelectedDetectionId(det.id); }}
                >
                  <FileText size={12} />
                  <span>Generate Report</span>
                </button>
              </div>
            </div>
          </article>
          );
        })}
      </div>
      {selectedDetectionId && <DetectionDetailModal detectionId={selectedDetectionId} onClose={() => setSelectedDetectionId(null)} />}
    </div>
  );
}
