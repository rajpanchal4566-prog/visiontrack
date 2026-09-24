import { useEffect, useState } from 'react';
import { AlertTriangle, Camera, Clock, Download, Gauge, ImageOff, MapPin, Palette, Tag, X } from 'lucide-react';
import { detectionsApi } from '../services/api';
import { API_ORIGIN } from '../services/config';
import './DetectionDetailModal.css';

function imageUrl(imagePath) {
  if (!imagePath) return null;
  if (/^[a-z0-9+/\s]+=*$/i.test(imagePath) && imagePath.length > 100) {
    return `data:image/jpeg;base64,${imagePath.replace(/\s/g, '')}`;
  }
  return /^(https?:\/\/|data:image\/)/i.test(imagePath) ? imagePath : `${API_ORIGIN}${imagePath}`;
}

function confidencePercent(value) {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 'Not available';
  return `${(confidence <= 1 ? confidence * 100 : confidence).toFixed(1)}%`;
}

function valueOrUnavailable(value) {
  return value === null || value === undefined || value === '' ? 'Not available' : value;
}

export default function DetectionDetailModal({ detectionId, onClose }) {
  const [detection, setDetection] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError('');
    detectionsApi.getById(detectionId)
      .then(result => mounted && setDetection(result))
      .catch(err => mounted && setError(err.message || 'Unable to load detection details.'))
      .finally(() => mounted && setLoading(false));
    return () => { mounted = false; };
  }, [detectionId]);

  useEffect(() => {
    const closeOnEscape = event => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  async function downloadReport() {
    setDownloading(true);
    try {
      const blob = await detectionsApi.getReport(detectionId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `detection-${detectionId}-report.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Unable to generate report.');
    } finally {
      setDownloading(false);
    }
  }

  const image = imageUrl(detection?.image_path);
  const cameraName = detection?.camera_name || detection?.camera?.name || detection?.camera_id;
  const location = detection?.camera_zone || detection?.camera?.zone || detection?.location_id || 'Location unavailable';
  const city = detection?.camera_city || detection?.camera?.city || 'Unknown city';
  const sourceLocation = [cameraName, location, city].filter(Boolean).join(' • ');

  return (
    <div className="detection-modal" role="presentation" onClick={onClose}>
      <section className="detection-modal__dialog" role="dialog" aria-modal="true" aria-labelledby="detection-modal-title" onClick={event => event.stopPropagation()}>
        <header className="detection-modal__header">
          <div>
            <span className="detection-modal__eyebrow">Detection details</span>
            <h2 id="detection-modal-title">{detection?.plate || 'Loading detection'}</h2>
          </div>
          <button type="button" className="detection-modal__close" aria-label="Close detection details" onClick={onClose}><X size={20} /></button>
        </header>

        {loading && <div className="detection-modal__state">Loading detection details...</div>}
        {!loading && error && <div className="detection-modal__state detection-modal__state--error">{error}</div>}
        {!loading && !error && detection && (
          <>
            <div className="detection-modal__snapshot">
              {image ? <img src={image} alt={`Detection snapshot for ${detection.plate}`} /> : <div className="detection-modal__placeholder"><ImageOff size={34} /><span>No snapshot available</span></div>}
            </div>
            <div className="detection-modal__body">
              <div className="detection-modal__location">
                <Camera size={16} /><strong>{valueOrUnavailable(cameraName)}</strong>
                <span>{valueOrUnavailable(location)}</span>
                <span>{valueOrUnavailable(city)}</span>
              </div>
              <div className="detection-modal__location" style={{ marginTop: '8px' }}>
                <MapPin size={15} />
                <strong>Source</strong>
                <span>{valueOrUnavailable(sourceLocation)}</span>
              </div>
              {detection.flagged ? <div className="detection-modal__flag"><AlertTriangle size={17} /><strong>{detection.violation_type || 'Flagged detection'}</strong><span>{detection.flag_source || 'Flag source unavailable'}</span></div> : null}
              <div className="detection-modal__grid">
                <div><Clock size={15} /><label>Timestamp</label><strong>{new Date(detection.timestamp).toLocaleString()}</strong></div>
                <div><Gauge size={15} /><label>Confidence</label><strong>{confidencePercent(detection.confidence)}</strong></div>
                <div><Tag size={15} /><label>Vehicle type</label><strong>{valueOrUnavailable(detection.vehicle_type)}</strong></div>
                <div><Tag size={15} /><label>Vendor / Input</label><strong>{valueOrUnavailable(detection.vendor_vehicle_type)}</strong></div>
                <div><Tag size={15} /><label>AI Detected</label><strong>{valueOrUnavailable(detection.detected_vehicle_type)}</strong></div>
                <div><Tag size={15} /><label>Verification</label><strong>{detection.vehicle_type_match === null || detection.vehicle_type_match === undefined ? 'Not available' : detection.vehicle_type_match ? 'MATCH' : 'MISMATCH'}</strong></div>
                <div><Palette size={15} /><label>Vehicle color</label><strong>{valueOrUnavailable(detection.vehicle_color)}</strong></div>
                <div><Gauge size={15} /><label>Speed</label><strong>{detection.speed == null ? 'Not available' : `${detection.speed} km/h`}</strong></div>
                <div><MapPin size={15} /><label>Organization</label><strong>{valueOrUnavailable(detection.organization_name)}</strong></div>
              </div>
              <div className="detection-modal__actions">
                <button type="button" className="btn btn-primary" onClick={downloadReport} disabled={downloading}><Download size={15} />{downloading ? 'Generating...' : 'Generate Report'}</button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
